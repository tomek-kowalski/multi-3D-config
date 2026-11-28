import { Color, DoubleSide, FrontSide, MeshPhysicalMaterial, MeshStandardMaterial, Vector2, type Material, type Texture } from "three";
import { UNAVAILABLE_PREVIEW_HEX } from "@/domain/materials/bindings";
import type { BaseColor, FinishProfile, MaterialMap, SurfaceProfile, TextureAsset, TextureSemantic } from "@/domain/materials/contracts";
import { resolveTextureTransform } from "@/domain/materials/mapping";
import { effectiveAnisotropy, selectVariant } from "./materialQuality";
import type { MaterialBuildRequest, MaterialInstance, MaterialIssue, PbrMaterialFactory, TextureLease } from "./runtimeContracts";
import { estimateTextureBytes, TextureScopeDisposedError } from "./textureResources";

/** Fully metallic surfaces need an environment to reflect; without one they are capped (legacy look). */
const NO_REFLECTION_MAX_METALNESS = 0.35;

type PbrMaterial = MeshStandardMaterial | MeshPhysicalMaterial;

function isStandard(material: Material | null | undefined): material is MeshStandardMaterial {
  return !!material && (material as MeshStandardMaterial).isMeshStandardMaterial === true;
}

function isPhysical(material: Material | null | undefined): material is MeshPhysicalMaterial {
  return !!material && (material as MeshPhysicalMaterial).isMeshPhysicalMaterial === true;
}

function needsPhysical(finish: FinishProfile | undefined, request: MaterialBuildRequest): boolean {
  if (request.quality.forcePhysical) return true;
  if (!finish) return isPhysical(request.authored);
  const transmission = !!finish.transmission && request.quality.enableTransmission && request.capabilities.supportsTransmission;
  return !!finish.clearcoat || !!finish.sheen || transmission || finish.specularIntensity !== 1 || isPhysical(request.authored);
}

/** Copies every standard property of an authored material (maps, UV transforms, emissive, flags). */
function fromAuthored(authored: MeshStandardMaterial, physical: boolean): PbrMaterial {
  if (!physical) return new MeshStandardMaterial().copy(authored);
  const m = new MeshPhysicalMaterial();
  if (isPhysical(authored)) return m.copy(authored);
  MeshStandardMaterial.prototype.copy.call(m, authored);
  return m;
}

/** Texture-valued properties of a material (every map slot three knows, present or not). */
function textureProperties(material: Material): string[] {
  return Object.keys(material).filter((key) => {
    const value = (material as unknown as Record<string, unknown>)[key];
    return !!value && (value as Texture).isTexture === true;
  });
}

function capAlbedo(color: MeshStandardMaterial["color"], max: number | undefined) {
  if (max === undefined) return;
  const peak = Math.max(color.r, color.g, color.b);
  if (peak > max) color.multiplyScalar(max / peak);
}

/**
 * Linear per-channel gain that moves an image's measured mean onto a catalog colour (BaseColor
 * calibration): every texel keeps its ratio to the mean, so grain contrast and luminance variation are
 * unchanged; the result is the same in every renderer (three multiplies map × colour in linear space).
 */
export function calibrationGain(asset: TextureAsset, targetSrgbHex: string): Color | null {
  const mean = asset.statistics?.meanLinearRgb;
  if (!mean || !mean.every((c) => c > 0)) return null;
  const target = new Color(targetSrgbHex); // linear working space
  return new Color(target.r / mean[0], target.g / mean[1], target.b / mean[2]);
}

/**
 * Scalar that keeps a map's measured mean on the finish's value: three multiplies roughness/metalness by
 * the map, so the scalar becomes finish / mean (the shader clamps each texel's product to 0-1). A map
 * without measured statistics multiplies the finish value, as before.
 */
export function mapScalar(finishValue: number, asset: TextureAsset): number {
  const mean = asset.statistics?.meanValue;
  return mean !== undefined && mean > 0 ? finishValue / mean : finishValue;
}

/**
 * The shared PBR material factory: live viewport, fast raster and path tracing all build their
 * materials here from one resolved appearance, so the same selection never looks different between
 * them except where a renderer genuinely cannot do something (reported as an issue):
 * - base colour: solid sRGB colour, an authorized decor image placed at its physical scale, or the
 *   explicit unavailable indicator — never another decor;
 * - finish: scalar roughness/metalness/specular, clear coat, sheen, transmission (or the documented
 *   viewport glass proxy);
 * - surface maps: normal/roughness/metalness maps of the surface profile when quality and budget allow;
 * - authored (imported glTF) materials keep every property an override does not name; their textures
 *   are adopted into the caller's resource scope (shared pixels, own sampler/transform/upload), so the
 *   viewport, the photo backends and the model cache never share mutable texture state.
 *
 * Budget policy (deterministic for a given scene build order and device): an enhanced image that does
 * not fit the device's MAX_TEXTURE_SIZE or the scope's remaining budget uses the same image's standard
 * tier; optional maps that do not fit are left out ("budget-reduced"); an authorized base colour is never
 * dropped or replaced to meet a budget — it is loaded and reported ("budget-exceeded") instead.
 *
 * Returns synchronously; textures arrive later (`ready`). While an image loads the material shows the
 * same decor's mean colour from the catalog. After dispose() nothing is acquired or applied any more.
 */
export function createPbrMaterial(request: MaterialBuildRequest): MaterialInstance {
  const { resolved, capabilities, quality, textures, registry } = request;
  const issues: MaterialIssue[] = [...(resolved.resolutionIssues ?? [])];
  const authored = resolved.source === "authored" ? (isStandard(request.authored) ? request.authored : null) : null;
  if (resolved.source === "authored" && !authored) issues.push("invalid-binding");
  const finish = resolved.finish;
  const surface: SurfaceProfile | undefined = resolved.surface;
  const color: BaseColor | undefined = resolved.color;
  const physical = needsPhysical(finish, request);
  const material: PbrMaterial = authored ? fromAuthored(authored, physical) : physical ? new MeshPhysicalMaterial() : new MeshStandardMaterial();
  material.name = resolved.id;
  // "authored" keeps the imported material's own side.
  if (request.side !== "authored" || !authored) material.side = request.side === "double" ? DoubleSide : FrontSide;
  material.userData = { ...material.userData, materialId: resolved.id, availability: resolved.availability, label: resolved.label };
  // The finish's own scalars: restored by consumers that drop a map (path-tracer layer budget), because a
  // calibrated scalar is only meaningful together with its map.
  if (finish) material.userData.scalarsWithoutMaps = { roughness: finish.roughness, metalness: finish.metalness };

  const leases: TextureLease[] = [];
  const adopted: { release(): void }[] = [];
  let disposed = false;

  // ---- Base colour ----
  const setColor = (hex: string) => material.color.set(hex);
  let baseMap: MaterialMap | null = null;
  if (color) {
    if (color.kind === "solid") {
      material.map = null;
      setColor(color.srgbHex);
    } else if (color.kind === "map") {
      material.map = null;
      setColor(color.meanSrgbHex);
      baseMap = color.map;
    } else {
      material.map = null;
      setColor(UNAVAILABLE_PREVIEW_HEX);
      issues.push("missing-authorized-swatch");
    }
  } else if (!authored && resolved.source === "authored") {
    setColor(UNAVAILABLE_PREVIEW_HEX);
  }

  // ---- Finish ----
  if (finish) {
    material.roughness = finish.roughness;
    let metalness = finish.metalness;
    if (!capabilities.reflections && metalness > NO_REFLECTION_MAX_METALNESS) {
      metalness = NO_REFLECTION_MAX_METALNESS;
      issues.push("reflection-fallback");
    }
    material.metalness = metalness;
    if (isPhysical(material)) {
      material.specularIntensity = finish.specularIntensity;
      material.clearcoat = finish.clearcoat?.amount ?? 0;
      material.clearcoatRoughness = finish.clearcoat?.roughness ?? 0;
      if (finish.sheen) {
        material.sheen = finish.sheen.amount;
        material.sheenRoughness = finish.sheen.roughness;
      } else {
        material.sheen = 0;
      }
    }
    if (finish.transmission) {
      const useTransmission = quality.enableTransmission && capabilities.supportsTransmission && isPhysical(material);
      if (useTransmission) {
        const m = material as MeshPhysicalMaterial;
        m.transmission = finish.transmission.amount;
        m.ior = finish.transmission.ior;
        m.thickness = finish.transmission.thicknessM;
        setColor(finish.transmission.tintSrgbHex);
        m.transparent = false;
        m.opacity = 1;
      } else {
        // Documented viewport proxy: alpha-blended glass (no refraction), as the configurator always drew it.
        setColor(finish.transmission.proxy.srgbHex);
        material.transparent = true;
        material.opacity = finish.transmission.proxy.opacity;
        material.depthWrite = false;
        issues.push("transmission-fallback");
      }
    }
  }
  capAlbedo(material.color, finish?.maxLinearAlbedo);
  if (isPhysical(material) && finish?.sheen) {
    const s = finish.sheen;
    if (s.linearRgb) material.sheenColor.setRGB(s.linearRgb[0], s.linearRgb[1], s.linearRgb[2]);
    else material.sheenColor.copy(material.color).multiplyScalar(s.baseColorFactor ?? 1);
  }

  // ---- Authored textures: scope-owned copies (after overrides: a replaced map is not adopted) ----
  if (authored) {
    for (const key of textureProperties(material)) {
      const source = (material as unknown as Record<string, Texture>)[key];
      if (source.channel >= capabilities.uvChannels) issues.push("unsupported-uv-channel");
      const adoption = textures.adopt(source);
      adopted.push(adoption);
      (material as unknown as Record<string, Texture>)[key] = adoption.texture;
    }
  }

  // ---- Registered textures ----
  const pending: Promise<void>[] = [];
  const anisotropy = effectiveAnisotropy(capabilities, quality);

  const load = (map: MaterialMap, semantic: TextureSemantic, apply: (texture: Texture, asset: TextureAsset) => void) => {
    if (semantic !== "baseColor" && (!quality.enabledOptionalMaps.has(semantic) || !capabilities.supportedMaps.has(semantic))) {
      issues.push("optional-map-disabled");
      return;
    }
    const transform = resolveTextureTransform(request.mapping, map.alignment);
    if (!transform) {
      issues.push("unsupported-map-alignment");
      return;
    }
    const asset = registry.getTextureAsset(map.assetId);
    let choice = selectVariant(asset, quality, capabilities.maxTextureSize);
    const bytes = (tier: "standard" | "enhanced") => {
      const v = tier === "enhanced" && asset.variants.enhanced ? asset.variants.enhanced : asset.variants.standard;
      return estimateTextureBytes(v.width, v.height, true);
    };
    if (choice.tier === "enhanced" && !textures.canAfford(bytes("enhanced"))) {
      choice = { variant: asset.variants.standard, tier: "standard" };
      issues.push("budget-reduced");
    }
    if (!textures.canAfford(bytes(choice.tier))) {
      if (semantic !== "baseColor") {
        // Optional detail first: never at the expense of the authorized colour image.
        issues.push("budget-reduced");
        return;
      }
      issues.push("budget-exceeded");
    }
    if (Math.max(choice.variant.width, choice.variant.height) > capabilities.maxTextureSize) issues.push("texture-downscaled");
    const acquire = (tier: "standard" | "enhanced"): Promise<Texture> => {
      if (disposed) return Promise.reject(new TextureScopeDisposedError());
      const variant = tier === "enhanced" && asset.variants.enhanced ? asset.variants.enhanced : asset.variants.standard;
      const lease = textures.acquire({
        assetId: asset.id,
        url: variant.url,
        semantic,
        colorSpace: asset.colorSpace,
        wrap: "repeat",
        repeat: transform.repeat,
        offset: transform.offset,
        rotationRad: transform.rotationRad,
        flipY: true,
        anisotropy,
        mipmaps: true,
        width: variant.width,
        height: variant.height,
      });
      leases.push(lease);
      return lease.ready;
    };
    const applyIfLive = (texture: Texture) => {
      if (disposed) return;
      apply(texture, asset);
      material.needsUpdate = true;
    };
    const firstTier = choice.tier;
    pending.push(
      acquire(firstTier).then(applyIfLive, async (error) => {
        // Disposed material or scope: nothing to apply, no fallback, no new acquisition.
        if (disposed || error instanceof TextureScopeDisposedError) return;
        if (firstTier === "enhanced") {
          // The same decor's standard image, never a different decor.
          try {
            const texture = await acquire("standard");
            if (disposed) return;
            issues.push("enhanced-variant-fallback");
            applyIfLive(texture);
            return;
          } catch (fallbackError) {
            if (disposed || fallbackError instanceof TextureScopeDisposedError) return;
          }
        }
        issues.push("texture-load-failed");
      }),
    );
  };

  // Mean linear albedo of the surface (consumers such as the fast raster's floor bounce use it instead of
  // the colour factor, which is only a gain once a map is applied).
  material.userData.meanLinearAlbedo = material.color.toArray();
  if (baseMap) {
    const calibration = color?.kind === "map" ? color.calibration : undefined;
    load(baseMap, "baseColor", (texture, asset) => {
      material.map = texture;
      const gain = calibration ? calibrationGain(asset, calibration.targetSrgbHex) : null;
      if (gain) material.color.copy(gain);
      else material.color.set("#FFFFFF");
      capAlbedo(material.color, finish?.maxLinearAlbedo);
      const mean = asset.statistics?.meanLinearRgb;
      if (mean) material.userData.meanLinearAlbedo = [mean[0] * material.color.r, mean[1] * material.color.g, mean[2] * material.color.b];
    });
  }
  if (surface) {
    if (surface.maps.normal) {
      load(surface.maps.normal, "normal", (t) => {
        material.normalMap = t;
        material.normalScale = new Vector2(surface.normalScale[0], surface.normalScale[1]);
      });
    }
    if (surface.maps.roughness) {
      load(surface.maps.roughness, "roughness", (t, asset) => {
        material.roughnessMap = t;
        if (finish) material.roughness = mapScalar(finish.roughness, asset);
      });
    }
    if (surface.maps.metalness) {
      load(surface.maps.metalness, "metalness", (t, asset) => {
        material.metalnessMap = t;
        if (finish && material.metalness > 0) material.metalness = mapScalar(material.metalness, asset);
      });
    }
  }
  if (isPhysical(material) && finish?.clearcoat?.normal) {
    const cc = finish.clearcoat;
    load(cc.normal!, "clearcoatNormal", (t) => {
      (material as MeshPhysicalMaterial).clearcoatNormalMap = t;
      if (cc.normalScale) (material as MeshPhysicalMaterial).clearcoatNormalScale = new Vector2(cc.normalScale[0], cc.normalScale[1]);
    });
  }
  if (isPhysical(material) && finish?.sheen?.colorMap) load(finish.sheen.colorMap, "sheenColor", (t) => ((material as MeshPhysicalMaterial).sheenColorMap = t));
  if (isPhysical(material) && finish?.sheen?.roughnessMap) load(finish.sheen.roughnessMap, "sheenRoughness", (t) => ((material as MeshPhysicalMaterial).sheenRoughnessMap = t));

  material.needsUpdate = true;
  const ready = Promise.all(pending).then(() => undefined);
  return {
    material,
    issues,
    ready,
    resolved,
    dispose() {
      if (disposed) return;
      disposed = true;
      leases.forEach((l) => l.release());
      adopted.forEach((a) => a.release());
      material.dispose();
    },
  };
}

export const pbrMaterialFactory: PbrMaterialFactory = { create: createPbrMaterial };
