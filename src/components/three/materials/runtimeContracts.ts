import type { Material, MeshPhysicalMaterial, MeshStandardMaterial, Texture } from "three";
import type {
  AssetId,
  MaterialQualityProfile,
  MaterialRegistry,
  MeterPair,
  RendererCapabilities,
  ResolvedMaterial,
  TextureColorSpace,
  TextureSemantic,
  MappingSpec,
} from "@/domain/materials/contracts";

/**
 * Runtime contracts that carry a resolved appearance into Three.js (architecture §1). Renderer
 * objects stay out of the registry; everything here is owned by a resource scope (one per live canvas,
 * one per photo job) and released explicitly.
 */

export interface TextureRequest {
  readonly assetId: AssetId;
  readonly url: string;
  readonly semantic: TextureSemantic;
  readonly colorSpace: TextureColorSpace;
  readonly wrap: "repeat" | "clamp";
  readonly repeat: MeterPair;
  readonly offset: MeterPair;
  readonly rotationRad: number;
  readonly flipY: boolean;
  readonly anisotropy: number;
  readonly mipmaps: boolean;
  /** Approximate decoded size, for residency accounting before the image arrives. */
  readonly width: number;
  readonly height: number;
}

export interface TextureLease {
  readonly ready: Promise<Texture>;
  /** Idempotent. The texture stays valid for other leases; an idle one is freed by trim(). */
  release(): void;
}

/**
 * Residency of a scope. All byte figures are ESTIMATES (RGBA8, + 1/3 for a mip chain), not GPU
 * measurements: WebGL exposes no allocation sizes.
 */
export interface TextureResourceStats {
  readonly textures: number;
  readonly activeLeases: number;
  readonly idleTextures: number;
  /** Estimated residency of every texture of the scope (active + idle + adopted). */
  readonly residentBytes: number;
  readonly activeBytes: number;
  readonly idleBytes: number;
  /** Adopted (authored, imported-model) textures held by this scope. */
  readonly adoptedTextures: number;
  readonly adoptedBytes: number;
  readonly sources: number;
}

export interface TextureBudget {
  /** Active + adopted textures may not exceed this (idle ones are evicted first to make room). */
  readonly maxResidentBytes: number;
  /** Unleased textures kept for instant re-selection are evicted beyond this. */
  readonly maxIdleBytes: number;
}

export interface TextureResources {
  acquire(request: TextureRequest): TextureLease;
  /**
   * A scope-owned copy of an authored texture (imported model): it shares the decoded image (no copy
   * of pixels) but has its own sampler, transform and upload state, so neither renderer can change the
   * other's (or the model cache's) texture. Counted in this scope's residency.
   */
  adopt(texture: Texture): { readonly texture: Texture; release(): void };
  /**
   * Whether `bytes` more fit the scope's budget after evicting idle textures (true without a budget).
   * Used for deterministic quality reduction before a texture is acquired.
   */
  canAfford(bytes: number): boolean;
  readonly budget: TextureBudget | null;
  /** Evicts idle resources until the estimate is at or below the target. Active leases remain valid. */
  trim(targetResidentBytes: number): void;
  stats(): TextureResourceStats;
  /** Frees everything of this scope (canvas unmount, photo job end). Later acquires still work. */
  dispose(): void;
}

export type MaterialIssue =
  | "missing-authorized-swatch"
  | "budget-reduced"
  | "budget-exceeded"
  | "texture-downscaled"
  | "unsupported-uv-channel"
  | "incompatible-surface-registration"
  | "texture-load-failed"
  | "enhanced-variant-fallback"
  | "optional-map-disabled"
  | "unsupported-map-alignment"
  | "transmission-fallback"
  | "reflection-fallback"
  | "invalid-binding";

export interface MaterialBuildRequest {
  readonly resolved: ResolvedMaterial;
  readonly side: "front" | "double" | "authored";
  readonly mapping?: MappingSpec;
  readonly capabilities: RendererCapabilities;
  readonly quality: MaterialQualityProfile;
  readonly textures: TextureResources;
  readonly registry: MaterialRegistry;
  /** Authored model material (glTF) for "authored" selections: the base that overrides apply to. */
  readonly authored?: Material | null;
}

export interface MaterialInstance {
  readonly material: MeshStandardMaterial | MeshPhysicalMaterial;
  /** Known at creation; grows if a texture fails to load. */
  readonly issues: readonly MaterialIssue[];
  /** Resolves when every texture of the appearance is applied (or has definitively failed). */
  readonly ready: Promise<void>;
  readonly resolved: ResolvedMaterial;
  /** Releases the leases and disposes the material. Idempotent; late texture completions are ignored. */
  dispose(): void;
}

export interface PbrMaterialFactory {
  create(request: MaterialBuildRequest): MaterialInstance;
}
