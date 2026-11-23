/**
 * Settings of the photorealistic renderer. Everything that influences an image is in PhotoSettings,
 * so the settings are stored with every quotation rendering and identical settings + identical
 * configuration give a reusable result (see photoService.ts).
 */

export type PhotoQuality = "draft" | "standard" | "high";
export const PHOTO_QUALITIES: readonly PhotoQuality[] = ["draft", "standard", "high"];

export interface QualityPreset {
  /** Path-traced samples per pixel to accumulate. */
  readonly samples: number;
  /** Fewer samples than this (time limit hit first) is too noisy: the render fails instead. */
  readonly minSamples: number;
  /** Diffuse/specular light bounces. */
  readonly bounces: number;
  /** Sampling time limit for one image, in seconds (counted from the first sample; compilation excluded). */
  readonly maxSeconds: number;
  /** Raster fallback: supersampling factor per axis. */
  readonly supersample: number;
}

export const QUALITY_PRESETS: Readonly<Record<PhotoQuality, QualityPreset>> = {
  draft: { samples: 48, minSamples: 12, bounces: 3, maxSeconds: 60, supersample: 1 },
  standard: { samples: 192, minSamples: 32, bounces: 4, maxSeconds: 150, supersample: 2 },
  high: { samples: 640, minSamples: 96, bounces: 6, maxSeconds: 420, supersample: 2 },
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
}

export const DEFAULT_PHOTO_SETTINGS: PhotoSettings = {
  width: 1920,
  height: 1080,
  quality: "standard",
  toneMapping: "neutral",
  exposure: 1,
  denoise: true,
  allowRasterFallback: true,
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
  };
}

/** Stable key of the settings (part of the reuse key of a rendering). */
export function settingsKey(s: PhotoSettings): string {
  return [s.width, s.height, s.quality, s.toneMapping, s.exposure, s.denoise ? 1 : 0, s.allowRasterFallback ? 1 : 0].join("|");
}
