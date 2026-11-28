import { NoColorSpace, SRGBColorSpace } from "three";
import { describe, expect, it, vi } from "vitest";
import type { TextureRequest } from "./runtimeContracts";
import { createSourceCache, createTextureResources, estimateTextureBytes, TextureScopeDisposedError, type ImageSource } from "./textureResources";

function request(overrides: Partial<TextureRequest> = {}): TextureRequest {
  return {
    assetId: "decor:K003-PW.jpg",
    url: "/textures/decors/K003-PW.jpg",
    semantic: "baseColor",
    colorSpace: "srgb",
    wrap: "repeat",
    repeat: [1 / 0.6, 1 / 0.6],
    offset: [0, 0],
    rotationRad: 0,
    flipY: true,
    anisotropy: 4,
    mipmaps: true,
    width: 256,
    height: 256,
    ...overrides,
  };
}

function deferredLoader() {
  const pending = new Map<string, { resolve: (v: ImageSource) => void; reject: (e: Error) => void }>();
  const load = vi.fn(
    (url: string) =>
      new Promise<ImageSource>((resolve, reject) => {
        pending.set(url, { resolve, reject });
      }),
  );
  return { load, pending };
}

describe("texture resources", () => {
  it("coalesces loads of one URL and returns the same texture object for equal requests in a scope", async () => {
    const { load, pending } = deferredLoader();
    const scope = createTextureResources({ sources: createSourceCache(load) });
    const a = scope.acquire(request());
    const b = scope.acquire(request());
    expect(load).toHaveBeenCalledTimes(1);
    pending.get("/textures/decors/K003-PW.jpg")!.resolve({ width: 256, height: 256 });
    const [ta, tb] = await Promise.all([a.ready, b.ready]);
    expect(ta).toBe(tb);
    expect(ta.colorSpace).toBe(SRGBColorSpace);
    expect(ta.repeat.toArray()).toEqual([1 / 0.6, 1 / 0.6]);
    expect(ta.anisotropy).toBe(4);
    expect(scope.stats()).toMatchObject({ textures: 1, activeLeases: 2 });
  });

  it("keeps colour and data interpretations and different transforms apart (distinct identities)", async () => {
    const scope = createTextureResources({ sources: createSourceCache(async () => ({ width: 8, height: 8 })) });
    const color = await scope.acquire(request()).ready;
    const data = await scope.acquire(request({ colorSpace: "data", semantic: "roughness" })).ready;
    const scaled = await scope.acquire(request({ repeat: [1, 1] })).ready;
    expect(new Set([color, data, scaled]).size).toBe(3);
    expect(data.colorSpace).toBe(NoColorSpace);
  });

  it("isolates scopes: the live canvas and a photo job never share texture objects, only decoded images", async () => {
    const load = vi.fn(async () => ({ width: 8, height: 8 }));
    const sources = createSourceCache(load);
    const live = createTextureResources({ sources });
    const photo = createTextureResources({ sources });
    const [a, b] = await Promise.all([live.acquire(request()).ready, photo.acquire(request()).ready]);
    expect(a).not.toBe(b);
    expect(a.image).toBe(b.image);
    expect(load).toHaveBeenCalledTimes(1);
    photo.dispose();
    expect(live.stats().textures).toBe(1);
  });

  it("releases are idempotent; idle textures stay for re-selection until the idle budget or a trim", async () => {
    let t = 0;
    const scope = createTextureResources({ sources: createSourceCache(async () => ({ width: 256, height: 256 })), idleBudgetBytes: estimateTextureBytes(256, 256, true) * 1.5, now: () => ++t });
    const first = scope.acquire(request({ url: "/a.jpg" }));
    await first.ready;
    first.release();
    first.release();
    expect(scope.stats()).toMatchObject({ textures: 1, activeLeases: 0, idleTextures: 1 });
    // A second idle texture exceeds the budget: the oldest idle one is evicted.
    const second = scope.acquire(request({ url: "/b.jpg" }));
    await second.ready;
    second.release();
    expect(scope.stats()).toMatchObject({ textures: 1, idleTextures: 1 });
    // Active leases are never evicted by a trim.
    const active = scope.acquire(request({ url: "/c.jpg" }));
    await active.ready;
    scope.trim(0);
    expect(scope.stats()).toMatchObject({ textures: 1, activeLeases: 1, idleTextures: 0 });
  });

  it("stays stable over 20 selection switches and repeated photo/cancel cycles (no idle growth)", async () => {
    const sources = createSourceCache(async () => ({ width: 256, height: 256 }), 4);
    const live = createTextureResources({ sources, idleBudgetBytes: 4 * estimateTextureBytes(256, 256, true) });
    let lease = live.acquire(request({ url: "/d0.jpg" }));
    for (let i = 1; i <= 20; i++) {
      const next = live.acquire(request({ url: `/d${i % 7}.jpg` }));
      await next.ready;
      lease.release();
      lease = next;
      const photo = createTextureResources({ sources });
      await photo.acquire(request({ url: `/d${i % 7}.jpg`, anisotropy: 8 })).ready;
      photo.dispose(); // completion, cancel or error all end here
    }
    const stats = live.stats();
    expect(stats.activeLeases).toBe(1);
    expect(stats.textures).toBeLessThanOrEqual(5);
    expect(sources.size).toBeLessThanOrEqual(5 + 4);
  });

  it("forgets a failed load (no substitute), so a later request retries", async () => {
    let fail = true;
    const scope = createTextureResources({
      sources: createSourceCache(async () => {
        if (fail) throw new Error("404");
        return { width: 8, height: 8 };
      }),
    });
    await expect(scope.acquire(request()).ready).rejects.toThrow("404");
    expect(scope.stats().textures).toBe(0);
    fail = false;
    await expect(scope.acquire(request()).ready).resolves.toBeDefined();
  });

  it("ignores a late completion after the scope was disposed (cancel / unmount race)", async () => {
    const { load, pending } = deferredLoader();
    const scope = createTextureResources({ sources: createSourceCache(load) });
    const lease = scope.acquire(request());
    scope.dispose();
    pending.get("/textures/decors/K003-PW.jpg")!.resolve({ width: 256, height: 256 });
    // Nothing is applied after the scope is gone: the lease reports the disposal, not a texture.
    await expect(lease.ready).rejects.toBeInstanceOf(TextureScopeDisposedError);
    expect(scope.stats().textures).toBe(0);
  });

  it("accounts residency as RGBA8 with a mip chain", () => {
    expect(estimateTextureBytes(1024, 1024, true)).toBe(Math.round(1024 * 1024 * 4 * (4 / 3)));
    expect(estimateTextureBytes(406, 370, false)).toBe(406 * 370 * 4);
  });
});
