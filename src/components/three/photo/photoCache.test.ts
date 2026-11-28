import { afterEach, describe, expect, it, vi } from "vitest";
import { photoCacheEnabled, photoCacheKey } from "./photoService";
import { DEFAULT_PHOTO_SETTINGS } from "./photoSettings";
import { RENDERING_FINGERPRINT } from "./renderingFingerprint";

describe("photo cache identity and development bypass", () => {
  const store = new Map<string, string>();
  const localStorage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k) };
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    store.clear();
  });

  it("the key carries the rendering fingerprint (lighting, exterior, reflections, presets)", () => {
    expect(RENDERING_FINGERPRINT).toMatch(/^[0-9a-z]+$/);
    expect(photoCacheKey("{}", DEFAULT_PHOTO_SETTINGS, "front-right")).toContain(`#${RENDERING_FINGERPRINT}#`);
  });

  it("production reuses renderings; next dev never does; the localStorage switch turns it off anywhere", () => {
    vi.stubGlobal("window", { localStorage });
    vi.stubEnv("NODE_ENV", "production");
    expect(photoCacheEnabled()).toBe(true);
    localStorage.setItem("multi3d.photo.cache", "off");
    expect(photoCacheEnabled()).toBe(false);
    localStorage.removeItem("multi3d.photo.cache");
    vi.stubEnv("NODE_ENV", "development");
    expect(photoCacheEnabled()).toBe(false);
  });
});
