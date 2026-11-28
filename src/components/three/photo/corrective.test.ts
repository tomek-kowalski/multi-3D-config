import { BoxGeometry, BufferAttribute, BufferGeometry, DataTexture, DoubleSide, Mesh, MeshStandardMaterial, RGBAFormat, Scene, Texture } from "three";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { addModule } from "@/domain/arrangement/operations";
import type { Arrangement } from "@/domain/arrangement/types";
import { materialRegistry } from "@/domain/materials";
import { bedDecorSelection, cabinetFinishSelection } from "@/domain/materials/bindings";
import type { MaterialQualityProfile, MaterialSelection } from "@/domain/materials/contracts";
import { DEFAULT_ROOM } from "@/domain/room/defaults";
import { createPbrMaterial } from "../materials/createPbrMaterial";
import { PHOTO_CAPABILITIES, PHOTO_PROFILE, VIEWPORT_CONSTRAINED } from "../materials/materialQuality";
import { attachMaterialBinding } from "../materials/materialSlots";
import { createSourceCache, createTextureResources, estimateTextureBytes, type ImageLoad } from "../materials/textureResources";
import type { TextureResources } from "../materials/runtimeContracts";
import { appearanceNote } from "./PhotoRenderer";
import { renderPhotoViews, TraceBudgetError, type PhotoBackend, type PhotoEngineDeps } from "./photoEngine";
import { runPhotoJob, type PhotoJobDeps } from "./photoJob";
import { takeSnapshot } from "./photoScene";
import { clearPhotoCache, renderingMetadata } from "./photoService";
import { DEFAULT_PHOTO_SETTINGS } from "./photoSettings";
import { photoTag } from "./tags";

const VIEWPORT = { ...PHOTO_CAPABILITIES, mode: "viewport" as const, uvChannels: 4, supportsTransmission: false };
const METRES = { kind: "authored-uv0", uvUnits: "metres" } as const;
const imageLoad: ImageLoad = async () => ({ width: 406, height: 370 });

function build(selection: MaterialSelection, textures: TextureResources, options: { quality?: MaterialQualityProfile; authored?: MeshStandardMaterial; maxTextureSize?: number; side?: "front" | "double" | "authored"; uvChannels?: number } = {}) {
  return createPbrMaterial({
    resolved: materialRegistry.resolve(selection),
    side: options.side ?? "front",
    mapping: METRES,
    capabilities: { ...VIEWPORT, maxTextureSize: options.maxTextureSize ?? 4096, uvChannels: options.uvChannels ?? 4 },
    quality: options.quality ?? VIEWPORT_CONSTRAINED,
    textures,
    registry: materialRegistry,
    authored: options.authored ?? null,
  });
}

describe("GPU budget enforcement (M-08 / D-3)", () => {
  const hd = estimateTextureBytes(406, 370, true);
  const sd = estimateTextureBytes(256, 256, true);

  it("uses the same decor's standard tier when the enhanced one does not fit the remaining budget, and reports it", async () => {
    const urls: string[] = [];
    const textures = createTextureResources({ sources: createSourceCache(async (u) => (urls.push(u), { width: 256, height: 256 })), budget: { maxResidentBytes: hd - 1, maxIdleBytes: 0 } });
    const m = build(bedDecorSelection(4000, "standard", "K003-PW"), textures);
    await m.ready;
    expect(urls).toEqual(["/textures/decors/K003-PW.jpg"]);
    expect(m.issues).toContain("budget-reduced");
    expect(m.material.map).not.toBeNull(); // the authorized colour image is still shown
  });

  it("never drops or replaces an authorized base colour to meet a budget: it loads it and reports the excess", async () => {
    const textures = createTextureResources({ sources: createSourceCache(imageLoad), budget: { maxResidentBytes: sd - 1, maxIdleBytes: 0 } });
    const m = build(bedDecorSelection(4000, "standard", "K003-PW"), textures);
    await m.ready;
    expect(m.material.map?.name).toBe("decor:K003-PW.jpg");
    expect(m.issues).toEqual(expect.arrayContaining(["budget-reduced", "budget-exceeded"]));
  });

  it("respects the device's MAX_TEXTURE_SIZE when choosing a tier (deterministically)", async () => {
    const urls: string[] = [];
    const textures = createTextureResources({ sources: createSourceCache(async (u) => (urls.push(u), { width: 256, height: 256 })) });
    await build(bedDecorSelection(4000, "standard", "K003-PW"), textures, { maxTextureSize: 300 }).ready;
    expect(urls).toEqual(["/textures/decors/K003-PW.jpg"]);
  });

  it("evicts idle textures before active ones to make room; active + adopted residency is accounted", async () => {
    let t = 0;
    const textures = createTextureResources({ sources: createSourceCache(imageLoad), budget: { maxResidentBytes: hd * 2, maxIdleBytes: hd * 4 }, now: () => ++t });
    const req = (url: string) => ({ assetId: url, url, semantic: "baseColor" as const, colorSpace: "srgb" as const, wrap: "repeat" as const, repeat: [1, 1] as const, offset: [0, 0] as const, rotationRad: 0, flipY: true, anisotropy: 1, mipmaps: true, width: 406, height: 370 });
    const a = textures.acquire(req("/a"));
    await a.ready;
    a.release(); // idle
    const b = textures.acquire(req("/b"));
    const c = textures.acquire(req("/c")); // needs room: idle /a is evicted, active /b is not
    await Promise.all([b.ready, c.ready]);
    expect(textures.stats()).toMatchObject({ textures: 2, idleTextures: 0, activeBytes: hd * 2 });
    const adopted = textures.adopt(Object.assign(new Texture({ width: 64, height: 64 }), {}));
    expect(textures.stats()).toMatchObject({ adoptedTextures: 1, adoptedBytes: estimateTextureBytes(64, 64, true) });
    expect(textures.canAfford(1)).toBe(false);
    adopted.release();
    expect(textures.stats().adoptedTextures).toBe(0);
  });
});

describe("authored material isolation (M-05)", () => {
  function authored() {
    const map = new DataTexture(new Uint8Array(16), 2, 2, RGBAFormat);
    map.repeat.set(2, 3);
    map.offset.set(0.1, 0.2);
    map.channel = 0;
    return new MeshStandardMaterial({ map, side: DoubleSide, roughness: 0.7 });
  }

  it("viewport and photo get their own texture objects sharing the decoded pixels; mutations never cross", () => {
    const source = authored();
    const live = build({ kind: "authored" }, createTextureResources(), { authored: source, side: "authored" }).material;
    const photo = build({ kind: "authored" }, createTextureResources(), { authored: source, side: "authored", quality: PHOTO_PROFILE }).material;
    expect(new Set([source.map, live.map, photo.map]).size).toBe(3);
    expect(live.map!.source).toBe(source.map!.source);
    expect(photo.map!.source).toBe(source.map!.source);
    // Transform and sampler preserved…
    expect(live.map!.repeat.toArray()).toEqual([2, 3]);
    expect(live.map!.offset.toArray()).toEqual([0.1, 0.2]);
    // …and independent: a tracer upload that rewrites the photo texture's matrix leaves the others alone.
    photo.map!.matrixAutoUpdate = false;
    photo.map!.matrix.identity();
    photo.map!.repeat.set(1, 1);
    expect(live.map!.repeat.toArray()).toEqual([2, 3]);
    expect(source.map!.repeat.toArray()).toEqual([2, 3]);
  });

  it("keeps the authored side for side: 'authored', applies an explicit side otherwise; reports unsupported UV channels", () => {
    const source = authored();
    expect(build({ kind: "authored" }, createTextureResources(), { authored: source, side: "authored" }).material.side).toBe(DoubleSide);
    expect(build({ kind: "authored" }, createTextureResources(), { authored: source, side: "front" }).material.side).toBe(0);
    source.map!.channel = 1;
    expect(build({ kind: "authored" }, createTextureResources(), { authored: source, uvChannels: 1 }).issues).toContain("unsupported-uv-channel");
    expect(build({ kind: "authored" }, createTextureResources(), { authored: source, uvChannels: 4 }).issues).not.toContain("unsupported-uv-channel");
  });

  it("releases adopted copies with the material; the model's own textures stay intact", () => {
    const source = authored();
    const textures = createTextureResources();
    const m = build({ kind: "authored" }, textures, { authored: source });
    expect(textures.stats().adoptedTextures).toBe(1);
    const disposed = vi.fn();
    m.material.map!.addEventListener("dispose", disposed);
    const sourceDisposed = vi.fn();
    source.map!.addEventListener("dispose", sourceDisposed);
    m.dispose();
    expect(textures.stats().adoptedTextures).toBe(0);
    expect(disposed).toHaveBeenCalledTimes(1);
    expect(sourceDisposed).not.toHaveBeenCalled();
  });
});

describe("asynchronous lifecycle (M-07)", () => {
  it("acquires nothing after dispose, even when the enhanced image fails afterwards", async () => {
    let fail: (e: Error) => void = () => {};
    const load = vi.fn((url: string) => (url.includes("/hd/") ? new Promise<never>((_, reject) => (fail = reject)) : Promise.resolve({ width: 8, height: 8 })));
    const textures = createTextureResources({ sources: createSourceCache(load) });
    const m = build(bedDecorSelection(4000, "standard", "K003-PW"), textures);
    m.dispose();
    fail(new Error("404"));
    await m.ready;
    expect(load).toHaveBeenCalledTimes(1); // no standard-tier fallback was started
    expect(textures.stats()).toMatchObject({ textures: 0, activeLeases: 0 });
    expect(m.issues).not.toContain("texture-load-failed");
  });

  it("disposing one consumer never cancels a shared image load another consumer still needs", async () => {
    let resolve: (v: { width: number; height: number }) => void = () => {};
    const load = vi.fn(() => new Promise<{ width: number; height: number }>((r) => (resolve = r)));
    const sources = createSourceCache(load);
    const viewport = createTextureResources({ sources });
    const photo = createTextureResources({ sources });
    const live = build(bedDecorSelection(4000, "standard", "K003-PW"), viewport);
    const snap = build(bedDecorSelection(4000, "standard", "K003-PW"), photo, { quality: PHOTO_PROFILE });
    snap.dispose();
    photo.dispose();
    resolve({ width: 406, height: 370 });
    await live.ready;
    expect(load).toHaveBeenCalledTimes(1);
    expect(live.material.map?.image).toEqual({ width: 406, height: 370 });
  });
});

describe("photo geometry capture (M-06 / D-6)", () => {
  const scene = (...meshes: Mesh[]) => {
    const s = new Scene();
    meshes.forEach((m) => {
      m.userData = photoTag("board");
      s.add(m);
    });
    return s;
  };

  it("respects draw ranges, skips invisible materials, and reports instead of substituting material 0", () => {
    const ranged = new Mesh(new BoxGeometry(), new MeshStandardMaterial());
    ranged.geometry.setDrawRange(0, 12); // two faces
    ranged.name = "ranged";
    const hiddenGroup = new Mesh(new BoxGeometry(), [0, 1, 2, 3, 4, 5].map((i) => new MeshStandardMaterial({ visible: i !== 2 })));
    hiddenGroup.name = "hidden";
    const missing = new Mesh(new BoxGeometry(), [new MeshStandardMaterial(), new MeshStandardMaterial()]);
    missing.name = "missing";
    const noGroups = new Mesh(new BufferGeometry().setAttribute("position", new BufferAttribute(new Float32Array(9), 3)), [new MeshStandardMaterial()]);
    noGroups.name = "nogroups";
    const invisible = new Mesh(new BoxGeometry(), new MeshStandardMaterial({ visible: false }));
    const snapshot = takeSnapshot(scene(ranged, hiddenGroup, missing, noGroups, invisible));
    const byName = (prefix: string) => snapshot.items.filter((i) => i.name.startsWith(prefix));
    expect(byName("ranged").map((i) => i.geometry.index!.count)).toEqual([12]);
    expect(byName("hidden").map((i) => i.group?.materialIndex)).toEqual([0, 1, 3, 4, 5]);
    expect(byName("missing").map((i) => i.group?.materialIndex)).toEqual([0, 1]); // groups 2–5 have no material
    expect(byName("nogroups")).toEqual([]);
    expect(snapshot.items).toHaveLength(1 + 5 + 2);
    const issues = snapshot.diagnostics().geometry ?? [];
    expect(issues.filter((i) => i.startsWith("missing:"))).toHaveLength(4);
    expect(issues.some((i) => i.startsWith("nogroups:"))).toBe(true);
    snapshot.dispose();
  });

  it("captures non-indexed multi-material geometry per group, with normals and UVs, and bounds of drawn vertices only", () => {
    const g = new BoxGeometry(2, 2, 2).toNonIndexed();
    g.clearGroups();
    g.addGroup(0, 6, 0); // one face (+x)
    g.addGroup(6, 6, 1); // one face (-x)
    const mesh = new Mesh(g, [new MeshStandardMaterial({ color: "#ff0000" }), new MeshStandardMaterial({ color: "#00ff00" })]);
    mesh.position.set(5, 0, 0);
    const snapshot = takeSnapshot(scene(mesh));
    expect(snapshot.items).toHaveLength(2);
    for (const item of snapshot.items) {
      expect(item.geometry.getAttribute("normal").count).toBe(6);
      expect(item.geometry.getAttribute("uv").count).toBe(6);
      expect(item.matrix.elements[12]).toBe(5); // transform preserved
    }
    // Only the ±x faces are drawn: bounds span x 4…6 (the whole box would too, but y/z are the faces' own).
    expect(snapshot.bounds.min.x).toBeCloseTo(4);
    expect(snapshot.bounds.max.x).toBeCloseTo(6);
    snapshot.dispose();
  });

  it("bakes active morph targets as drawn (positions and morph normals)", () => {
    const g = new BoxGeometry();
    const target = g.getAttribute("position").clone();
    for (let i = 0; i < target.count; i++) target.setY(i, target.getY(i) * 3);
    g.morphAttributes.position = [target];
    const mesh = new Mesh(g, new MeshStandardMaterial());
    mesh.updateMorphTargets();
    mesh.morphTargetInfluences![0] = 1;
    const snapshot = takeSnapshot(scene(mesh));
    expect(snapshot.items[0].geometry.morphAttributes).toEqual({});
    expect(snapshot.bounds.max.y).toBeCloseTo(1.5);
    snapshot.dispose();
  });
});

describe("backend isolation and fallback (M-04 / D-7)", () => {
  it("falls back to the fast renderer on a freshly built view after a texture-budget failure, and reports it", async () => {
    const built: Scene[] = [];
    const disposedViews: Scene[] = [];
    const backend = (mode: "pathtraced" | "raster"): PhotoBackend => {
      let samples = 0;
      return {
        mode,
        async setScene() {
          if (mode === "pathtraced") throw new TraceBudgetError(40, 16);
          samples = 0;
        },
        step: () => (samples += 200),
        output: async () => new Blob([mode]),
        dispose() {},
      };
    };
    const deps: PhotoEngineDeps = {
      choice: { mode: "pathtraced", reason: null, rasterEligible: true },
      createBackend: backend,
      buildView: () => {
        const scene = new Scene();
        built.push(scene);
        return { scene, camera: undefined as never, dispose: () => disposedViews.push(scene) };
      },
      now: (() => {
        let t = 0;
        return () => (t += 10);
      })(),
      nextFrame: async () => {},
    };
    const [photo] = await renderPhotoViews([{ id: "front-right", camera: { position: [0, 0, 0], target: [0, 0, 0], fov: 40 }, hiddenWalls: [] } as never], { ...DEFAULT_PHOTO_SETTINGS, quality: "standard" }, deps);
    expect(photo).toMatchObject({ mode: "raster", fallbackReason: "texture_budget" });
    expect(built).toHaveLength(2); // the raster fallback never sees the tracer's view
    expect(disposedViews).toEqual(built); // both views freed
  });
});

describe("cancellation and diagnostics propagation (M-07 / D-5)", () => {
  beforeEach(() => clearPhotoCache());

  function jobDeps(selection: MaterialSelection, overrides: Partial<PhotoJobDeps> = {}): PhotoJobDeps {
    const live = new Scene();
    const mesh = new Mesh(new BoxGeometry(), new MeshStandardMaterial());
    mesh.userData = photoTag("board");
    attachMaterialBinding(mesh, { binding: { slots: [{ slotId: "s", selection, side: "front", mapping: METRES }], groups: [] }, authored: {} });
    live.add(mesh);
    let a: Arrangement = { room: DEFAULT_ROOM, modules: [] };
    const r = addModule(a, "cabinet");
    if (r.ok) a = r.value.arrangement;
    let t = 0;
    return {
      capture: () => ({ arrangement: a, snapshot: takeSnapshot(live, { textures: createTextureResources({ sources: createSourceCache(imageLoad) }) }) }),
      choice: () => ({ mode: "pathtraced", reason: null, rasterEligible: true }),
      autoQuality: () => "fast",
      loadEnvironment: async () => new Texture(),
      prepareMaterials: (s) => s.ready,
      createBackend: (mode) => {
        let samples = 0;
        return { mode, async setScene() {}, step: () => (samples += 200), output: async () => new Blob(["img"]), dispose() {} };
      },
      now: () => (t += 10),
      nextFrame: async () => {},
      sleep: async () => {},
      ...overrides,
    };
  }

  it("a request cancelled while materials prepare stops at once and caches nothing", async () => {
    const controller = new AbortController();
    const deps = jobDeps(cabinetFinishSelection("walnut"), { prepareMaterials: () => new Promise(() => {}) });
    const pending = runPhotoJob({ count: 1, signal: controller.signal }, deps);
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: "cancelled" });
    // Nothing was cached: a new request renders (and its capture runs again).
    const capture = vi.fn(jobDeps(cabinetFinishSelection("walnut")).capture);
    await runPhotoJob({ count: 1 }, { ...jobDeps(cabinetFinishSelection("walnut")), capture });
    expect(capture).toHaveBeenCalled();
  });

  it("a request cancelled during annotation neither publishes nor caches", async () => {
    const controller = new AbortController();
    const annotate = vi.fn(async (image: Blob) => {
      controller.abort();
      return image;
    });
    const deps = jobDeps(bedDecorSelection(4000, "standard", "8361-SN"), { annotate });
    await expect(runPhotoJob({ count: 1, signal: controller.signal }, deps)).rejects.toMatchObject({ code: "cancelled" });
    const createBackend = vi.fn(deps.createBackend);
    await runPhotoJob({ count: 1 }, { ...deps, annotate: async (b) => b, createBackend });
    expect(createBackend).toHaveBeenCalled(); // rendered again: the cancelled result was never cached
  });

  it("quotation metadata carries the appearance diagnostics; the note is translated per return", async () => {
    const deps = jobDeps(bedDecorSelection(4000, "standard", "8361-SN"), { annotate: async (b, a) => new Blob([await b.text(), "|", appearanceNote(a, "en")]) });
    const [photo] = await runPhotoJob({ count: 1 }, deps);
    expect(renderingMetadata(photo).appearance).toEqual({ unavailable: ["8361 SN"], failed: [] });
    expect(await photo.blob.text()).toContain("8361 SN");
    const [polish] = await runPhotoJob({ count: 1 }, { ...deps, annotate: async (b, a) => new Blob([await b.text(), "|", appearanceNote(a, "pl")]) });
    expect(await polish.blob.text()).toContain("Wizualizacja orientacyjna");
    expect(appearanceNote({ unavailable: [], failed: ["K003 PW"] }, "en")).toContain("could not be loaded");
    expect(renderingMetadata({ ...photo, appearance: { unavailable: [], failed: [] } }).appearance).toBeUndefined();
  });
});

