import type { PerspectiveCamera, Scene } from "three";
import type { WallId } from "@/domain/room/types";
import type { GpuChoice, PhotoMode } from "./capabilities";
import type { PhotoCamera, PhotoViewId, PlannedView } from "./photoCamera";
import { QUALITY_PRESETS, type PhotoSettings } from "./photoSettings";

/**
 * A rendering backend on its own WebGL context (never the live configurator canvas):
 * - "pathtraced": three-gpu-pathtracer, progressive samples, denoised output;
 * - "raster": the clearly labelled fallback (WebGL rasterization with environment lighting and soft
 *   shadow maps, supersampled). It is never presented as path-traced.
 */
export interface PhotoBackend {
  readonly mode: PhotoMode;
  /** Prepares the scene for a view (BVH, materials, textures). May throw: the GPU could not do it. */
  setScene(scene: Scene, camera: PerspectiveCamera): Promise<void>;
  /** Renders for about `budgetMs` and returns the samples accumulated for the current view. */
  step(budgetMs: number): number;
  /** Exposure factor the last output used (highlight protection, ≤ 1), if the backend meters it. */
  readonly exposure?: number;
  /** True while the GPU is still compiling the renderer's shaders (no samples yet). */
  readonly compiling?: boolean;
  /**
   * Fraction of pixels of the accumulated image that are invalid (NaN, infinite or exactly black), or
   * undefined when the backend cannot tell. Checked before an image is accepted.
   */
  invalidFraction?(): number;
  /** The image of the current view, tone mapped (and denoised): PNG for the result, JPEG for previews. */
  output(format?: "png" | "jpeg"): Promise<Blob>;
  dispose(): void;
}

export interface RenderedPhoto {
  readonly viewId: PhotoViewId;
  readonly blob: Blob;
  readonly width: number;
  readonly height: number;
  readonly mode: PhotoMode;
  /** Samples per pixel actually accumulated (raster: 1). */
  readonly samples: number;
  readonly targetSamples: number;
  readonly durationMs: number;
  readonly camera: PhotoCamera;
  readonly hiddenWalls: readonly WallId[];
  readonly settings: PhotoSettings;
  /** Why the raster fallback was used, when it was. */
  readonly fallbackReason: string | null;
  /** Measured stage durations in ms (see PhotoTimings). */
  readonly timings: PhotoTimings;
}

/**
 * Where the time of one image went, measured:
 * - setScene: scene upload (path tracer: BVH construction, material and texture packing);
 * - firstSample: from the end of setScene to the first accumulated sample (shader compilation);
 * - sampling: accumulating samples (path tracer) or frames (raster);
 * - output: denoising, tone mapping and PNG encoding;
 * - job-level stages (snapshot, textures, environment, …) are added by the photo job.
 */
export type PhotoTimings = Readonly<Record<string, number>>;

export interface PhotoProgress {
  readonly phase: "preparing" | "compiling" | "rendering" | "finishing";
  /** 0-based index of the view being rendered and the number of views. */
  readonly view: number;
  readonly views: number;
  readonly samples: number;
  readonly targetSamples: number;
  readonly mode: PhotoMode;
  /** Overall progress 0–1. */
  readonly fraction: number;
}

export type PhotoErrorCode = "cancelled" | "unsupported" | "insufficient_samples" | "models_loading" | "busy" | "failed";

export class PhotoRenderError extends Error {
  constructor(
    readonly code: PhotoErrorCode,
    message: string = code,
  ) {
    super(message);
    this.name = "PhotoRenderError";
  }
}

export interface PhotoEngineDeps {
  readonly choice: GpuChoice;
  createBackend(mode: PhotoMode, settings: PhotoSettings): PhotoBackend;
  /** Scene and camera of one view (built from the snapshot); `dispose` frees what belongs to the view. */
  buildView(view: PlannedView): { scene: Scene; camera: PerspectiveCamera; dispose?: () => void };
  now(): number;
  /** Yields to the browser between steps (keeps the page responsive, lets cancellation in). */
  nextFrame(): Promise<void>;
}

export interface PhotoRunOptions {
  readonly signal?: AbortSignal;
  readonly onProgress?: (progress: PhotoProgress) => void;
  /** The image so far (path tracing converging), every few seconds: shown while the customer waits. */
  readonly onPreview?: (view: number, image: Blob) => void;
}

/** GPU time per step: short enough to keep the UI responsive. */
const STEP_BUDGET_MS = 40;
/**
 * Shader compilation and BVH upload must produce a first sample within this time (the path tracer's
 * shader is large: integrated GPUs need up to a minute or more on first use).
 */
export const COMPILE_TIMEOUT_MS = 180_000;
const PREVIEW_INTERVAL_MS = 6_000;
const RASTER_PREVIEW_INTERVAL_MS = 800;
/** More invalid pixels than this means the GPU computed garbage (e.g. driver bugs): never delivered. */
export const MAX_INVALID_FRACTION = 0.01;

/** The backend itself failed (GPU/driver), as opposed to a cancellation or too few samples. */
class BackendFailure extends Error {
  constructor(readonly cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause));
  }
}

function checkAbort(signal?: AbortSignal) {
  if (signal?.aborted) throw new PhotoRenderError("cancelled");
}

/**
 * Renders the planned views one after another on a single backend, then disposes it — always, also on
 * failure or cancellation. The quality's time limit counts sampling time (from the first sample);
 * compilation has its own limit. A path-traced image below the quality's minimum samples is an error,
 * never a result. When the GPU cannot run the path tracer, the raster fallback is used if the settings
 * allow it, and the result says so.
 */
export async function renderPhotoViews(
  views: readonly PlannedView[],
  settings: PhotoSettings,
  deps: PhotoEngineDeps,
  options: PhotoRunOptions = {},
): Promise<RenderedPhoto[]> {
  const { signal, onProgress, onPreview } = options;
  if (deps.choice.mode === "unsupported") throw new PhotoRenderError("unsupported");
  // "fast" is rasterized by choice; standard/high are path traced where the GPU can (else the labelled fallback).
  const wantsPathTracing = settings.quality !== "fast";
  if (wantsPathTracing && deps.choice.mode === "raster" && !settings.allowRasterFallback) throw new PhotoRenderError("unsupported");

  let mode: PhotoMode = wantsPathTracing ? deps.choice.mode : "raster";
  let fallbackReason: string | null = wantsPathTracing ? deps.choice.reason : null;
  /** The preset of the backend actually rendering (a raster fallback uses the fast preset). */
  const presetFor = () => QUALITY_PRESETS[mode === "pathtraced" ? settings.quality : "fast"];
  let backend: PhotoBackend | null = null;
  const results: RenderedPhoto[] = [];

  const target = () => presetFor().samples;
  const report = (phase: PhotoProgress["phase"], view: number, samples: number) => {
    const perView = Math.min(1, samples / target());
    const done = phase === "finishing" ? 1 : phase === "rendering" ? perView * 0.97 : 0;
    onProgress?.({ phase, view, views: views.length, samples, targetSamples: target(), mode, fraction: (view + done) / views.length });
  };

  /** Sets the view's scene and accumulates samples until the target or the time limit. */
  let stage: Record<string, number> = {};
  const accumulate = async (b: PhotoBackend, built: { scene: Scene; camera: PerspectiveCamera }, index: number) => {
    const sceneStarted = deps.now();
    try {
      await b.setScene(built.scene, built.camera);
    } catch (error) {
      throw new BackendFailure(error);
    }
    const setupStarted = deps.now();
    stage = { setScene: Math.round(setupStarted - sceneStarted) };
    let samplingStarted: number | null = null;
    let lastPreview = setupStarted;
    let previews = 0;
    let samples = 0;
    while (samples < target()) {
      checkAbort(signal);
      try {
        samples = b.step(STEP_BUDGET_MS);
      } catch (error) {
        throw new BackendFailure(error);
      }
      const now = deps.now();
      if (samples > 0 && samplingStarted === null) {
        samplingStarted = now;
        stage.firstSample = Math.round(now - setupStarted);
      }
      report(samples === 0 && b.compiling ? "compiling" : "rendering", index, samples);
      if (samplingStarted !== null && now - samplingStarted >= presetFor().maxSeconds * 1000) break;
      // Shaders that never finish compiling (driver failure) leave the path tracer at zero samples.
      if (samplingStarted === null && now - setupStarted > COMPILE_TIMEOUT_MS) throw new BackendFailure("no samples");
      // Fast renderer: a usable preview after a few frames, then often; path tracing: every few seconds.
      const interval = mode === "raster" ? RASTER_PREVIEW_INTERVAL_MS : PREVIEW_INTERVAL_MS;
      // The fast renderer's first frame is already a complete image: shown at once, then refreshed.
      const first = mode === "raster" && previews === 0 && samples >= 1;
      if (onPreview && samples >= 1 && samples < target() && (first || now - lastPreview >= interval)) {
        previews++;
        lastPreview = now;
        onPreview(index, await b.output("jpeg"));
      }
      await deps.nextFrame();
    }
    const invalid = b.invalidFraction?.();
    if (invalid !== undefined && invalid > MAX_INVALID_FRACTION) throw new BackendFailure(`invalid pixels: ${(invalid * 100).toFixed(1)}%`);
    stage.sampling = Math.round(deps.now() - (samplingStarted ?? setupStarted));
    return samples;
  };

  try {
    checkAbort(signal);
    backend = deps.createBackend(mode, settings);
    for (let index = 0; index < views.length; index++) {
      const view = views[index];
      checkAbort(signal);
      report("preparing", index, 0);
      const built = deps.buildView(view);
      try {
        const started = deps.now();
        let samples: number;
        try {
          samples = await accumulate(backend, built, index);
        } catch (error) {
          if (!(error instanceof BackendFailure) || mode !== "pathtraced" || !settings.allowRasterFallback) throw error;
          // The GPU could not compile, hold or run the path tracer: switch to the labelled raster fallback.
          backend.dispose();
          mode = "raster";
          fallbackReason = "pathtracer_failed";
          backend = deps.createBackend(mode, settings);
          samples = await accumulate(backend, built, index);
        }
        checkAbort(signal);
        if (samples < presetFor().minSamples) {
          throw new PhotoRenderError("insufficient_samples", `${Math.floor(samples)} of ${presetFor().minSamples} samples`);
        }
        report("finishing", index, samples);
        const outputStarted = deps.now();
        const blob = await backend.output("png");
        stage.output = Math.round(deps.now() - outputStarted);
        if (backend.exposure !== undefined) stage.exposurePercent = Math.round(backend.exposure * 100);
        results.push({
          viewId: view.id,
          blob,
          width: settings.width,
          height: settings.height,
          mode,
          samples: Math.floor(samples),
          targetSamples: target(),
          durationMs: Math.round(deps.now() - started),
          camera: view.camera,
          hiddenWalls: view.hiddenWalls,
          settings,
          fallbackReason: mode === "raster" && wantsPathTracing ? fallbackReason : null,
          timings: { ...stage },
        });
      } finally {
        built.dispose?.();
      }
    }
    return results;
  } catch (error) {
    if (error instanceof PhotoRenderError) throw error;
    if (error instanceof BackendFailure) throw new PhotoRenderError("failed", error.message);
    throw new PhotoRenderError("failed", error instanceof Error ? error.message : String(error));
  } finally {
    backend?.dispose();
  }
}
