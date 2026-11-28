import type { AssetId, BaseColor, MaterialCategory, MaterialMap, MeterPair, SurfaceProfile, TextureAsset, TextureSemantic, TextureVariant } from "./contracts";
import manifest from "./data/pbrTextures.json";

/**
 * Generic PBR texture sets (Phase 4A/4B): Poly Haven CC0 images processed by
 * scripts/assets/process-pbr-textures.py into public/textures/pbr/<set>/ (provenance, checksums and
 * measured statistics in data/pbrTextures.json, licence in public/textures/pbr/LICENSE.md).
 *
 * Tiers of one image (same pixels, different resolution):
 * - base colour: standard 1K JPEG, enhanced 2K JPEG (sRGB);
 * - normal: standard 512, enhanced 1K — OpenGL convention (+Y up), lossless PNG, renormalized after
 *   filtering;
 * - roughness: standard 256, enhanced 1K — lossless grey PNG (sampled from G).
 * Every image is seamless; grain and planks run along u (floor sets were rotated with their normals).
 *
 * These are generic surfaces: they are never presented as a manufacturer's decor.
 */

interface FileInfo {
  readonly width: number;
  readonly height: number;
  readonly bytes: number;
  readonly md5: string;
  readonly meanLinearRgb?: readonly [number, number, number];
  readonly mean?: number;
}

interface SetInfo {
  readonly name: string;
  readonly authors: readonly string[];
  readonly url: string;
  readonly physicalSizeMm: readonly [number, number];
  readonly coverageM: readonly [number, number];
  readonly rotatedCcw90: boolean;
  readonly files: Readonly<Record<string, FileInfo>>;
}

const SETS = (manifest as unknown as { assets: Readonly<Record<string, SetInfo>> }).assets;

export type PbrSetId = "oak_veneer_02" | "oak_veneer_03" | "walnut_veneer_02" | "white_plaster_02" | "wood_floor" | "laminate_floor_03" | "herringbone_parquet";

type PbrSemantic = Extract<TextureSemantic, "baseColor" | "normal" | "roughness">;

/** File names of each semantic's tiers. */
const TIER_FILES: Readonly<Record<PbrSemantic, { standard: string; enhanced: string; format: "jpeg" | "png" }>> = {
  baseColor: { standard: "albedo_1k.jpg", enhanced: "albedo_2k.jpg", format: "jpeg" },
  normal: { standard: "normal_512.png", enhanced: "normal_1k.png", format: "png" },
  roughness: { standard: "roughness_256.png", enhanced: "roughness_1k.png", format: "png" },
};

function setInfo(set: PbrSetId): SetInfo {
  const info = SETS[set];
  if (!info) throw new Error(`Unknown PBR texture set "${set}"`);
  return info;
}

export function pbrAssetId(set: PbrSetId, semantic: PbrSemantic): AssetId {
  return `pbr:${set}/${semantic}`;
}

/** Registration shared by a set's maps: its normal and roughness lie in register with its base colour. */
export function pbrRegistrationId(set: PbrSetId): string {
  return `pbr:${set}`;
}

export function pbrCoverage(set: PbrSetId): MeterPair {
  const [u, v] = setInfo(set).coverageM;
  return [u, v];
}

function variant(set: PbrSetId, file: string, format: "jpeg" | "png"): TextureVariant {
  const f = setInfo(set).files[file];
  if (!f) throw new Error(`PBR set "${set}" has no file ${file}`);
  return { url: `/textures/pbr/${set}/${file}`, width: f.width, height: f.height, format };
}

function provenance(set: PbrSetId): string {
  const s = setInfo(set);
  const [w, h] = s.physicalSizeMm;
  return `Generic texture (not a manufacturer decor): Poly Haven "${s.name}" by ${s.authors.join(", ")}, CC0 1.0, ${s.url}; ${w} × ${h} mm${s.rotatedCcw90 ? ", rotated 90° so planks run along u" : ""}`;
}

/** Texture assets of every processed set (base colour only where the set has one in the runtime files). */
export function pbrTextureAssets(): TextureAsset[] {
  const assets: TextureAsset[] = [];
  for (const set of Object.keys(SETS) as PbrSetId[]) {
    const files = setInfo(set).files;
    for (const semantic of Object.keys(TIER_FILES) as PbrSemantic[]) {
      const tiers = TIER_FILES[semantic];
      const standard = files[tiers.standard];
      if (!standard) continue;
      const colorSpace = semantic === "baseColor" ? "srgb" : "data";
      const statistics =
        semantic === "baseColor" && standard.meanLinearRgb
          ? { meanLinearRgb: standard.meanLinearRgb }
          : semantic === "roughness" && standard.mean !== undefined
            ? { meanValue: standard.mean }
            : undefined;
      assets.push({
        id: pbrAssetId(set, semantic),
        semantic,
        colorSpace,
        variants: { standard: variant(set, tiers.standard, tiers.format), enhanced: variant(set, tiers.enhanced, tiers.format) },
        provenance: provenance(set),
        ...(statistics ? { statistics } : {}),
      });
    }
  }
  return assets;
}

/** A map of a set, in register with the set's own base colour (same registration, coverage, phase). */
export function pbrRegisteredMap(set: PbrSetId, semantic: PbrSemantic): MaterialMap {
  return {
    assetId: pbrAssetId(set, semantic),
    alignment: { kind: "decor-registered", registrationId: pbrRegistrationId(set), coverageM: pbrCoverage(set), phaseM: [0, 0] },
  };
}

/** Normal + roughness of a set that also supplies the base colour (wood, floors). */
export function pbrRegisteredSurface(id: string, category: MaterialCategory, set: PbrSetId, normalScale: number): SurfaceProfile {
  return {
    id,
    category,
    sharing: { kind: "decor-registered", registrationId: pbrRegistrationId(set) },
    maps: { normal: pbrRegisteredMap(set, "normal"), roughness: pbrRegisteredMap(set, "roughness") },
    normalScale: [normalScale, normalScale],
  };
}

/** Normal + roughness of an isotropic set used without its colour (plaster under a configured paint colour). */
export function pbrIsotropicSurface(id: string, category: MaterialCategory, set: PbrSetId, normalScale: number): SurfaceProfile {
  const alignment = { kind: "surface-repeat" as const, coverageM: pbrCoverage(set), directional: false };
  return {
    id,
    category,
    sharing: { kind: "universal-isotropic" },
    maps: { normal: { assetId: pbrAssetId(set, "normal"), alignment }, roughness: { assetId: pbrAssetId(set, "roughness"), alignment } },
    normalScale: [normalScale, normalScale],
  };
}

function linearToSrgbByte(c: number): number {
  const v = c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
  return Math.round(Math.min(1, Math.max(0, v)) * 255);
}

/** sRGB hex of the image's measured mean colour (shown while it loads). */
export function pbrMeanSrgbHex(set: PbrSetId): string {
  const mean = setInfo(set).files[TIER_FILES.baseColor.standard]?.meanLinearRgb;
  if (!mean) throw new Error(`PBR set "${set}" has no measured base colour`);
  return `#${mean.map((c) => linearToSrgbByte(c).toString(16).padStart(2, "0")).join("").toUpperCase()}`;
}

/** The set's own base colour, uncalibrated (floors: the image is the appearance). */
export function pbrBaseColor(set: PbrSetId): BaseColor {
  return { kind: "map", map: pbrRegisteredMap(set, "baseColor"), meanSrgbHex: pbrMeanSrgbHex(set) };
}

/**
 * The set's base colour calibrated to a catalog colour (generic wood for a catalog finish): the
 * surface's mean becomes the catalog colour, the image's own variation is kept (see BaseColor).
 */
export function pbrCalibratedBaseColor(set: PbrSetId, catalogSrgbHex: string): BaseColor {
  return {
    kind: "map",
    map: pbrRegisteredMap(set, "baseColor"),
    meanSrgbHex: catalogSrgbHex.toUpperCase(),
    calibration: { kind: "match-mean-linear", targetSrgbHex: catalogSrgbHex.toUpperCase() },
  };
}
