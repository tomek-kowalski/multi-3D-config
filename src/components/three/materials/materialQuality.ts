import type { MaterialQualityProfile, RenderMode, RendererCapabilities, TextureAsset, TextureSemantic, TextureVariant } from "@/domain/materials/contracts";

/**
 * Quality profiles: the same appearance in every mode, with budgets per renderer. A profile never
 * changes which decor or colour is shown — only which variant of the same authorized image is used,
 * how it is filtered, and which optional maps/lobes the renderer can afford.
 */

const MIB = 1024 * 1024;
const OPTIONAL_MAPS: ReadonlySet<TextureSemantic> = new Set(["normal", "roughness", "metalness", "clearcoatNormal", "sheenColor", "sheenRoughness"]);

/** Integrated / mobile GPUs (Intel UHD 620 is the reference): 4× anisotropy, 32 MiB material textures. */
export const VIEWPORT_CONSTRAINED: MaterialQualityProfile = {
  id: "viewport-constrained",
  textureVariant: "prefer-enhanced",
  maxAssetEdgePx: 512,
  maxAnisotropy: 4,
  maxResidentTextureBytes: 32 * MIB,
  maxIdleTextureBytes: 8 * MIB,
  maxTraceLayers: 0,
  maxViewportDpr: 2,
  enabledOptionalMaps: OPTIONAL_MAPS,
  enableTransmission: false,
  forcePhysical: false,
};

/**
 * Discrete GPUs. Enhanced variants up to 1K only (Phase 4): 1K normal/roughness detail is visible in the
 * viewport, a 2K base colour is not at viewport resolutions, so 2K images are loaded for photos only.
 */
export const VIEWPORT_STANDARD: MaterialQualityProfile = {
  ...VIEWPORT_CONSTRAINED,
  id: "viewport-standard",
  maxAssetEdgePx: 1024,
  maxAnisotropy: 8,
  maxResidentTextureBytes: 128 * MIB,
  maxIdleTextureBytes: 32 * MIB,
};

/** Photo snapshot (fast raster and path tracing share one frozen appearance). */
export const PHOTO_PROFILE: MaterialQualityProfile = {
  id: "photo",
  textureVariant: "prefer-enhanced",
  maxAssetEdgePx: 2048,
  maxAnisotropy: 8,
  maxResidentTextureBytes: 256 * MIB,
  maxIdleTextureBytes: 0,
  maxTraceLayers: 32,
  maxViewportDpr: 1,
  enabledOptionalMaps: OPTIONAL_MAPS,
  enableTransmission: true,
  forcePhysical: true,
};

/** Path tracing at "standard" quality: 16 texture-array layers (1K RGBA8, 4 MiB each) = 64 MiB. */
export const PHOTO_TRACE_STANDARD: MaterialQualityProfile = { ...PHOTO_PROFILE, id: "photo-trace-standard", maxTraceLayers: 16 };
/** Path tracing at "high" quality: 32 layers = 128 MiB. */
export const PHOTO_TRACE_HIGH: MaterialQualityProfile = { ...PHOTO_PROFILE, id: "photo-trace-high", maxTraceLayers: 32 };

/** Trace profile for a photo quality ("fast" never traces; it uses the standard budget if it falls back). */
export function traceQualityProfile(quality: "fast" | "standard" | "high"): MaterialQualityProfile {
  return quality === "high" ? PHOTO_TRACE_HIGH : PHOTO_TRACE_STANDARD;
}

/** Layer budget of a trace profile, clamped to the device's MAX_ARRAY_TEXTURE_LAYERS. */
export function traceLayerBudget(profile: MaterialQualityProfile, maxArrayTextureLayers: number): number {
  return Math.max(0, Math.min(profile.maxTraceLayers, maxArrayTextureLayers > 0 ? maxArrayTextureLayers : profile.maxTraceLayers));
}

/** @deprecated kept for callers of the Phase 3 constant; use traceQualityProfile(). */
export const TRACE_LAYER_BUDGET = { constrained: PHOTO_TRACE_STANDARD.maxTraceLayers, high: PHOTO_TRACE_HIGH.maxTraceLayers } as const;
export const TRACE_LAYER_BYTES = 1024 * 1024 * 4;

const INTEGRATED_GPU = /intel|uhd|iris|hd graphics|mali|adreno|powervr|apple|swiftshader|llvmpipe|microsoft basic/i;

/** Viewport profile for a renderer string (unknown → the constrained profile, the safe choice). */
export function viewportQualityProfile(renderer: string | null): MaterialQualityProfile {
  if (!renderer || INTEGRATED_GPU.test(renderer)) return VIEWPORT_CONSTRAINED;
  return VIEWPORT_STANDARD;
}

/**
 * The variant of an authorized image a profile uses (always the same image identity): enhanced only when
 * the profile prefers it, it adds detail, and it fits both the profile's edge limit and the device's
 * MAX_TEXTURE_SIZE. Deterministic for a given asset, profile and device.
 */
export function selectVariant(asset: TextureAsset, quality: MaterialQualityProfile, maxTextureSize = Infinity): { variant: TextureVariant; tier: "standard" | "enhanced" } {
  const enhanced = asset.variants.enhanced;
  const limit = Math.min(quality.maxAssetEdgePx, maxTextureSize);
  const fits = enhanced && Math.max(enhanced.width, enhanced.height) <= limit;
  if (quality.textureVariant === "prefer-enhanced" && enhanced && fits && !asset.lowDetail) return { variant: enhanced, tier: "enhanced" };
  return { variant: asset.variants.standard, tier: "standard" };
}

export function effectiveAnisotropy(capabilities: RendererCapabilities, quality: MaterialQualityProfile): number {
  return Math.max(1, Math.min(quality.maxAnisotropy, capabilities.maxAnisotropy || 1));
}

interface RendererLike {
  capabilities: { getMaxAnisotropy(): number; maxTextureSize: number; isWebGL2?: boolean };
  getContext(): WebGLRenderingContext | WebGL2RenderingContext;
}

/** Capabilities of a live Three renderer (viewport canvas or an offscreen photo backend). */
export function capabilitiesFromRenderer(renderer: RendererLike, mode: RenderMode, reflections: boolean): RendererCapabilities {
  const gl = renderer.getContext();
  const webgl2 = typeof WebGL2RenderingContext !== "undefined" && gl instanceof WebGL2RenderingContext;
  return {
    mode,
    usable: true,
    maxTextureSize: renderer.capabilities.maxTextureSize,
    maxAnisotropy: renderer.capabilities.getMaxAnisotropy(),
    maxArrayTextureLayers: webgl2 ? Number((gl as WebGL2RenderingContext).getParameter((gl as WebGL2RenderingContext).MAX_ARRAY_TEXTURE_LAYERS)) : 0,
    supportsFloatColorTargets: webgl2 && gl.getExtension("EXT_color_buffer_float") !== null,
    supportsTransmission: mode !== "viewport",
    reflections,
    // Three's raster materials sample UV channels 0–3.
    uvChannels: 4,
    supportedMaps: new Set(["baseColor", ...OPTIONAL_MAPS]),
  };
}

/** Capabilities assumed for the offscreen photo backends (both support every map and transmission). */
export const PHOTO_CAPABILITIES: RendererCapabilities = {
  mode: "fast-raster",
  usable: true,
  maxTextureSize: 4096,
  maxAnisotropy: 16,
  maxArrayTextureLayers: 256,
  supportsFloatColorTargets: true,
  supportsTransmission: true,
  reflections: true,
  // The photo snapshot serves both backends; the path tracer samples UV0 only.
  uvChannels: 1,
  supportedMaps: new Set(["baseColor", ...OPTIONAL_MAPS]),
};
