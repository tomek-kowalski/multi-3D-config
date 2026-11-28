import { DataTexture, DataUtils, HalfFloatType, LinearFilter, RGBAFormat, type ColorSpace, type Mapping } from "three";

/** Largest finite half-float value: HDR radiance above it is clamped (the studio HDRI peaks far below). */
export const HALF_FLOAT_MAX = 65504;

/**
 * Packs linear RGBA floats into a half-float environment texture: linearly filterable in core WebGL 2
 * (no OES_texture_float_linear needed — 32-bit float textures with linear filtering sample black
 * without it), half the memory of floats, ample range and precision for prefiltered lighting.
 */
export function halfFloatEnvironment(rgba: Float32Array, width: number, height: number, name: string): DataTexture {
  const data = new Uint16Array(rgba.length);
  for (let i = 0; i < rgba.length; i++) {
    const v = rgba[i];
    data[i] = DataUtils.toHalfFloat(Number.isFinite(v) ? Math.min(Math.max(v, 0), HALF_FLOAT_MAX) : 0);
  }
  const texture = new DataTexture(data, width, height, RGBAFormat, HalfFloatType);
  texture.name = name;
  texture.magFilter = LinearFilter;
  texture.minFilter = LinearFilter;
  texture.generateMipmaps = false;
  texture.needsUpdate = true;
  return texture;
}

/** CC0 HDRI from Poly Haven (public/hdri/LICENSE.txt): a bright interior with large windows. */
export const HDRI_URL = "/hdri/photo_studio_loft_hall_1k.hdr";

let source: Promise<DataTexture> | null = null;

/**
 * The decoded studio HDRI, shared by the viewport reflections (SurfaceEnvironment) and both photo
 * backends: downloaded and decoded once per page. Each WebGL context still uploads and prefilters it
 * itself (PMREM is context-specific and owned by its canvas/backend). The loader is imported lazily so
 * it never weighs on the configurator's first load. A failed download is retried by the next call.
 */
export function loadHdriSource(url = HDRI_URL): Promise<DataTexture> {
  if (url !== HDRI_URL) return loadHdr(url);
  source ??= loadHdr(url).catch((error) => {
    source = null;
    throw error;
  });
  return source;
}

async function loadHdr(url: string): Promise<DataTexture> {
  const [{ HDRLoader }, { EquirectangularReflectionMapping }] = await Promise.all([import("three/examples/jsm/loaders/HDRLoader.js"), import("three")]);
  const texture = await new HDRLoader().loadAsync(url);
  texture.mapping = EquirectangularReflectionMapping;
  return texture;
}

/**
 * An independent copy of an equirectangular HDR environment with its colour removed: the overall cast
 * divided out (solid-angle-weighted mean colour) and each pixel's remaining chroma reduced, luminance
 * preserved. The viewport reflects and is filled by this neutral studio copy, so configured and
 * catalog colours keep their hue (the HDRI's wooden floor would otherwise warm every vertical surface);
 * directional light structure (bright windows, darker floor) is untouched.
 *
 * The copy owns new pixel data in a new texture source: the shared HDRI that the photo renderer lights
 * with (and its pixels, sampler and mapping) is never modified, whichever is initialized first.
 */
export function neutralizedEnvironment(
  texture: DataTexture,
  toFloat: (half: number) => number = DataUtils.fromHalfFloat,
  /** Share of each pixel's own chroma kept (0 = grey studio, 1 = original colours). */
  saturation = 0.25,
  /**
   * Box-downsampling factor. The copy (half-float, see halfFloatEnvironment) only feeds a PMREM (blurred reflections and fill), so half
   * resolution is visually equivalent and cuts the main-thread work at startup by about 4×.
   */
  step = 2,
): DataTexture | null {
  const image = texture.image as { data?: Uint16Array | Float32Array; width?: number; height?: number } | undefined;
  const data = image?.data;
  const width = image?.width ?? 0;
  const height = image?.height ?? 0;
  if (!data || !width || !height) return null;
  const half = data instanceof Uint16Array;
  const channels = data.length / (width * height);
  const w = Math.max(1, Math.floor(width / step));
  const h = Math.max(1, Math.floor(height / step));
  const out = new Float32Array(w * h * 4);
  // Pass 1: box-filtered linear RGB (energy preserving) and the solid-angle-weighted mean colour.
  const sum = [0, 0, 0];
  const area = step * step;
  for (let y = 0; y < h; y++) {
    const weight = Math.sin(((y + 0.5) / h) * Math.PI);
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 4;
      for (let dy = 0; dy < step; dy++) {
        const row = (y * step + dy) * width;
        for (let dx = 0; dx < step; dx++) {
          const i = (row + x * step + dx) * channels;
          for (let c = 0; c < 3; c++) out[o + c] += half ? toFloat(data[i + c]) : data[i + c];
        }
      }
      for (let c = 0; c < 3; c++) {
        out[o + c] /= area;
        sum[c] += out[o + c] * weight;
      }
      out[o + 3] = 1;
    }
  }
  const luminance = 0.2126 * sum[0] + 0.7152 * sum[1] + 0.0722 * sum[2];
  if (!(luminance > 0) || sum.some((v) => !(v > 0))) return null;
  const scale = sum.map((v) => luminance / v);
  // Pass 2: remove the cast, reduce each pixel's chroma, keep its luminance.
  for (let o = 0; o < out.length; o += 4) {
    const r = out[o] * scale[0];
    const g = out[o + 1] * scale[1];
    const bl = out[o + 2] * scale[2];
    const lum = 0.2126 * r + 0.7152 * g + 0.0722 * bl;
    out[o] = lum + (r - lum) * saturation;
    out[o + 1] = lum + (g - lum) * saturation;
    out[o + 2] = lum + (bl - lum) * saturation;
  }
  // A new half-float texture with its own source (Texture.clone() would share the source and its pixels).
  const copy = halfFloatEnvironment(out, w, h, `${texture.name || "hdri"}:viewport-neutral`);
  copy.mapping = texture.mapping as Mapping;
  copy.wrapS = texture.wrapS;
  copy.wrapT = texture.wrapT;
  copy.colorSpace = texture.colorSpace as ColorSpace;
  copy.flipY = texture.flipY;
  return copy;
}
