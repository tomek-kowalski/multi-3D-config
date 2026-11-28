/**
 * Settings of the photorealistic renderer. Everything that influences an image is in PhotoSettings,
 * so the settings are stored with every quotation rendering and identical settings + identical
 * configuration give a reusable result (see photoService.ts).
 */

/**
 * fast: photorealistic rasterization (seconds; rasterBackend.ts). standard/high: path tracing (minutes on
 * integrated GPUs). "auto" (a request only) is resolved per device from measured performance.
 */
export type PhotoQuality = "fast" | "standard" | "high";
export const PHOTO_QUALITIES: readonly PhotoQuality[] = ["fast", "standard", "high"];
export type PhotoQualityRequest = PhotoQuality | "auto";

import { materialRegistry } from "@/domain/materials";
import { PHOTO_PROFILE } from "../materials/materialQuality";

/**
 * Part of every cache key: completed renders of an older renderer are never reused.
 * 4: universal material system (shared PBR factory, frozen slot bindings, environment-lit finishes).
 * 5: window exteriors, room reflections for metals, turned knobs, door undercut (Phase 4AB visual corrections).
 * Bump it whenever photo rendering *code* changes. Tunable constants (lighting, exterior, reflections,
 * presets) are covered automatically by RENDERING_FINGERPRINT; materials and textures by the registry
 * revision (photoService.photoCacheKey).
 */
export const RENDERER_VERSION = 5;

export interface QualityPreset {
  /** Path-traced samples per pixel (fast: rasterized frames) to accumulate. */
  readonly samples: number;
  /** Fewer samples than this (time limit hit first) is too noisy: the render fails instead. */
  readonly minSamples: number;
  /** Diffuse/specular light bounces. */
  readonly bounces: number;
  /** Sampling time limit for one image, in seconds (counted from the first sample; compilation excluded). */
  readonly maxSeconds: number;
}

export const QUALITY_PRESETS: Readonly<Record<PhotoQuality, QualityPreset>> = {
  fast: { samples: 96, minSamples: 24, bounces: 0, maxSeconds: 30 },
  standard: { samples: 192, minSamples: 32, bounces: 4, maxSeconds: 150 },
  high: { samples: 640, minSamples: 96, bounces: 6, maxSeconds: 420 },
};

/**
 * Tone mapping: Khronos PBR Neutral keeps base colours (the selected decors and wall colours)
 * faithful up to the highlights, unlike ACES/AgX which shift hue and saturation.
 */
export type PhotoToneMapping = "neutral" | "agx" | "aces";

export interface PhotoSettings {
  readonly width: number;
  readonly height: number;
  readonly quality: PhotoQuality;
  readonly toneMapping: PhotoToneMapping;
  readonly exposure: number;
  readonly denoise: boolean;
  /** Use the raster renderer when path tracing is not available (the result is labelled as such). */
  readonly allowRasterFallback: boolean;
  /** Free space between the furniture and the image border (fraction of the half-frame, 0–0.3). */
  readonly frameMargin: number;
}

export const DEFAULT_PHOTO_SETTINGS: PhotoSettings = {
  width: 1920,
  height: 1080,
  quality: "fast",
  toneMapping: "neutral",
  exposure: 1,
  denoise: true,
  allowRasterFallback: true,
  frameMargin: 0.1,
};

export const MAX_PHOTO_SIZE = 4096;

export function resolvePhotoSettings(overrides: Partial<PhotoSettings> = {}): PhotoSettings {
  const s = { ...DEFAULT_PHOTO_SETTINGS, ...overrides };
  const size = (v: number) => Math.round(Math.min(MAX_PHOTO_SIZE, Math.max(64, Number.isFinite(v) ? v : 64)));
  return {
    ...s,
    width: size(s.width),
    height: size(s.height),
    quality: PHOTO_QUALITIES.includes(s.quality) ? s.quality : DEFAULT_PHOTO_SETTINGS.quality,
    exposure: Number.isFinite(s.exposure) && s.exposure > 0 ? s.exposure : 1,
    frameMargin: Number.isFinite(s.frameMargin) ? Math.min(0.3, Math.max(0, s.frameMargin)) : DEFAULT_PHOTO_SETTINGS.frameMargin,
  };
}

/** Stable key of the settings (part of the reuse key of a rendering). */
export function settingsKey(s: PhotoSettings): string {
  // The material catalog revision and quality policy are part of the identity: an appearance change
  // invalidates every cached rendering it affects.
  return [
    RENDERER_VERSION,
    materialRegistry.revision,
    PHOTO_PROFILE.id,
    s.width,
    s.height,
    s.quality,
    s.toneMapping,
    s.exposure,
    s.denoise ? 1 : 0,
    s.allowRasterFallback ? 1 : 0,
    s.frameMargin,
  ].join("|");
}
