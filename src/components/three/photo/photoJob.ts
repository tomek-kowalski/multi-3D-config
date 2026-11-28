import type { PerspectiveCamera, Scene, Texture } from "three";
import type { Arrangement } from "@/domain/arrangement/types";
import type { GpuChoice, PhotoMode } from "./capabilities";
import { planPhotoViews, toThreeCamera } from "./photoCamera";
import { PhotoRenderError, renderPhotoViews, type PhotoBackend, type RenderedPhoto } from "./photoEngine";
import { buildPhotoScene, type AppearanceDiagnostics, type SceneSnapshot } from "./photoScene";
import { cachedPhoto, configurationKey, photoCacheEnabled, photoCacheKey, storePhoto, type PhotoRequest } from "./photoService";
import { resolvePhotoSettings, type PhotoQuality, type PhotoSettings } from "./photoSettings";

/** What a photo request needs from the app and the browser (injected, so it is testable without a GPU). */
export interface PhotoJobDeps {
  /** The current configuration and a snapshot of the live scene, taken together (same moment). */
  capture(): { arrangement: Arrangement; snapshot: SceneSnapshot };
  choice(): GpuChoice;
  /** The quality "auto" stands for on this device (measured performance). */
  autoQuality(): PhotoQuality;
  /** Records the measured performance of a finished render. */
  recordPerformance?(photo: RenderedPhoto): void;
  loadEnvironment(): Promise<Texture>;
  /**
   * Waits until the snapshot's materials are complete (all textures of the frozen appearance applied
   * or definitively failed): a photo never renders a half-loaded or previous appearance.
   */
  prepareMaterials(snapshot: SceneSnapshot): Promise<unknown>;
  /**
   * Adds the visible note to an image showing unavailable manufacturer appearances or decor images that
   * failed to load (in the current language: applied when the image is returned, never cached).
   */
  annotate?(image: Blob, appearance: AppearanceDiagnostics): Promise<Blob>;
  createBackend(mode: PhotoMode, settings: PhotoSettings, environment: Texture): PhotoBackend;
  now(): number;
  nextFrame(): Promise<void>;
  sleep(ms: number): Promise<void>;
}

/** How long a photo waits for furniture models that are still loading. */
export const MODEL_WAIT_MS = 20_000;
const MODEL_POLL_MS = 250;

let running = false;

/** Whether an image must carry the appearance note. */
export function needsAnnotation(appearance: AppearanceDiagnostics | undefined): boolean {
  return !!appearance && (appearance.unavailable.length > 0 || appearance.failed.length > 0);
}

/** Rejects with "cancelled" as soon as the signal aborts (the awaited work itself keeps running). */
function abortable<T>(work: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return work;
  if (signal.aborted) return Promise.reject(new PhotoRenderError("cancelled"));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new PhotoRenderError("cancelled"));
    signal.addEventListener("abort", onAbort, { once: true });
    work.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

export function isPhotoJobRunning(): boolean {
  return running;
}

/**
 * One photo request: snapshot the configuration once, reuse identical completed renderings, render the
 * missing views from that one snapshot (so all images show the same configuration), free everything.
 * Only one request runs at a time (one GPU job; a second request gets "busy").
 */
export async function runPhotoJob(request: PhotoRequest, deps: PhotoJobDeps): Promise<RenderedPhoto[]> {
  if (running) throw new PhotoRenderError("busy");
  running = true;
  let snapshot: SceneSnapshot | null = null;
  try {
    const requested = request.settings?.quality ?? "auto";
    const choice = deps.choice();
    let quality: PhotoQuality = requested === "auto" ? deps.autoQuality() : requested;
    // The fast renderer is offered only where its render targets work; such a device path traces instead.
    if (quality === "fast" && !choice.rasterEligible && choice.mode === "pathtraced") quality = "standard";
    const settings = resolvePhotoSettings({ ...request.settings, quality });
    const jobStarted = deps.now();
    let captured = deps.capture();
    let snapshotMs = deps.now() - jobStarted;
    // Furniture models still loading: wait for them (never render a placeholder box).
    const waitUntil = deps.now() + MODEL_WAIT_MS;
    while (captured.snapshot.loading > 0) {
      captured.snapshot.dispose();
      if (request.signal?.aborted) throw new PhotoRenderError("cancelled");
      if (deps.now() >= waitUntil) throw new PhotoRenderError("models_loading");
      await deps.sleep(MODEL_POLL_MS);
      const t = deps.now();
      captured = deps.capture();
      snapshotMs = deps.now() - t;
    }
    snapshot = captured.snapshot;
    const { arrangement } = captured;
    const fb = snapshot.furnitureBounds;
    const drawn = fb.isEmpty() ? null : { min: fb.min.toArray() as [number, number, number], max: fb.max.toArray() as [number, number, number] };
    const views = planPhotoViews(arrangement, request.count, settings.width / settings.height, { drawn, margin: settings.frameMargin });
    const configuration = configurationKey(arrangement);
    const keys = views.map((v) => photoCacheKey(configuration, settings, v.id));
    const reuse = request.reuse !== false && photoCacheEnabled();
    const reused = keys.map((k) => (reuse ? cachedPhoto(k) : undefined));
    const missing = views.filter((_, i) => !reused[i]);
    const signal = request.signal;
    /** The note is added at return time (current language); the cache keeps the plain image. */
    const publish = async (photo: RenderedPhoto): Promise<RenderedPhoto> => {
      if (!needsAnnotation(photo.appearance) || !deps.annotate) return photo;
      const blob = await abortable(deps.annotate(photo.blob, photo.appearance!), signal);
      return { ...photo, blob };
    };
    if (missing.length === 0) {
      const published = await Promise.all((reused as RenderedPhoto[]).map(publish));
      if (signal?.aborted) throw new PhotoRenderError("cancelled");
      return published;
    }

    const prepareStarted = deps.now();
    let materialsMs = 0;
    // Cancellable: a cancelled request stops waiting at once. The shared image loads continue for
    // their other consumers; this snapshot's leases are released by dispose() below.
    const [environment] = await abortable(
      Promise.all([deps.loadEnvironment(), deps.prepareMaterials(snapshot).then(() => (materialsMs = deps.now() - prepareStarted))]),
      signal,
    );
    const prepareMs = deps.now() - prepareStarted;
    const appearance = snapshot.diagnostics();
    const textureStats = snapshot.textureStats();
    if (signal?.aborted) throw new PhotoRenderError("cancelled");
    const frozen = snapshot;
    const renderedRaw = await renderPhotoViews(
      missing,
      settings,
      {
        choice,
        createBackend: (mode, s) => deps.createBackend(mode, s, environment),
        buildView: (view): { scene: Scene; camera: PerspectiveCamera } => {
          const camera = toThreeCamera(view.camera);
          return { scene: buildPhotoScene(frozen, view.hiddenWalls, environment, undefined, camera), camera };
        },
        now: deps.now,
        nextFrame: deps.nextFrame,
      },
      { signal: request.signal, onProgress: request.onProgress, onPreview: request.onPreview },
    );
    // Job-level stages: snapshot (scene copy), prepare (HDRI + material textures), materials (texture
    // readiness alone), total of the request; and the snapshot's material texture residency.
    const jobTimings = {
      snapshot: Math.round(snapshotMs),
      prepare: Math.round(prepareMs),
      materials: Math.round(materialsMs),
      textures: textureStats.textures,
      textureKiB: Math.round(textureStats.residentBytes / 1024),
      job: Math.round(deps.now() - jobStarted),
    };
    // A cancelled job never caches or publishes anything.
    if (signal?.aborted) throw new PhotoRenderError("cancelled");
    const rendered = renderedRaw.map((photo) => ({ ...photo, appearance, timings: { ...photo.timings, ...jobTimings } }));
    let next = 0;
    const results = reused.map((photo) => photo ?? rendered[next++]);
    const published = await Promise.all(results.map(publish));
    if (signal?.aborted) throw new PhotoRenderError("cancelled");
    rendered.forEach((photo) => deps.recordPerformance?.(photo));
    if (photoCacheEnabled()) rendered.forEach((photo) => storePhoto(photoCacheKey(configuration, settings, photo.viewId), photo));
    return published;
  } finally {
    snapshot?.dispose();
    running = false;
  }
}
