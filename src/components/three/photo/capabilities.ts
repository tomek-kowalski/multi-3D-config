/**
 * GPU detection for the photorealistic renderer. Path tracing (three-gpu-pathtracer) needs WebGL 2
 * with renderable float textures and large data textures (the BVH). Software rasterizers technically
 * pass those checks but would need many minutes per image, so they get the raster fallback.
 */

export interface GpuProbe {
  readonly webgl2: boolean;
  readonly floatColorBuffer: boolean;
  readonly maxTextureSize: number;
  /** Unmasked renderer string when the browser exposes it. */
  readonly renderer: string | null;
}

export type PhotoMode = "pathtraced" | "raster";

export type GpuChoice =
  | { readonly mode: "pathtraced"; readonly reason: null }
  | { readonly mode: "raster"; readonly reason: "no_webgl2" | "no_float_textures" | "small_textures" | "software_gpu" }
  | { readonly mode: "unsupported"; readonly reason: "no_webgl" };

/** Minimum MAX_TEXTURE_SIZE for the path tracer's BVH and texture atlases. */
export const MIN_TEXTURE_SIZE = 4096;
const SOFTWARE_RENDERER = /swiftshader|llvmpipe|softpipe|software|basic render driver|microsoft basic/i;

export function chooseRenderMode(probe: GpuProbe | null): GpuChoice {
  if (!probe) return { mode: "unsupported", reason: "no_webgl" };
  if (!probe.webgl2) return { mode: "raster", reason: "no_webgl2" };
  if (!probe.floatColorBuffer) return { mode: "raster", reason: "no_float_textures" };
  if (probe.maxTextureSize < MIN_TEXTURE_SIZE) return { mode: "raster", reason: "small_textures" };
  if (probe.renderer && SOFTWARE_RENDERER.test(probe.renderer)) return { mode: "raster", reason: "software_gpu" };
  return { mode: "pathtraced", reason: null };
}

/** Probes the browser's WebGL support on a throw-away canvas (null: no WebGL at all). */
export function probeGpu(createCanvas: () => HTMLCanvasElement = () => document.createElement("canvas")): GpuProbe | null {
  try {
    const canvas = createCanvas();
    const gl2 = canvas.getContext("webgl2") as WebGL2RenderingContext | null;
    const gl = gl2 ?? (canvas.getContext("webgl") as WebGLRenderingContext | null);
    if (!gl) return null;
    const debug = gl.getExtension("WEBGL_debug_renderer_info");
    const probe: GpuProbe = {
      webgl2: gl2 !== null,
      floatColorBuffer: gl2 ? gl2.getExtension("EXT_color_buffer_float") !== null : false,
      maxTextureSize: Number(gl.getParameter(gl.MAX_TEXTURE_SIZE)) || 0,
      renderer: debug ? String(gl.getParameter(debug.UNMASKED_RENDERER_WEBGL)) : null,
    };
    gl.getExtension("WEBGL_lose_context")?.loseContext();
    return probe;
  } catch {
    return null;
  }
}

/**
 * Measured rendering performance of this device, kept in localStorage: the automatic quality choice
 * is based on what this GPU actually achieved, not on its name.
 * - pathtracedSppPerSecond: path-traced samples per second, normalized to 1920×1080;
 * - rasterFrameMs: milliseconds per fast-rasterized frame, normalized to 1920×1080;
 * - pathtracerStartupMs: setup + shader compilation before the first sample.
 */
export interface DevicePerformance {
  readonly pathtracedSppPerSecond?: number;
  readonly rasterFrameMs?: number;
  readonly pathtracerStartupMs?: number;
}

const PERFORMANCE_KEY = "multi3d.photo.performance.v1";
const FULL_HD = 1920 * 1080;
/**
 * Path tracing is chosen automatically only from this throughput on: the standard quality (192 samples
 * at 1920×1080) then takes about a minute. Slower GPUs (e.g. Intel UHD 620: ~0.5) get the fast renderer.
 */
export const AUTO_PATH_TRACING_MIN_SPP = 3;

type KeyValueStore = Pick<Storage, "getItem" | "setItem">;

function defaultStore(): KeyValueStore | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

export function readPerformance(store: KeyValueStore | null = defaultStore()): DevicePerformance {
  try {
    const value = JSON.parse(store?.getItem(PERFORMANCE_KEY) ?? "{}") as DevicePerformance;
    return value && typeof value === "object" ? value : {};
  } catch {
    return {};
  }
}

/** Records the measured throughput of a finished render (sampling time only, compilation excluded). */
export function recordPerformance(
  photo: { mode: PhotoMode; samples: number; width: number; height: number; timings: Readonly<Record<string, number>> },
  store: KeyValueStore | null = defaultStore(),
): DevicePerformance {
  const current = readPerformance(store);
  const sampling = photo.timings.sampling;
  if (!store || !sampling || photo.samples <= 0) return current;
  const scale = (photo.width * photo.height) / FULL_HD;
  const next: DevicePerformance =
    photo.mode === "pathtraced"
      ? {
          ...current,
          pathtracedSppPerSecond: Math.round(((photo.samples * scale) / (sampling / 1000)) * 100) / 100,
          pathtracerStartupMs: (photo.timings.setScene ?? 0) + (photo.timings.firstSample ?? 0),
        }
      : { ...current, rasterFrameMs: Math.round((sampling / photo.samples / scale) * 10) / 10 };
  try {
    store.setItem(PERFORMANCE_KEY, JSON.stringify(next));
  } catch {
    // storage full or disabled: the choice falls back to the fast renderer
  }
  return next;
}

/** The quality "auto" stands for on this device. */
export function autoQuality(choice: GpuChoice, performance: DevicePerformance): "fast" | "standard" {
  return choice.mode === "pathtraced" && (performance.pathtracedSppPerSecond ?? 0) >= AUTO_PATH_TRACING_MIN_SPP ? "standard" : "fast";
}
