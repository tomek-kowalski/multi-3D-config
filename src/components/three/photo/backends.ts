"use client";

import { WebGLPathTracer } from "three-gpu-pathtracer";
import {
  ACESFilmicToneMapping,
  AgXToneMapping,
  Mesh,
  NeutralToneMapping,
  ShaderMaterial,
  SRGBColorSpace,
  WebGLRenderer,
  type DataTexture,
  type Material,
  type PerspectiveCamera,
  type Scene,
  type Texture,
  type ToneMapping,
} from "three";
import { FullScreenQuad } from "three/examples/jsm/postprocessing/Pass.js";
import { loadHdriSource } from "../materials/hdriSource";
import { traceLayerBudget, traceQualityProfile } from "../materials/materialQuality";
import type { PhotoMode } from "./capabilities";
import { sceneTextures } from "./photoScene";
import { GuidedDenoiser } from "./denoiser";
import { AutoExposure } from "./exposure";
import { createFastRasterBackend } from "./rasterBackend";
import { TraceBudgetError, type PhotoBackend } from "./photoEngine";
import { QUALITY_PRESETS, type PhotoSettings, type PhotoToneMapping } from "./photoSettings";

export { HDRI_URL } from "../materials/hdriSource";

const TONE_MAPPING: Record<PhotoToneMapping, ToneMapping> = {
  neutral: NeutralToneMapping,
  agx: AgXToneMapping,
  aces: ACESFilmicToneMapping,
};

/** The studio HDRI, decoded once and shared with the viewport's reflection environment. */
export function loadEnvironment(): Promise<DataTexture> {
  return loadHdriSource();
}

/**
 * Path-tracer texture budget: every distinct texture becomes one 1K RGBA8 layer (4 MiB). Over budget,
 * optional maps are left out of THIS VIEW in a fixed order, on per-view material copies (one copy per
 * material, returned for disposal): the snapshot's materials — and therefore a later fast-raster
 * fallback — are never degraded. If base colours alone exceed it, setScene throws TraceBudgetError and
 * the engine falls back to the fast renderer on a freshly built view (only where it is eligible). The
 * selected decor's colour image is never dropped.
 */
const OPTIONAL_MAP_ORDER = ["sheenRoughnessMap", "sheenColorMap", "clearcoatNormalMap", "metalnessMap", "roughnessMap", "normalMap"] as const;

export function fitTraceLayers(scene: Scene, maxLayers: number): { layers: number; dropped: string[]; copies: Material[] } {
  const dropped: string[] = [];
  const copies = new Map<Material, Material>();
  let layers = sceneTextures(scene).size;
  for (const key of OPTIONAL_MAP_ORDER) {
    if (layers <= maxLayers) break;
    let removed = false;
    scene.traverse((o) => {
      if (!(o instanceof Mesh)) return;
      const swap = (m: Material) => {
        if (!(m as unknown as Record<string, unknown>)[key]) return m;
        // Copy each material once (a copy already made for this view is reduced further in place).
        let copy = copies.get(m) ?? ([...copies.values()].includes(m) ? m : undefined);
        if (!copy) {
          copy = m.clone();
          copies.set(m, copy);
        }
        (copy as unknown as Record<string, unknown>)[key] = null;
        // A scalar calibrated against its map (finish / map mean) is wrong without it: restore the finish's.
        const scalars = copy.userData.scalarsWithoutMaps as { roughness: number; metalness: number } | undefined;
        if (scalars && key === "roughnessMap") (copy as unknown as { roughness: number }).roughness = scalars.roughness;
        if (scalars && key === "metalnessMap") (copy as unknown as { metalness: number }).metalness = scalars.metalness;
        copy.needsUpdate = true;
        removed = true;
        return copy;
      };
      o.material = Array.isArray(o.material) ? o.material.map(swap) : swap(o.material);
    });
    if (removed) dropped.push(key);
    layers = sceneTextures(scene).size;
  }
  return { layers, dropped, copies: [...copies.values()] };
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
  let traceLayers = 0;
  let reductions: string[] = [];
  /** Per-view material copies of the current view (optional maps left out); freed with the view. */
  let viewCopies: Material[] = [];
  const releaseView = () => {
    viewCopies.forEach((m) => m.dispose());
    viewCopies = [];
  };
  const gl = renderer.getContext() as WebGL2RenderingContext;
  const deviceLayers = Number(gl.getParameter(gl.MAX_ARRAY_TEXTURE_LAYERS)) || 0;

  return {
    mode: "pathtraced" as PhotoMode,
    get exposure() {
      return exposure;
    },
    get compiling() {
      return compiling();
    },
    /** Distinct texture layers of the current view (instrumentation). */
    get traceLayers() {
      return traceLayers;
    },
    /** Optional maps left out of the current view to meet the layer budget. */
    get reductions() {
      return reductions;
    },
    configure,
    async setScene(scene: Scene, camera: PerspectiveCamera) {
      scene.environment = environment;
      releaseView();
      const budget = traceLayerBudget(traceQualityProfile(settings.quality), deviceLayers);
      const fit = fitTraceLayers(scene, budget);
      viewCopies = fit.copies;
      traceLayers = fit.layers;
      reductions = fit.dropped;
      if (fit.layers > budget) {
        releaseView();
        throw new TraceBudgetError(fit.layers, budget);
      }
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
      releaseView();
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
