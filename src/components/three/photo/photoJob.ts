import type { PerspectiveCamera, Scene, Texture } from "three";
import type { Arrangement } from "@/domain/arrangement/types";
import type { GpuChoice, PhotoMode } from "./capabilities";
import { planPhotoViews, toThreeCamera } from "./photoCamera";
import { PhotoRenderError, renderPhotoViews, type PhotoBackend, type RenderedPhoto } from "./photoEngine";
import { buildPhotoScene, type SceneSnapshot } from "./photoScene";
import { cachedPhoto, configurationKey, photoCacheKey, storePhoto, type PhotoRequest } from "./photoService";
import { resolvePhotoSettings, type PhotoSettings } from "./photoSettings";

/** What a photo request needs from the app and the browser (injected, so it is testable without a GPU). */
export interface PhotoJobDeps {
  /** The current configuration and a snapshot of the live scene, taken together (same moment). */
  capture(): { arrangement: Arrangement; snapshot: SceneSnapshot };
  choice(): GpuChoice;
  loadEnvironment(): Promise<Texture>;
  /** Swaps decor previews for HD images in the snapshot (failures keep the preview images). */
  upgradeTextures(snapshot: SceneSnapshot): Promise<unknown>;
  createBackend(mode: PhotoMode, settings: PhotoSettings, environment: Texture): PhotoBackend;
  now(): number;
  nextFrame(): Promise<void>;
  sleep(ms: number): Promise<void>;
}

/** How long a photo waits for furniture models that are still loading. */
export const MODEL_WAIT_MS = 20_000;
const MODEL_POLL_MS = 250;

let running = false;

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
    const settings = resolvePhotoSettings(request.settings);
    let captured = deps.capture();
    // Furniture models still loading: wait for them (never render a placeholder box).
    const waitUntil = deps.now() + MODEL_WAIT_MS;
    while (captured.snapshot.loading > 0) {
      captured.snapshot.dispose();
      if (request.signal?.aborted) throw new PhotoRenderError("cancelled");
      if (deps.now() >= waitUntil) throw new PhotoRenderError("models_loading");
      await deps.sleep(MODEL_POLL_MS);
      captured = deps.capture();
    }
    snapshot = captured.snapshot;
    const { arrangement } = captured;
    const fb = snapshot.furnitureBounds;
    const drawn = fb.isEmpty() ? null : { min: fb.min.toArray() as [number, number, number], max: fb.max.toArray() as [number, number, number] };
    const views = planPhotoViews(arrangement, request.count, settings.width / settings.height, { drawn, margin: settings.frameMargin });
    const configuration = configurationKey(arrangement);
    const keys = views.map((v) => photoCacheKey(configuration, settings, v.id));
    const reused = keys.map((k) => (request.reuse === false ? undefined : cachedPhoto(k)));
    const missing = views.filter((_, i) => !reused[i]);
    if (missing.length === 0) return reused as RenderedPhoto[];

    const choice = deps.choice();
    const [environment] = await Promise.all([deps.loadEnvironment(), deps.upgradeTextures(snapshot)]);
    if (request.signal?.aborted) throw new PhotoRenderError("cancelled");
    const frozen = snapshot;
    const rendered = await renderPhotoViews(
      missing,
      settings,
      {
        choice,
        createBackend: (mode, s) => deps.createBackend(mode, s, environment),
        buildView: (view): { scene: Scene; camera: PerspectiveCamera } => ({
          scene: buildPhotoScene(frozen, view.hiddenWalls, environment),
          camera: toThreeCamera(view.camera),
        }),
        now: deps.now,
        nextFrame: deps.nextFrame,
      },
      { signal: request.signal, onProgress: request.onProgress, onPreview: request.onPreview },
    );
    rendered.forEach((photo) => storePhoto(photoCacheKey(configuration, settings, photo.viewId), photo));
    let next = 0;
    return reused.map((photo) => photo ?? rendered[next++]);
  } finally {
    snapshot?.dispose();
    running = false;
  }
}
