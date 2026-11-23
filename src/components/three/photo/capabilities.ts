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
