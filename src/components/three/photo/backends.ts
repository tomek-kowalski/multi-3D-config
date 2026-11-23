"use client";

import { WebGLPathTracer } from "three-gpu-pathtracer";
import {
  ACESFilmicToneMapping,
  AgXToneMapping,
  EquirectangularReflectionMapping,
  NeutralToneMapping,
  ShaderMaterial,
  SRGBColorSpace,
  WebGLRenderer,
  type DataTexture,
  type PerspectiveCamera,
  type Scene,
  type Texture,
  type ToneMapping,
} from "three";
import { HDRLoader } from "three/examples/jsm/loaders/HDRLoader.js";
import { FullScreenQuad } from "three/examples/jsm/postprocessing/Pass.js";
import type { PhotoMode } from "./capabilities";
import { GuidedDenoiser } from "./denoiser";
import { AutoExposure } from "./exposure";
import { createFastRasterBackend } from "./rasterBackend";
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
 * transmission), accumulated progressively, then denoised (GuidedDenoiser: lighting only, textures
 * and edges untouched) and tone mapped.
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
  const denoiser = new GuidedDenoiser(renderer);
  const metering = new AutoExposure(renderer);
  let exposure = 1;
  const copy = copyMaterial(tracer.target.texture);
  const quad = new FullScreenQuad(copy);

  return {
    mode: "pathtraced" as PhotoMode,
    get exposure() {
      return exposure;
    },
    get compiling() {
      return compiling();
    },
    configure,
    async setScene(scene: Scene, camera: PerspectiveCamera) {
      scene.environment = environment;
      tracer.setScene(scene, camera);
      tracer.reset();
      // Guide buffers (albedo, normals, positions) of exactly this view, for the denoiser.
      denoiser.prepare(scene, camera, settings.width, settings.height);
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
    invalidFraction() {
      const target = tracer.target;
      const { width, height } = target;
      const pixels = new Float32Array(width * height * 4);
      renderer.readRenderTargetPixels(target, 0, 0, width, height, pixels);
      let invalid = 0;
      for (let i = 0; i < pixels.length; i += 4) {
        const sum = pixels[i] + pixels[i + 1] + pixels[i + 2];
        if (!Number.isFinite(sum) || sum === 0) invalid++;
      }
      return invalid / (width * height);
    },
    async output(format = "png") {
      // The final accumulated image (the accumulation target is re-created on resize: read the current one).
      const radiance = tracer.target.texture;
      const image = settings.denoise ? denoiser.denoise(radiance) : radiance;
      // Highlight protection, as in the fast renderer (same metering, same scene: same exposure).
      exposure = metering.measure(image, denoiser.surfaceMask);
      renderer.toneMappingExposure = settings.exposure * exposure;
      copy.uniforms.map.value = image;
      renderer.setRenderTarget(null);
      renderer.clear();
      quad.render(renderer);
      return canvasToBlob(renderer.domElement, format);
    },
    dispose() {
      denoiser.dispose();
      metering.dispose();
      copy.dispose();
      quad.dispose();
      tracer.dispose();
      renderer.dispose();
      renderer.forceContextLoss();
    },
  };
}

/** Fast photorealistic rasterization (see rasterBackend.ts); also the fallback when path tracing is unavailable. */
export function createRasterBackend(settings: PhotoSettings, environment: Texture) {
  return createFastRasterBackend(settings, environment, (s) => TONE_MAPPING[s.toneMapping]);
}
