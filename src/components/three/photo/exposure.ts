import {
  FloatType,
  NearestFilter,
  RGBAFormat,
  ShaderMaterial,
  WebGLRenderTarget,
  type Texture,
  type WebGLRenderer,
} from "three";
import { FullScreenQuad } from "three/examples/jsm/postprocessing/Pass.js";

/**
 * Highlight-protecting exposure, as a photographer meters a bright room: the brightest surfaces of the
 * room and furniture (the HIGHLIGHT_PERCENTILE of their luminance, before tone mapping) are placed just
 * inside the tone mapper's highlight shoulder, so white walls, white decors and the mattress keep
 * their shading instead of flattening into the shoulder. The exposure is only ever lowered (dark rooms
 * stay as they are) and never below MIN_EXPOSURE. Colours are not changed: this is the camera's
 * exposure, the same factor for every pixel.
 */
/**
 * The large light surfaces (walls, mattress, white fronts), not small hot spots such as the top of a
 * cabinet right under the ceiling light, which may sit in the shoulder like a real photo's highlights.
 */
export const HIGHLIGHT_PERCENTILE = 0.95;
/** Linear luminance the highlights are mapped to before tone mapping: inside the gentle start of PBR Neutral's shoulder (0.76), so whites read white (~238) yet keep their shading. */
export const HIGHLIGHT_TARGET = 0.95;
/** At most −0.4 stops: correct exposure, never a darkened room (colours stay as configured). */
export const MIN_EXPOSURE = 0.75;

/** The exposure factor (≤ 1) for the given surface luminances (background excluded). */
export function highlightExposure(luminances: ArrayLike<number>, percentile = HIGHLIGHT_PERCENTILE, target = HIGHLIGHT_TARGET): number {
  const values = Array.from(luminances).filter((v) => Number.isFinite(v) && v > 0);
  if (values.length === 0) return 1;
  values.sort((a, b) => a - b);
  const highlight = values[Math.min(values.length - 1, Math.floor(percentile * values.length))];
  if (highlight <= target) return 1;
  return Math.max(MIN_EXPOSURE, target / highlight);
}

const SIZE = { width: 240, height: 135 };

/** Measures the surface luminances of an HDR image on the GPU (downsampled) and returns the exposure. */
export class AutoExposure {
  private readonly target = new WebGLRenderTarget(SIZE.width, SIZE.height, { type: FloatType, format: RGBAFormat, minFilter: NearestFilter, magFilter: NearestFilter, depthBuffer: false });
  private readonly material = new ShaderMaterial({
    uniforms: { tColor: { value: null }, tMask: { value: null } },
    vertexShader: "varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }",
    fragmentShader: /* glsl */ `
      uniform sampler2D tColor, tMask; varying vec2 vUv;
      void main() {
        vec3 c = texture2D(tColor, vUv).rgb;
        // Room and furniture surfaces only (mask alpha = 1); the backdrop does not set the exposure.
        float surface = texture2D(tMask, vUv).a;
        gl_FragColor = vec4(dot(c, vec3(0.2126, 0.7152, 0.0722)) * step(0.5, surface), 0.0, 0.0, 1.0);
      }`,
    depthTest: false,
    depthWrite: false,
  });
  private readonly quad = new FullScreenQuad(this.material);
  private readonly pixels = new Float32Array(SIZE.width * SIZE.height * 4);

  constructor(private readonly renderer: WebGLRenderer) {}

  measure(hdr: Texture, surfaceMask: Texture): number {
    this.material.uniforms.tColor.value = hdr;
    this.material.uniforms.tMask.value = surfaceMask;
    const previous = this.renderer.getRenderTarget();
    this.renderer.setRenderTarget(this.target);
    this.quad.render(this.renderer);
    this.renderer.readRenderTargetPixels(this.target, 0, 0, SIZE.width, SIZE.height, this.pixels);
    this.renderer.setRenderTarget(previous);
    const luminances = new Float32Array(SIZE.width * SIZE.height);
    for (let i = 0; i < luminances.length; i++) luminances[i] = this.pixels[i * 4];
    return highlightExposure(luminances);
  }

  dispose(): void {
    this.target.dispose();
    this.material.dispose();
    this.quad.dispose();
  }
}
