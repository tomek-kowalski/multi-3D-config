import type { Arrangement } from "@/domain/arrangement/types";
import { toArrangementDocument } from "@/domain/serialization/arrangementJson";
import type { PhotoMode } from "./capabilities";
import type { PhotoProgress, RenderedPhoto } from "./photoEngine";
import type { PhotoViewId } from "./photoCamera";
import { settingsKey, type PhotoSettings } from "./photoSettings";

export interface PhotoRequest {
  /** Number of views (1–3): front-right, front-left, front. */
  readonly count: 1 | 2 | 3;
  readonly settings?: Partial<PhotoSettings>;
  readonly signal?: AbortSignal;
  readonly onProgress?: (progress: PhotoProgress) => void;
  /** The converging image while path tracing (JPEG, every few seconds). */
  readonly onPreview?: (view: number, image: Blob) => void;
  /** false: render again even if an identical rendering exists ("Renderuj ponownie"). */
  readonly reuse?: boolean;
}

/** Renders photos of the current configuration; registered by the mounted 3D view. */
export type PhotoRenderer = (request: PhotoRequest) => Promise<RenderedPhoto[]>;

let active: PhotoRenderer | null = null;

export function registerPhotoRenderer(renderer: PhotoRenderer | null): void {
  active = renderer;
}

export function getPhotoRenderer(): PhotoRenderer | null {
  return active;
}

/**
 * What is stored with a quotation about each rendering: enough to know how it was made and to
 * reproduce the view (camera, hidden walls, settings), but not the image itself.
 */
export interface RenderingMetadata {
  readonly view: PhotoViewId;
  readonly mode: PhotoMode;
  readonly samples: number;
  readonly targetSamples: number;
  readonly width: number;
  readonly height: number;
  readonly durationMs: number;
  readonly camera: { readonly position: readonly number[]; readonly target: readonly number[]; readonly fov: number };
  readonly hiddenWalls: readonly string[];
  readonly settings: PhotoSettings;
  readonly fallbackReason: string | null;
}

export function renderingMetadata(photo: RenderedPhoto): RenderingMetadata {
  const round = (v: number) => Math.round(v * 1000) / 1000;
  return {
    view: photo.viewId,
    mode: photo.mode,
    samples: photo.samples,
    targetSamples: photo.targetSamples,
    width: photo.width,
    height: photo.height,
    durationMs: photo.durationMs,
    camera: { position: photo.camera.position.map(round), target: photo.camera.target.map(round), fov: photo.camera.fov },
    hiddenWalls: [...photo.hiddenWalls],
    settings: photo.settings,
    fallbackReason: photo.fallbackReason,
  };
}

/**
 * Completed renderings by configuration + settings + view, so the same image is not rendered twice
 * (e.g. the preview and then the quotation). Bounded: PNGs at 1920×1080 take a few MB each.
 */
const MAX_CACHED = 9;
const cache = new Map<string, RenderedPhoto>();

export function configurationKey(arrangement: Arrangement): string {
  return JSON.stringify(toArrangementDocument(arrangement));
}

export function photoCacheKey(configuration: string, settings: PhotoSettings, view: PhotoViewId): string {
  return `${configuration}#${settingsKey(settings)}#${view}`;
}

export function cachedPhoto(key: string): RenderedPhoto | undefined {
  const photo = cache.get(key);
  if (photo) {
    cache.delete(key);
    cache.set(key, photo);
  }
  return photo;
}

export function storePhoto(key: string, photo: RenderedPhoto): void {
  cache.delete(key);
  cache.set(key, photo);
  while (cache.size > MAX_CACHED) cache.delete(cache.keys().next().value as string);
}

export function clearPhotoCache(): void {
  cache.clear();
}
