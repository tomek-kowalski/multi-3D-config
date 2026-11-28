/**
 * Universal material contracts (docs/universal-material-architecture.md §1). Plain data, no Three.js:
 * the registry and its tests run without WebGL. Units are metres unless a field says otherwise.
 *
 * Product identity and appearance are separate: a furniture module states WHICH existing selection a
 * surface carries (a cabinet finish ID, a ClickBed decor entry, a configured colour, an authored model
 * material) and HOW its geometry is mapped; this system decides what it looks like. Saved
 * configurations, manufacturer references, texture URLs and WooCommerce payloads never contain any of
 * these rendering keys.
 */

export type MaterialId = string;
export type AssetId = string;
export type ProfileId = string;
export type SlotId = string;
export type MeterPair = readonly [number, number];

export type RenderMode = "viewport" | "fast-raster" | "path-traced";

/**
 * What a surface physically is. Extensible: a new category is a new union member plus the profiles
 * that use it; the factory, texture resources and renderers do not branch on it.
 */
export const MATERIAL_CATEGORIES = [
  "wood",
  "laminate",
  "veneer",
  "lacquer",
  "textile",
  "leather",
  "metal",
  "plastic",
  "glass",
  "stone",
  "ceramic",
  "concrete",
  "paint",
] as const;
export type MaterialCategory = (typeof MATERIAL_CATEGORIES)[number];

export type TextureSemantic = "baseColor" | "normal" | "roughness" | "metalness" | "clearcoatNormal" | "sheenColor" | "sheenRoughness";

/** sRGB for colour (base colour, sheen colour); linear data for normals and scalar maps. */
export type TextureColorSpace = "srgb" | "data";

export const TEXTURE_COLOR_SPACE: Readonly<Record<TextureSemantic, TextureColorSpace>> = {
  baseColor: "srgb",
  sheenColor: "srgb",
  normal: "data",
  roughness: "data",
  metalness: "data",
  clearcoatNormal: "data",
  sheenRoughness: "data",
};

export interface TextureVariant {
  readonly url: string;
  readonly width: number;
  readonly height: number;
  readonly format: "jpeg" | "png" | "ktx2";
}

/**
 * Measured statistics of an image (over the whole standard-tier file; the enhanced tier of the same image
 * agrees within 0.5 %). They let the factory calibrate a generic image to a catalog value without
 * touching its pixels: a base colour to a catalog colour, a roughness map to a finish's roughness.
 */
export interface TextureStatistics {
  /** Mean linear-sRGB colour (base colour maps). */
  readonly meanLinearRgb?: readonly [number, number, number];
  /** Mean value of the sampled channel (roughness/metalness maps), 0–1. */
  readonly meanValue?: number;
}

export interface TextureAsset {
  readonly id: AssetId;
  readonly semantic: TextureSemantic;
  readonly colorSpace: TextureColorSpace;
  readonly variants: Readonly<{ standard: TextureVariant; enhanced?: TextureVariant }>;
  /** Where the file comes from and under which terms it is used. */
  readonly provenance: string;
  /** The image is (almost) a single flat colour: a larger variant adds nothing visible. */
  readonly lowDetail?: boolean;
  readonly statistics?: TextureStatistics;
}

/**
 * How a map lies on the surface:
 * - decor-registered: in register with one decor's printed image (synchronous emboss): same
 *   registration ID, same physical coverage and the same phase (offset of the tile origin) as that
 *   decor's base-colour map, grain along u;
 * - surface-repeat: an independent tile of measured coverage; `directional` maps (grain, brushing) run
 *   along u, the part's grain axis.
 */
export type MapAlignment =
  | { readonly kind: "decor-registered"; readonly registrationId: string; readonly coverageM: MeterPair; readonly phaseM: MeterPair }
  | { readonly kind: "surface-repeat"; readonly coverageM: MeterPair; readonly directional: boolean };

export interface MaterialMap {
  readonly assetId: AssetId;
  readonly alignment: MapAlignment;
}

export type BaseColor =
  | { readonly kind: "solid"; readonly srgbHex: string }
  | {
      readonly kind: "map";
      readonly map: MaterialMap;
      /**
       * Mean sRGB colour of the same authorized image (from the catalog), shown while the image loads
       * or when it fails: the selected decor's own colour, never another decor's.
       */
      readonly meanSrgbHex: string;
      /**
       * A generic (non-manufacturer) image calibrated to a catalog colour: the factory scales each linear
       * channel by target / the image's measured mean (TextureStatistics.meanLinearRgb), so the surface's
       * mean equals the catalog colour while every pixel keeps its ratio to the mean — grain contrast and
       * luminance variation are preserved, nothing is multiplied by the colour itself (which would darken
       * and oversaturate). Never used for manufacturer decors, whose images are the reference.
       */
      readonly calibration?: Readonly<{ kind: "match-mean-linear"; targetSrgbHex: string }>;
    }
  | { readonly kind: "unavailable"; readonly reason: "no-authorized-swatch" };

export interface DecorDefinition {
  readonly id: string;
  /** Source of the decor list (the shop's option form); the board manufacturer is not stated there. */
  readonly manufacturer: string;
  readonly code: string;
  readonly structure: string;
  readonly name: string;
  readonly baseColor: BaseColor;
  readonly registrationId?: string;
  readonly coverageEvidence: "measured" | "legacy-assumption" | "unknown";
  readonly sourceMatch: "exact" | "same-code-alternate-structure" | "missing";
}

export type SurfaceMapSharing =
  | { readonly kind: "universal-isotropic" }
  | { readonly kind: "verified-structure"; readonly manufacturer: string; readonly structures: readonly string[]; readonly evidence: string }
  | { readonly kind: "decor-registered"; readonly registrationId: string };

/**
 * Roughness/metalness maps carry measured statistics (TextureStatistics.meanValue): the factory scales
 * them so the surface's mean equals the finish's scalar value (the finish stays the single source of the
 * overall gloss) while the map adds the measured variation around it.
 */
export interface SurfaceResponseMaps {
  readonly normal?: MaterialMap;
  readonly roughness?: MaterialMap;
  readonly metalness?: MaterialMap;
}

/** Microstructure of a surface: what a normal/roughness map would describe. */
/**
 * Which surface profile a manufacturer decor uses: data, not code. The most specific matching rule wins
 * (decor ID > code > structure > manufacturer); every field given must match. Rules only point at
 * registered profiles — no surface property is inferred from a decor's name or colour.
 */
export interface SurfaceAssignment {
  readonly id: string;
  readonly match: Readonly<{ manufacturer?: string; decorId?: string; code?: string; structure?: string }>;
  readonly surfaceProfileId: ProfileId;
  /** Registration of the decor's print that the profile's maps are aligned to (in-register emboss). */
  readonly registrationId?: string;
  /** Phase of the decor's base-colour tile origin for that registration (metres). */
  readonly registrationPhaseM?: MeterPair;
  readonly evidence: string;
}

export interface SurfaceProfile {
  readonly id: ProfileId;
  readonly category: MaterialCategory;
  readonly sharing: SurfaceMapSharing;
  readonly maps: SurfaceResponseMaps;
  readonly normalScale: readonly [number, number];
}

/** Scalar optical response of a finish, plus optional physical lobes. */
export interface FinishProfile {
  readonly id: ProfileId;
  readonly roughness: number;
  readonly metalness: number;
  /** Dielectric specular (F0 = 0.04 × intensity); 1 is the standard dielectric response. */
  readonly specularIntensity: number;
  /**
   * Highest linear albedo a real surface of this kind reflects (e.g. white cotton ticking ~0.70).
   * Brighter configured/authored colours keep their hue and are scaled down to it.
   */
  readonly maxLinearAlbedo?: number;
  readonly clearcoat?: Readonly<{ amount: number; roughness: number; normal?: MaterialMap; normalScale?: readonly [number, number] }>;
  readonly sheen?: Readonly<{
    amount: number;
    roughness: number;
    /** Absolute sheen colour, or */
    linearRgb?: readonly [number, number, number];
    /** sheen colour = base colour × this factor (a tinted, softer rim of the fabric's own colour). */
    baseColorFactor?: number;
    colorMap?: MaterialMap;
    roughnessMap?: MaterialMap;
  }>;
  readonly transmission?: Readonly<{
    amount: number;
    ior: number;
    thicknessM: number;
    /** Physical tint of the glass (transmission colour). */
    tintSrgbHex: string;
    /**
     * Documented transparent proxy for quality profiles that do not render transmission (the
     * interactive viewport): alpha blending with this colour and opacity.
     */
    proxy: Readonly<{ srgbHex: string; opacity: number }>;
  }>;
}

export interface MaterialDefinition {
  readonly id: MaterialId;
  readonly category: MaterialCategory;
  /** A fixed colour/map, a decor, or "configured" for templates whose colour comes from the configuration. */
  readonly color: BaseColor | { readonly kind: "decor"; readonly decorId: string } | { readonly kind: "configured" };
  readonly surfaceProfileId: ProfileId;
  readonly finishProfileId: ProfileId;
  readonly provenance: string;
}

/**
 * Selective changes to a material authored in an imported model (glTF): only the named aspects are
 * replaced; every other authored property (maps, emissive, vertex colours, UV transforms) is kept.
 */
export interface AuthoredOverrides {
  /** Replace the base colour (and base colour map) by this selection's colour identity. */
  readonly baseColor?: MaterialSelection;
  readonly finishProfileId?: ProfileId;
  readonly surfaceProfileId?: ProfileId;
}

export type MaterialSelection =
  | { readonly kind: "registered"; readonly id: MaterialId }
  | { readonly kind: "legacy"; readonly namespace: string; readonly key: readonly [string, ...string[]] }
  | { readonly kind: "configured-color"; readonly templateId: MaterialId; readonly srgbHex: string }
  | { readonly kind: "authored"; readonly overrides?: AuthoredOverrides };

/**
 * How a surface's UV0 relates to the physical surface. This is how physical mapping information travels
 * from geometry to texture requests: the mesh declares it on its slot binding, the factory combines it
 * with each map's measured coverage (MapAlignment.coverageM) to derive the sampler repeat.
 * - projected-metres: UV0 was generated in metres by physicalUv.ts from these part axes and origin.
 * - authored-uv0: UV0 comes from the model; in metres, or normalized with the physical size it spans.
 */
export type MappingSpec =
  | {
      /** One planar projection for the whole surface (floor, wall): u/v axes in the mesh frame. */
      readonly kind: "projected-metres";
      readonly originM: readonly [number, number, number];
      readonly uAxis: readonly [number, number, number];
      readonly vAxis: readonly [number, number, number];
    }
  | {
      /**
       * Per-face metre UV0 generated by physicalUv.ts for a part: `box` — u along the part's grain axis on
       * every face containing it, otherwise along the face's longer side (edges: along their length);
       * `cylinder` — u along the axis (brushing/length direction), v around the circumference, caps
       * planar. UVs start at the part's minimum corner plus `phaseM`.
       */
      readonly kind: "part-metres";
      readonly convention: "box" | "cylinder";
      readonly grainAxis: "x" | "y" | "z";
      readonly phaseM: MeterPair;
    }
  | { readonly kind: "authored-uv0"; readonly uvUnits: "metres" | "normalized"; readonly coverageM?: MeterPair };

export interface MaterialSlotBinding {
  readonly slotId: SlotId;
  readonly selection: MaterialSelection;
  readonly mapping?: MappingSpec;
  /** "authored": keep the side of the authored (imported) material. */
  readonly side: "front" | "double" | "authored";
}

export interface MaterialGroupBinding {
  /** Index of the material in the mesh's ordered material array. */
  readonly materialIndex: number;
  readonly slotId: SlotId;
}

export interface MeshMaterialBinding {
  readonly slots: readonly MaterialSlotBinding[];
  /** Empty: a single-material mesh using slots[0]. */
  readonly groups: readonly MaterialGroupBinding[];
}

export type MaterialAvailability = "available" | "missing-authorized-swatch";

/** Problems found while resolving (reported by the factory as material issues). */
export type ResolutionIssue = "incompatible-surface-registration";

interface ResolvedCommon {
  /** Stable rendering key of the resolved appearance (never posted or saved). */
  readonly id: MaterialId;
  readonly availability: MaterialAvailability;
  readonly decor?: DecorDefinition;
  /** Human-readable reference for diagnostics, e.g. "K003 PW". */
  readonly label: string;
  readonly resolutionIssues?: readonly ResolutionIssue[];
}

export interface RegistryResolvedMaterial extends ResolvedCommon {
  readonly source: "registry";
  readonly category: MaterialCategory;
  readonly color: BaseColor;
  readonly surface: SurfaceProfile;
  readonly finish: FinishProfile;
}

/** An authored (imported) material with optional selective overrides already resolved. */
export interface AuthoredResolvedMaterial extends ResolvedCommon {
  readonly source: "authored";
  readonly color?: BaseColor;
  readonly surface?: SurfaceProfile;
  readonly finish?: FinishProfile;
}

export type ResolvedMaterial = RegistryResolvedMaterial | AuthoredResolvedMaterial;

export interface MaterialRegistry {
  /** Changes whenever a definition changes: part of photo cache identity. */
  readonly revision: string;
  resolve(selection: MaterialSelection): ResolvedMaterial;
  getTextureAsset(id: AssetId): TextureAsset;
  getFinishProfile(id: ProfileId): FinishProfile;
  getSurfaceProfile(id: ProfileId): SurfaceProfile;
  /**
   * Surface profile of a manufacturer decor (data-driven SurfaceAssignment rules), validated against
   * the decor's base colour: registered maps need the decor's registration, coverage and phase;
   * verified-structure maps need the decor's manufacturer and structure. An incompatible profile is
   * replaced by a map-free profile of the same category, with the issue reported.
   */
  surfaceForDecor(decor: DecorDefinition, fallbackProfileId: ProfileId): { surface: SurfaceProfile; issues: readonly ResolutionIssue[] };
  /** Adds definitions (validated); used by new furniture types and fixtures. Returns the issues found. */
  register(data: RegistryData): readonly string[];
  /** Every consistency problem of the registered data (empty when valid). */
  validate(): readonly string[];
}

export interface LegacyResolver {
  readonly namespace: string;
  resolve(key: readonly string[], registry: MaterialRegistry): ResolvedMaterial | null;
}

export interface RegistryData {
  readonly materials?: readonly MaterialDefinition[];
  readonly finishes?: readonly FinishProfile[];
  readonly surfaces?: readonly SurfaceProfile[];
  readonly textures?: readonly TextureAsset[];
  readonly legacy?: readonly LegacyResolver[];
  readonly surfaceAssignments?: readonly SurfaceAssignment[];
}

export interface RendererCapabilities {
  readonly mode: RenderMode;
  readonly usable: boolean;
  readonly maxTextureSize: number;
  readonly maxAnisotropy: number;
  readonly maxArrayTextureLayers: number;
  readonly supportsFloatColorTargets: boolean;
  readonly supportsTransmission: boolean;
  /** An environment map is available, so fully metallic surfaces have something to reflect. */
  readonly reflections: boolean;
  /** UV channels the renderer samples (the path tracer reads UV0 only). */
  readonly uvChannels: number;
  readonly supportedMaps: ReadonlySet<TextureSemantic>;
}

export interface MaterialQualityProfile {
  readonly id: string;
  readonly textureVariant: "standard" | "prefer-enhanced";
  readonly maxAssetEdgePx: number;
  readonly maxAnisotropy: number;
  /** Active + adopted material textures (estimate) per resource scope. */
  readonly maxResidentTextureBytes: number;
  /** Unused textures kept for instant re-selection. */
  readonly maxIdleTextureBytes: number;
  readonly maxTraceLayers: number;
  readonly maxViewportDpr: number;
  readonly enabledOptionalMaps: ReadonlySet<TextureSemantic>;
  readonly enableTransmission: boolean;
  /** Use a physical material (clearcoat/sheen/transmission/specular) even when Standard would do. */
  readonly forcePhysical: boolean;
}
