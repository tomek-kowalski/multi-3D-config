import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DataTexture, DataUtils, EquirectangularReflectionMapping, FloatType, HalfFloatType, LinearMipmapLinearFilter, LinearFilter, LinearSRGBColorSpace, RGBAFormat } from "three";
import { describe, expect, it } from "vitest";
import { environmentTint } from "../photo/rasterBackend";
import { HALF_FLOAT_MAX, halfFloatEnvironment, neutralizedEnvironment } from "./hdriSource";
import { placeholderEnvironment } from "./SurfaceEnvironment";

/** A small warm equirect HDRI like the studio one (RGBA half floats; warm floor, bright cool window). */
function warmHdri(): DataTexture {
  const w = 16;
  const h = 8;
  const data = new Uint16Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const sky = y < h / 2;
      const window = sky && x < 4;
      const rgb = window ? [3, 3.1, 3.4] : sky ? [0.9, 0.85, 0.8] : [0.6, 0.4, 0.25];
      data.set([...rgb.map((v) => DataUtils.toHalfFloat(v)), DataUtils.toHalfFloat(1)], i);
    }
  }
  const texture = new DataTexture(data, w, h, RGBAFormat, HalfFloatType);
  texture.mapping = EquirectangularReflectionMapping;
  texture.colorSpace = LinearSRGBColorSpace;
  texture.magFilter = LinearFilter;
  texture.name = "studio";
  return texture;
}

describe("viewport HDRI isolation (D-1 / M-01)", () => {
  it("creates an independent neutral texture: the shared HDRI's pixels, source and properties are untouched", () => {
    const hdri = warmHdri();
    const pixels = Uint16Array.from(hdri.image.data as Uint16Array);
    const source = hdri.source;
    const version = hdri.version;
    const neutral = neutralizedEnvironment(hdri)!;
    expect(neutral).not.toBe(hdri);
    expect(neutral.source).not.toBe(source); // own source: never Texture.clone()'s shared one
    expect(neutral.image.data).not.toBe(hdri.image.data);
    expect(hdri.source).toBe(source);
    expect([...(hdri.image.data as Uint16Array)]).toEqual([...pixels]);
    expect(hdri.version).toBe(version); // no needsUpdate on the shared texture
    expect([hdri.mapping, hdri.colorSpace, hdri.magFilter, hdri.name]).toEqual([EquirectangularReflectionMapping, LinearSRGBColorSpace, LinearFilter, "studio"]);
    // The copy keeps the interpretation.
    // Half resolution, half-float storage (it only feeds a PMREM; F-1: linearly filterable everywhere).
    expect([neutral.mapping, neutral.colorSpace, neutral.type, neutral.format, neutral.image.width, neutral.image.height]).toEqual([
      EquirectangularReflectionMapping,
      LinearSRGBColorSpace,
      HalfFloatType,
      RGBAFormat,
      8,
      4,
    ]);
  });

  it("gives the photo renderer the same environment whether the viewport initializes first or last", () => {
    // Photo first (raster sky tint of the original), then the viewport derives its copy.
    const a = warmHdri();
    const photoFirst = environmentTint(a).getHexString();
    neutralizedEnvironment(a);
    const photoAfterViewport = environmentTint(a).getHexString();
    // Viewport first, then the photo renderer reads the shared HDRI.
    const b = warmHdri();
    neutralizedEnvironment(b);
    const viewportFirst = environmentTint(b).getHexString();
    expect(photoAfterViewport).toBe(photoFirst);
    expect(viewportFirst).toBe(photoFirst);
    // The original keeps its colour cast for the photo; only the viewport copy is neutral.
    const neutral = neutralizedEnvironment(warmHdri())!;
    // (the raster sky tint of the neutral copy differs: had the copy leaked, the photo would read it)
    expect(environmentTint(neutral).getHexString()).not.toBe(photoFirst);
  });

  it("removes the colour cast for the viewport while keeping the light structure", () => {
    const hdri = warmHdri();
    const neutral = neutralizedEnvironment(hdri)!;
    const at = (t: DataTexture, x: number, y: number) => [0, 1, 2].map((c) => DataUtils.fromHalfFloat((t.image.data as Uint16Array)[(y * 16 + x) * 4 + c]));
    const atNeutral = (x: number, y: number) => [0, 1, 2].map((c) => DataUtils.fromHalfFloat((neutral.image.data as Uint16Array)[(y * 8 + x) * 4 + c]));
    const lum = (rgb: number[]) => 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2];
    // Window brighter than floor in both; chroma of the floor much reduced in the copy.
    expect(lum(atNeutral(0, 0))).toBeGreaterThan(lum(atNeutral(4, 3)));
    const floor = atNeutral(4, 3);
    const original = at(hdri, 8, 6);
    expect(floor[0] / floor[2]).toBeLessThan(original[0] / original[2]);
  });

  it("the placeholder environment has the HDRI's measured energy by elevation and no colour", () => {
    const p = placeholderEnvironment(8, 8);
    const data = p.image.data as Uint16Array;
    const row = (y: number) => DataUtils.fromHalfFloat(data[y * 8 * 4]);
    expect(row(0)).toBeGreaterThan(row(4)); // zenith brighter than horizon
    expect(row(7)).toBeLessThan(row(4)); // floor darker
    expect(data[1]).toBe(data[0]);
    expect(data[2]).toBe(data[0]);
    expect(p.mapping).toBe(EquirectangularReflectionMapping);
  });
});

describe("viewport environment without OES_texture_float_linear (F-1)", () => {
  /** What WebGL 2 can filter linearly without extensions: never a 32-bit float texture. */
  const filterableInCoreWebGl2 = (t: DataTexture) =>
    t.type !== FloatType || (t.magFilter !== LinearFilter && t.minFilter !== LinearFilter && t.minFilter !== LinearMipmapLinearFilter);

  it("both viewport environment sources are half-float textures with linear filtering", () => {
    const placeholder = placeholderEnvironment();
    const neutral = neutralizedEnvironment(warmHdri())!;
    for (const t of [placeholder, neutral]) {
      expect(t.type).toBe(HalfFloatType);
      expect(t.image.data).toBeInstanceOf(Uint16Array);
      expect([t.magFilter, t.minFilter]).toEqual([LinearFilter, LinearFilter]);
      expect(filterableInCoreWebGl2(t)).toBe(true);
    }
  });

  it("keeps the HDR range (values far above 1) within half-float precision and clamps only beyond its maximum", () => {
    const values = new Float32Array([0, 0.25, 3.4, 1, 1500, 42, 70000, Number.NaN]);
    const t = halfFloatEnvironment(values, 2, 1, "test");
    const back = [...(t.image.data as Uint16Array)].map((h) => DataUtils.fromHalfFloat(h));
    expect(back[1]).toBeCloseTo(0.25, 3);
    expect(back[2]).toBeCloseTo(3.4, 2);
    expect(Math.abs(back[4] - 1500) / 1500).toBeLessThan(1e-3);
    expect(back[6]).toBe(HALF_FLOAT_MAX);
    expect(back[7]).toBe(0);
    // The neutral copy of the studio-like HDRI keeps its bright window far above 1.
    const neutral = neutralizedEnvironment(warmHdri())!;
    const max = Math.max(...[...(neutral.image.data as Uint16Array)].map((h) => DataUtils.fromHalfFloat(h)));
    expect(max).toBeGreaterThan(2.5);
  });
});

describe("render-target requirements of the photo backends (D-2)", () => {
  const src = (file: string) => readFileSync(join(__dirname, "../photo", file), "utf8");

  it("the backends allocate both RGBA16F and RGBA32F targets, which eligibility requires", async () => {
    const { RENDER_TARGET_REQUIREMENTS } = await import("../photo/capabilities");
    // Shared by both backends: the guided denoiser and the exposure metering.
    expect(src("denoiser.ts")).toMatch(/FloatType\)/);
    expect(src("denoiser.ts")).toMatch(/HalfFloatType/);
    expect(src("exposure.ts")).toMatch(/type: FloatType/);
    for (const backend of ["rasterBackend.ts", "backends.ts"]) {
      expect(src(backend)).toMatch(/new GuidedDenoiser\(renderer\)/);
      expect(src(backend)).toMatch(/new AutoExposure\(renderer\)/);
    }
    expect(RENDER_TARGET_REQUIREMENTS.raster).toEqual(["RGBA16F", "RGBA32F"]);
    expect(RENDER_TARGET_REQUIREMENTS.pathtraced).toEqual(["RGBA16F", "RGBA32F"]);
  });
});
