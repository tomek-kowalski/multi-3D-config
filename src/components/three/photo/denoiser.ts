import {
  Color,
  DoubleSide,
  FloatType,
  HalfFloatType,
  LinearFilter,
  Mesh,
  MeshBasicMaterial,
  NearestFilter,
  RGBAFormat,
  ShaderMaterial,
  Vector2,
  WebGLRenderTarget,
  type Camera,
  type Material,
  type Object3D,
  type Scene,
  type Texture,
  type WebGLRenderer,
} from "three";
import { FullScreenQuad } from "three/examples/jsm/postprocessing/Pass.js";

/**
 * Edge-aware denoiser for the path-traced image that keeps textures and edges sharp.
 *
 * Monte Carlo noise lives in the lighting, not in the surface colours. So the image is divided by the
 * surface albedo (colour × decor texture, rasterized at 2×2 supersampling so it is antialiased like
 * the path-traced image), which leaves only the illumination. The illumination is filtered with an
 * edge-avoiding à-trous wavelet filter (Dammertz et al. 2010) whose weights stop at geometric edges
 * (surface normals, distance from the surface plane) and at lighting changes larger than the local
 * noise level (shadow edges; the noise level is estimated per pixel from its 5×5 neighbourhood, as in
 * SVGF), then multiplied by the albedo again. Wood grain and other decor detail are therefore never
 * blurred, and furniture edges stay crisp. Before filtering, isolated extreme samples — fireflies and
 * black "dropouts" — are clamped to the range of their neighbourhood.
 */
export interface DenoiseOptions {
  /** À-trous iterations (filter radius 2^iterations px). */
  readonly iterations: number;
  /** Lighting edge-stopping: luminance difference tolerated, in units of the local noise (standard deviation). */
  readonly sigmaLuminance: number;
  /** Geometry edge-stopping: distance from the surface plane, as a fraction of the camera distance. */
  readonly sigmaPlane: number;
  /** Normal edge-stopping exponent. */
  readonly normalPower: number;
  /** Outliers: a pixel's luminance is limited to mean ± k·σ of its 3×3 neighbourhood. */
  readonly fireflyK: number;
}

export const DEFAULT_DENOISE: DenoiseOptions = {
  iterations: 4,
  sigmaLuminance: 2,
  sigmaPlane: 0.002,
  normalPower: 64,
  fireflyK: 2.5,
};

/** Added to the albedo in both the division and the multiplication: exact round trip, no blow-up on black. */
const ALBEDO_EPS = 0.02;

const VERTEX = /* glsl */ `varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`;

/** View-space normal (rgb) and a geometry flag (a = 1 where a surface was drawn). */
const NORMAL_MATERIAL = () =>
  new ShaderMaterial({
    side: DoubleSide,
    vertexShader: /* glsl */ `varying vec3 vN; void main() { vN = normalMatrix * normal; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
    fragmentShader: /* glsl */ `varying vec3 vN; void main() { vec3 n = normalize(vN); if (!gl_FrontFacing) n = -n; gl_FragColor = vec4(n, 1.0); }`,
  });

/** View-space position (rgb). */
const POSITION_MATERIAL = () =>
  new ShaderMaterial({
    side: DoubleSide,
    vertexShader: /* glsl */ `varying vec3 vP; void main() { vec4 p = modelViewMatrix * vec4(position, 1.0); vP = p.xyz; gl_Position = projectionMatrix * p; }`,
    fragmentShader: /* glsl */ `varying vec3 vP; void main() { gl_FragColor = vec4(vP, 1.0); }`,
  });

const DEMODULATE = () =>
  new ShaderMaterial({
    uniforms: { tRadiance: { value: null }, tAlbedo: { value: null }, tNormal: { value: null }, texel: { value: new Vector2() }, fireflyK: { value: 3 } },
    vertexShader: VERTEX,
    fragmentShader: /* glsl */ `
      uniform sampler2D tRadiance, tAlbedo, tNormal; uniform vec2 texel; uniform float fireflyK; varying vec2 vUv;
      const float EPS = ${ALBEDO_EPS.toFixed(4)};
      float lum(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }
      vec3 illum(vec2 uv) { return texture2D(tRadiance, uv).rgb / (texture2D(tAlbedo, uv).rgb + EPS); }
      void main() {
        if (texture2D(tNormal, vUv).a < 0.5) { gl_FragColor = vec4(texture2D(tRadiance, vUv).rgb, 0.0); return; }
        vec3 c = illum(vUv);
        // Firefly clamp against the 3x3 neighbourhood (centre excluded).
        float s = 0.0, s2 = 0.0;
        for (int y = -1; y <= 1; y++) for (int x = -1; x <= 1; x++) {
          if (x == 0 && y == 0) continue;
          float l = lum(illum(vUv + vec2(float(x), float(y)) * texel));
          s += l; s2 += l * l;
        }
        float mean = s / 8.0, sd = sqrt(max(s2 / 8.0 - mean * mean, 0.0));
        float l = lum(c);
        float upper = mean + fireflyK * sd + 1e-4, lower = max(mean - fireflyK * sd, 0.0);
        if (l > upper) c *= upper / l;
        else if (l < lower) c = l > 1e-5 ? c * (lower / l) : vec3(lower);
        gl_FragColor = vec4(c, 1.0);
      }`,
  });

/** Local noise level: standard deviation of the illumination luminance over 5×5 surface pixels. */
const NOISE = () =>
  new ShaderMaterial({
    uniforms: { tIllum: { value: null }, texel: { value: new Vector2() } },
    vertexShader: VERTEX,
    fragmentShader: /* glsl */ `
      uniform sampler2D tIllum; uniform vec2 texel; varying vec2 vUv;
      float lum(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }
      void main() {
        float s = 0.0, s2 = 0.0, n = 0.0;
        for (int y = -2; y <= 2; y++) for (int x = -2; x <= 2; x++) {
          vec4 c = texture2D(tIllum, vUv + vec2(float(x), float(y)) * texel);
          if (c.a < 0.5) continue;
          float l = lum(c.rgb); s += l; s2 += l * l; n += 1.0;
        }
        float mean = n > 0.0 ? s / n : 0.0;
        gl_FragColor = vec4(sqrt(max(n > 0.0 ? s2 / n - mean * mean : 0.0, 0.0)), 0.0, 0.0, 1.0);
      }`,
  });

const ATROUS = () =>
  new ShaderMaterial({
    uniforms: {
      tIllum: { value: null },
      tNormal: { value: null },
      tPosition: { value: null },
      tNoise: { value: null },
      noiseScale: { value: 1 },
      texel: { value: new Vector2() },
      stepWidth: { value: 1 },
      sigmaL: { value: 0.6 },
      sigmaP: { value: 0.01 },
      normalPower: { value: 64 },
    },
    vertexShader: VERTEX,
    fragmentShader: /* glsl */ `
      uniform sampler2D tIllum, tNormal, tPosition, tNoise; uniform vec2 texel; uniform float stepWidth, sigmaL, sigmaP, normalPower, noiseScale;
      varying vec2 vUv;
      float lum(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }
      void main() {
        vec4 cp = texture2D(tIllum, vUv);
        if (cp.a < 0.5) { gl_FragColor = cp; return; }
        vec3 np = texture2D(tNormal, vUv).rgb;
        vec3 pp = texture2D(tPosition, vUv).rgb;
        float lp = lum(cp.rgb);
        // Tolerance from the local noise level (never zero: flat, noise-free areas still average).
        float lumTol = sigmaL * texture2D(tNoise, vUv).r * noiseScale + 1e-3 * (lp + 1e-3);
        float planeTol = sigmaP * length(pp) + 1e-4;
        float kernel[3]; kernel[0] = 3.0 / 8.0; kernel[1] = 1.0 / 4.0; kernel[2] = 1.0 / 16.0;
        vec3 sum = vec3(0.0); float wsum = 0.0;
        for (int y = -2; y <= 2; y++) for (int x = -2; x <= 2; x++) {
          vec2 uv = vUv + vec2(float(x), float(y)) * texel * stepWidth;
          vec4 cq = texture2D(tIllum, uv);
          if (cq.a < 0.5) continue;
          vec3 nq = texture2D(tNormal, uv).rgb;
          vec3 pq = texture2D(tPosition, uv).rgb;
          float wn = pow(max(dot(np, nq), 0.0), normalPower);
          float wp = exp(-abs(dot(np, pq - pp)) / planeTol);
          float wl = exp(-abs(lum(cq.rgb) - lp) / lumTol);
          float w = kernel[abs(x)] * kernel[abs(y)] * wn * wp * wl;
          sum += cq.rgb * w; wsum += w;
        }
        gl_FragColor = vec4(wsum > 0.0 ? sum / wsum : cp.rgb, 1.0);
      }`,
  });

const REMODULATE = () =>
  new ShaderMaterial({
    uniforms: { tIllum: { value: null }, tRadiance: { value: null }, tAlbedo: { value: null } },
    vertexShader: VERTEX,
    fragmentShader: /* glsl */ `
      uniform sampler2D tIllum, tRadiance, tAlbedo; varying vec2 vUv;
      void main() {
        vec4 i = texture2D(tIllum, vUv);
        // Background (no surface): the path tracer's value is exact (the backdrop) and is kept.
        gl_FragColor = i.a < 0.5 ? vec4(texture2D(tRadiance, vUv).rgb, 1.0) : vec4(i.rgb * (texture2D(tAlbedo, vUv).rgb + ${ALBEDO_EPS.toFixed(4)}), 1.0);
      }`,
  });

function target(width: number, height: number, type: typeof HalfFloatType | typeof FloatType = HalfFloatType, filter: typeof NearestFilter | typeof LinearFilter = NearestFilter) {
  return new WebGLRenderTarget(width, height, { type, format: RGBAFormat, minFilter: filter, magFilter: filter, depthBuffer: true });
}

type Surface = Material & { color?: Color; map?: Texture | null; transmission?: number };

export class GuidedDenoiser {
  private width = 0;
  private height = 0;
  private albedo = target(1, 1, HalfFloatType, LinearFilter);
  private normal = target(1, 1, FloatType);
  private position = target(1, 1, FloatType);
  private ping = target(1, 1);
  private pong = target(1, 1);
  private result = target(1, 1);
  private noise = target(1, 1);
  private readonly normalMaterial = NORMAL_MATERIAL();
  private readonly positionMaterial = POSITION_MATERIAL();
  private readonly demodulate = DEMODULATE();
  private readonly atrous = ATROUS();
  private readonly noiseMaterial = NOISE();
  private readonly remodulate = REMODULATE();
  private readonly quad = new FullScreenQuad();
  private readonly albedoMaterials = new Map<Material, MeshBasicMaterial>();

  constructor(private readonly renderer: WebGLRenderer) {}

  private resize(width: number, height: number) {
    if (width === this.width && height === this.height) return;
    this.width = width;
    this.height = height;
    this.albedo.setSize(width * 2, height * 2);
    for (const t of [this.normal, this.position, this.ping, this.pong, this.result, this.noise]) t.setSize(width, height);
  }

  /** Rasterizes the guide buffers (albedo, normals, positions) of the scene as seen by the camera. */
  prepare(scene: Scene, camera: Camera, width: number, height: number): void {
    this.resize(width, height);
    // Albedo materials belong to one scene (each photo job has its own materials): never accumulate them.
    this.albedoMaterials.forEach((m) => m.dispose());
    this.albedoMaterials.clear();
    const renderer = this.renderer;
    const background = scene.background;
    const environment = scene.environment;
    const hidden: Object3D[] = [];
    const swapped: [Mesh, Material | Material[]][] = [];
    scene.traverse((o) => {
      if (!(o instanceof Mesh)) return;
      const m = (Array.isArray(o.material) ? o.material[0] : o.material) as Surface;
      // Glass is see-through in the photo: the guide shows what is behind it.
      if ((m.transmission ?? 0) > 0 && o.visible) {
        o.visible = false;
        hidden.push(o);
        return;
      }
      let basic = this.albedoMaterials.get(m);
      if (!basic) {
        basic = new MeshBasicMaterial({ color: m.color?.clone() ?? new Color(1, 1, 1), map: m.map ?? null, side: DoubleSide });
        this.albedoMaterials.set(m, basic);
      }
      swapped.push([o, o.material]);
      o.material = basic;
    });
    scene.background = null;
    scene.environment = null;
    const clear = renderer.getClearColor(new Color());
    const clearAlpha = renderer.getClearAlpha();
    renderer.setClearColor(0x000000, 0);
    try {
      renderer.setRenderTarget(this.albedo);
      renderer.clear();
      renderer.render(scene, camera);
      for (const [mesh, material] of swapped) mesh.material = material;
      swapped.length = 0;
      scene.overrideMaterial = this.normalMaterial;
      renderer.setRenderTarget(this.normal);
      renderer.clear();
      renderer.render(scene, camera);
      scene.overrideMaterial = this.positionMaterial;
      renderer.setRenderTarget(this.position);
      renderer.clear();
      renderer.render(scene, camera);
    } finally {
      for (const [mesh, material] of swapped) mesh.material = material;
      scene.overrideMaterial = null;
      scene.background = background;
      scene.environment = environment;
      for (const o of hidden) o.visible = true;
      renderer.setRenderTarget(null);
      renderer.setClearColor(clear, clearAlpha);
    }
  }

  /** Denoises the linear HDR radiance; returns the denoised linear HDR texture. */
  denoise(radiance: Texture, options: DenoiseOptions = DEFAULT_DENOISE): Texture {
    const renderer = this.renderer;
    const texel = new Vector2(1 / this.width, 1 / this.height);
    const run = (material: ShaderMaterial, out: WebGLRenderTarget) => {
      this.quad.material = material;
      renderer.setRenderTarget(out);
      this.quad.render(renderer);
    };
    this.demodulate.uniforms.tRadiance.value = radiance;
    this.demodulate.uniforms.tAlbedo.value = this.albedo.texture;
    this.demodulate.uniforms.tNormal.value = this.normal.texture;
    this.demodulate.uniforms.texel.value = texel;
    this.demodulate.uniforms.fireflyK.value = options.fireflyK;
    run(this.demodulate, this.ping);
    this.noiseMaterial.uniforms.tIllum.value = this.ping.texture;
    this.noiseMaterial.uniforms.texel.value = texel;
    run(this.noiseMaterial, this.noise);
    let src = this.ping;
    let dst = this.pong;
    const u = this.atrous.uniforms;
    u.tNormal.value = this.normal.texture;
    u.tPosition.value = this.position.texture;
    u.texel.value = texel;
    u.sigmaP.value = options.sigmaPlane;
    u.normalPower.value = options.normalPower;
    u.tNoise.value = this.noise.texture;
    u.sigmaL.value = options.sigmaLuminance;
    for (let i = 0; i < options.iterations; i++) {
      u.tIllum.value = src.texture;
      u.stepWidth.value = 2 ** i;
      // Each pass averages ~2–3 effective samples per axis: the remaining noise shrinks accordingly.
      u.noiseScale.value = 1 / 1.6 ** i;
      run(this.atrous, dst);
      [src, dst] = [dst, src];
    }
    this.remodulate.uniforms.tIllum.value = src.texture;
    this.remodulate.uniforms.tRadiance.value = radiance;
    this.remodulate.uniforms.tAlbedo.value = this.albedo.texture;
    run(this.remodulate, this.result);
    renderer.setRenderTarget(null);
    return this.result.texture;
  }

  dispose(): void {
    for (const t of [this.albedo, this.normal, this.position, this.ping, this.pong, this.result, this.noise]) t.dispose();
    for (const m of [this.normalMaterial, this.positionMaterial, this.demodulate, this.atrous, this.noiseMaterial, this.remodulate]) m.dispose();
    this.albedoMaterials.forEach((m) => m.dispose());
    this.quad.dispose();
  }
}
