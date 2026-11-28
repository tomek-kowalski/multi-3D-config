/**
 * GPU detection for the photorealistic renderer. Both backends use three's WebGLRenderer, which needs
 * WebGL 2, and every render-target format they actually allocate must be renderable:
 * - fast raster (rasterBackend.ts) accumulates into RGBA16F colour attachments;
 * - the path tracer (three-gpu-pathtracer) accumulates into RGBA32F targets and keeps its BVH and
 *   material/texture data in large textures and a 2D texture array;
 * - BOTH run the guided denoiser (denoiser.ts: RGBA16F albedo/ping-pong targets, RGBA32F normal and
 *   position guides) and the exposure metering (exposure.ts: an RGBA32F target read back as floats), so
 *   both need RGBA16F and RGBA32F attachments (RENDER_TARGET_REQUIREMENTS).
 * Eligibility is decided per backend from real framebuffer-completeness probes, so the app never
 * offers a backend the device cannot create. Software rasterizers pass the checks but would need many
 * minutes per path-traced image, so they only get the fast renderer.
 */

export interface GpuProbe {
  readonly webgl2: boolean;
  /** EXT_color_buffer_float is exposed. */
  readonly floatColorBuffer: boolean;
  /** An RGBA16F (half-float) texture attachment is framebuffer-complete (fast raster). Defaults to floatColorBuffer. */
  readonly halfFloatTarget?: boolean;
  /** An RGBA32F texture attachment is framebuffer-complete (path tracer). Defaults to floatColorBuffer. */
  readonly floatTarget?: boolean;
  readonly maxTextureSize: number;
  /** MAX_ARRAY_TEXTURE_LAYERS (path-tracer texture array). Defaults to the WebGL 2 minimum, 256. */
  readonly maxArrayTextureLayers?: number;
  /** Unmasked renderer string when the browser exposes it. */
  readonly renderer: string | null;
}

export type PhotoMode = "pathtraced" | "raster";

/** Why path tracing is not used on this device. */
export type TraceIneligibleReason = "no_float_textures" | "small_textures" | "software_gpu";

export type GpuChoice =
  | { readonly mode: "pathtraced"; readonly reason: null; readonly rasterEligible: boolean }
  | { readonly mode: "raster"; readonly reason: TraceIneligibleReason; readonly rasterEligible: true }
  | { readonly mode: "unsupported"; readonly reason: "no_webgl" | "no_webgl2" | "no_render_targets"; readonly rasterEligible: false };

/** Render-target formats each backend allocates (verified against the backend sources by tests). */
export const RENDER_TARGET_REQUIREMENTS = {
  raster: ["RGBA16F", "RGBA32F"],
  pathtraced: ["RGBA16F", "RGBA32F"],
} as const;

/** Minimum MAX_TEXTURE_SIZE for the path tracer's BVH and texture atlases. */
export const MIN_TEXTURE_SIZE = 4096;
/** Minimum MAX_ARRAY_TEXTURE_LAYERS for the path tracer's texture array (the photo budget is 16–32). */
export const MIN_ARRAY_LAYERS = 32;
const SOFTWARE_RENDERER = /swiftshader|llvmpipe|softpipe|software|basic render driver|microsoft basic/i;

export function chooseRenderMode(probe: GpuProbe | null): GpuChoice {
  if (!probe) return { mode: "unsupported", reason: "no_webgl", rasterEligible: false };
  // three's WebGLRenderer (both backends) cannot run on WebGL 1.
  if (!probe.webgl2) return { mode: "unsupported", reason: "no_webgl2", rasterEligible: false };
  const halfFloatTarget = probe.halfFloatTarget ?? probe.floatColorBuffer;
  const floatTarget = probe.floatColorBuffer && (probe.floatTarget ?? probe.floatColorBuffer);
  // Both backends need both formats (denoiser guides and exposure metering are RGBA32F).
  const rasterEligible = halfFloatTarget && floatTarget;
  if (!rasterEligible) return { mode: "unsupported", reason: "no_render_targets", rasterEligible: false };
  const traceReason: TraceIneligibleReason | null =
    probe.maxTextureSize < MIN_TEXTURE_SIZE || (probe.maxArrayTextureLayers ?? 256) < MIN_ARRAY_LAYERS
      ? "small_textures"
      : probe.renderer && SOFTWARE_RENDERER.test(probe.renderer)
        ? "software_gpu"
        : null;
  if (traceReason === null) return { mode: "pathtraced", reason: null, rasterEligible };
  return { mode: "raster", reason: traceReason, rasterEligible: true };
}

/** Whether a colour texture of this format can be rendered to (framebuffer completeness). */
function renderable(gl: WebGL2RenderingContext, internalFormat: number, type: number): boolean {
  const texture = gl.createTexture();
  const framebuffer = gl.createFramebuffer();
  try {
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texImage2D(gl.TEXTURE_2D, 0, internalFormat, 4, 4, 0, gl.RGBA, type, null);
    gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
    return gl.getError() === gl.NO_ERROR && gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
  } catch {
    return false;
  } finally {
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.bindTexture(gl.TEXTURE_2D, null);
    gl.deleteFramebuffer(framebuffer);
    gl.deleteTexture(texture);
  }
}

/** Probes the browser's WebGL support on a throw-away canvas (null: no WebGL at all). */
export function probeGpu(createCanvas: () => HTMLCanvasElement = () => document.createElement("canvas")): GpuProbe | null {
  try {
    const canvas = createCanvas();
    const gl2 = canvas.getContext("webgl2") as WebGL2RenderingContext | null;
    const gl = gl2 ?? (canvas.getContext("webgl") as WebGLRenderingContext | null);
    if (!gl) return null;
    const debug = gl.getExtension("WEBGL_debug_renderer_info");
    const floatColorBuffer = gl2 ? gl2.getExtension("EXT_color_buffer_float") !== null : false;
    const halfFloatExtension = gl2 ? floatColorBuffer || gl2.getExtension("EXT_color_buffer_half_float") !== null : false;
    const probe: GpuProbe = {
      webgl2: gl2 !== null,
      floatColorBuffer,
      halfFloatTarget: gl2 && halfFloatExtension ? renderable(gl2, gl2.RGBA16F, gl2.HALF_FLOAT) : false,
      floatTarget: gl2 && floatColorBuffer ? renderable(gl2, gl2.RGBA32F, gl2.FLOAT) : false,
      maxTextureSize: Number(gl.getParameter(gl.MAX_TEXTURE_SIZE)) || 0,
      maxArrayTextureLayers: gl2 ? Number(gl2.getParameter(gl2.MAX_ARRAY_TEXTURE_LAYERS)) || 0 : 0,
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

/** The quality "auto" stands for on this device (path tracing when the fast renderer is not eligible). */
export function autoQuality(choice: GpuChoice, performance: DevicePerformance): "fast" | "standard" {
  if (choice.mode === "pathtraced" && !choice.rasterEligible) return "standard";
  return choice.mode === "pathtraced" && (performance.pathtracedSppPerSecond ?? 0) >= AUTO_PATH_TRACING_MIN_SPP ? "standard" : "fast";
}
