"use client";

import { DenoiseMaterial, WebGLPathTracer } from "three-gpu-pathtracer";
import {
  ACESFilmicToneMapping,
  AgXToneMapping,
  Box3,
  DirectionalLight,
  EquirectangularReflectionMapping,
  NeutralToneMapping,
  PMREMGenerator,
  ShaderMaterial,
  SRGBColorSpace,
  Vector3,
  VSMShadowMap,
  WebGLRenderer,
  type DataTexture,
  type PerspectiveCamera,
  type Scene,
  type Texture,
  type ToneMapping,
} from "three";
import { HDRLoader } from "three/examples/jsm/loaders/HDRLoader.js";
import { RectAreaLightUniformsLib } from "three/examples/jsm/lights/RectAreaLightUniformsLib.js";
import { FullScreenQuad } from "three/examples/jsm/postprocessing/Pass.js";
import type { PhotoMode } from "./capabilities";
import type { PhotoBackend } from "./photoEngine";
import { QUALITY_PRESETS, type PhotoSettings, type PhotoToneMapping } from "./photoSettings";

/** CC0 HDRI from Poly Haven (public/hdri/LICENSE.txt): a bright interior with large windows. */
export const HDRI_URL = "/hdri/photo_studio_loft_hall_1k.hdr";

const TONE_MAPPING: Record<PhotoToneMapping, ToneMapping> = {
  neutral: NeutralToneMapping,
  agx: AgXToneMapping,
  aces: ACESFilmicToneMapping,
};

export async function loadEnvironment(url = HDRI_URL): Promise<DataTexture> {
  const texture = await new HDRLoader().loadAsync(url);
  texture.mapping = EquirectangularReflectionMapping;
  return texture;
}

function createRenderer(width: number, height: number, antialias: boolean): WebGLRenderer {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const renderer = new WebGLRenderer({ canvas, antialias, alpha: false, preserveDrawingBuffer: true, powerPreference: "high-performance" });
  renderer.setPixelRatio(1);
  renderer.setSize(width, height, false);
  renderer.outputColorSpace = SRGBColorSpace;
  return renderer;
}

function canvasToBlob(canvas: HTMLCanvasElement, format: "png" | "jpeg" = "png"): Promise<Blob> {
  return new Promise((resolve, reject) =>
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error("Image encoding failed"))),
      format === "png" ? "image/png" : "image/jpeg",
      0.85,
    ),
  );
}

/** Tone-mapped copy of a linear HDR texture to the canvas (used when denoising is off). */
function copyMaterial(map: Texture): ShaderMaterial {
  return new ShaderMaterial({
    uniforms: { map: { value: map } },
    depthTest: false,
    depthWrite: false,
    vertexShader: "varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }",
    fragmentShader: `uniform sampler2D map; varying vec2 vUv;
      void main() { vec4 c = texture2D(map, vUv); gl_FragColor = vec4(c.rgb, 1.0);
      #include <tonemapping_fragment>
      #include <colorspace_fragment>
      }`,
  });
}

/**
 * Path tracing with three-gpu-pathtracer on its own offscreen WebGL context: physically based light
 * transport (HDRI image-based lighting, area light, soft shadows, glossy reflections, glass
 * transmission), accumulated progressively, then denoised and tone mapped.
 */
export function createPathTracedBackend(initial: PhotoSettings, environment: Texture): PhotoBackend & { configure(settings: PhotoSettings): void } {
  let settings = initial;
  const renderer = createRenderer(settings.width, settings.height, false);
  const tracer = new WebGLPathTracer(renderer);
  tracer.renderToCanvas = false;
  tracer.rasterizeScene = false;
  tracer.renderDelay = 0;
  tracer.minSamples = 0;
  tracer.fadeDuration = 0;
  tracer.dynamicLowRes = false;
  // transmissiveBounces stays at the library default: lowering it (e.g. to 3) left ~17% of the pixels
  // permanently black on an Intel UHD 620 / ANGLE D3D11 (verified in isolation).
  tracer.multipleImportanceSampling = true;
  tracer.filterGlossyFactor = 0.4;
  // Tiles of at most ~150k pixels: one GPU step stays short (UI responsive, no GPU watchdog resets).
  const tiles = Math.max(1, Math.ceil(Math.sqrt((settings.width * settings.height) / 150_000)));
  tracer.tiles.set(tiles, tiles);
  const configure = (next: PhotoSettings) => {
    settings = next;
    renderer.toneMapping = TONE_MAPPING[next.toneMapping];
    renderer.toneMappingExposure = next.exposure;
    tracer.bounces = QUALITY_PRESETS[next.quality].bounces;
  };
  configure(initial);
  const probe = new Float32Array(4);
  // Present at runtime (parallel shader compilation), missing from the package's type declarations.
  const compiling = () => Boolean((tracer as unknown as { isCompiling?: boolean }).isCompiling);
  const denoise = new DenoiseMaterial({ map: tracer.target.texture, sigma: 2.5, kSigma: 1, threshold: 0.05 });
  const copy = copyMaterial(tracer.target.texture);
  const quad = new FullScreenQuad(denoise);

  return {
    mode: "pathtraced" as PhotoMode,
    get compiling() {
      return compiling();
    },
    configure,
    async setScene(scene: Scene, camera: PerspectiveCamera) {
      scene.environment = environment;
      tracer.setScene(scene, camera);
      tracer.reset();
    },
    step(budgetMs: number) {
      const target = QUALITY_PRESETS[settings.quality].samples;
      const started = performance.now();
      do {
        tracer.renderSample();
        // Waits for the GPU (1 pixel read), so one step never queues more work than its budget.
        renderer.readRenderTargetPixels(tracer.target, 0, 0, 1, 1, probe);
      } while (performance.now() - started < budgetMs && !compiling() && tracer.samples < target);
      return compiling() ? 0 : tracer.samples;
    },
    async output(format = "png") {
      const material = settings.denoise ? denoise : copy;
      // The accumulation target is re-created when the size changes: always read the current one.
      (material.uniforms.map as { value: Texture }).value = tracer.target.texture;
      quad.material = material;
      renderer.setRenderTarget(null);
      renderer.clear();
      quad.render(renderer);
      return canvasToBlob(renderer.domElement, format);
    },
    dispose() {
      denoise.dispose();
      copy.dispose();
      quad.dispose();
      tracer.dispose();
      renderer.dispose();
      renderer.forceContextLoss();
    },
  };
}

/**
 * Raster fallback, used only when path tracing is unavailable and always labelled as such: WebGL
 * rasterization with the same scene, materials and HDRI (prefiltered), a soft shadow map, and
 * supersampling. Not a photorealistic render.
 */
export function createRasterBackend(settings: PhotoSettings, environment: Texture): PhotoBackend {
  const factor = QUALITY_PRESETS[settings.quality].supersample;
  const renderer = createRenderer(settings.width * factor, settings.height * factor, true);
  renderer.toneMapping = TONE_MAPPING[settings.toneMapping];
  renderer.toneMappingExposure = settings.exposure;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = VSMShadowMap;
  RectAreaLightUniformsLib.init();
  const pmrem = new PMREMGenerator(renderer);
  const prefiltered = pmrem.fromEquirectangular(environment).texture;
  let current: { scene: Scene; camera: PerspectiveCamera } | null = null;

  return {
    mode: "raster" as PhotoMode,
    async setScene(scene: Scene, camera: PerspectiveCamera) {
      scene.environment = prefiltered;
      // A soft key light from above the front for contact shadows (area lights cast none in raster).
      const bounds = new Box3().setFromObject(scene);
      const center = bounds.getCenter(new Vector3());
      const size = bounds.getSize(new Vector3());
      const key = new DirectionalLight("#fffaf2", 1.1);
      key.position.set(center.x + size.x * 0.25, center.y + size.y * 2 + 3, center.z + size.z * 0.8 + 2);
      key.target.position.copy(center);
      key.castShadow = true;
      key.shadow.mapSize.set(4096, 4096);
      key.shadow.radius = 12;
      key.shadow.blurSamples = 24;
      key.shadow.bias = -0.0004;
      const half = Math.max(size.x, size.z) * 0.75 + 1;
      Object.assign(key.shadow.camera, { left: -half, right: half, top: half, bottom: -half, near: 0.1, far: 60 });
      scene.add(key, key.target);
      scene.updateMatrixWorld(true);
      current = { scene, camera };
    },
    step() {
      if (current) renderer.render(current.scene, current.camera);
      return 1;
    },
    async output(format = "png") {
      if (factor === 1) return canvasToBlob(renderer.domElement, format);
      // Downsample the supersampled frame to the requested size.
      const out = document.createElement("canvas");
      out.width = settings.width;
      out.height = settings.height;
      const ctx = out.getContext("2d");
      if (!ctx) throw new Error("2D canvas unavailable");
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = "high";
      ctx.drawImage(renderer.domElement, 0, 0, settings.width, settings.height);
      return canvasToBlob(out, format);
    },
    dispose() {
      prefiltered.dispose();
      pmrem.dispose();
      renderer.dispose();
      renderer.forceContextLoss();
    },
  };
}
