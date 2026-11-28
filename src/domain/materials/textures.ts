import type { AssetId, MeterPair, TextureAsset } from "./contracts";
import decorTextures from "./data/decorTextures.json";

/**
 * Texture manifest: the existing, authorized image files, described as assets. Nothing is invented:
 * every entry is a file in public/, measured by scripts/assets/decor-texture-manifest.mjs.
 *
 * ClickBed decor swatches: two tiers of the same crop of the supplier's board catalog —
 * standard /textures/decors/<file> (256²) and enhanced /textures/decors/hd/<file> (≈400 px). Both are
 * sRGB base colour only; no tier contains measured relief or roughness.
 */

interface DecorFileInfo {
  readonly standard: readonly [number, number];
  readonly enhanced: readonly [number, number];
  readonly standardBytes: number;
  readonly enhancedBytes: number;
}

const FILES = (decorTextures as unknown as { files: Readonly<Record<string, DecorFileInfo>> }).files;

/**
 * Physical size one decor swatch covers. Legacy assumption carried over unchanged from the deployed
 * ClickBed rendering (BedModel SWATCH_SIZE_M): no supplier measurement exists for the catalog crops.
 */
export const DECOR_SWATCH_COVERAGE_M: MeterPair = [0.6, 0.6];

/**
 * A uniform swatch compresses to about 1.65 kB at 256²; real pattern detail takes several kB. Below
 * this size the enhanced tier adds no visible information (measured: 46 pixel-uniform previews).
 */
const LOW_DETAIL_BYTES = 2000;

export function decorAssetId(file: string): AssetId {
  return `decor:${file}`;
}

export function decorTextureAssets(): TextureAsset[] {
  return Object.entries(FILES).map(([file, info]) => ({
    id: decorAssetId(file),
    semantic: "baseColor" as const,
    colorSpace: "srgb" as const,
    variants: {
      standard: { url: `/textures/decors/${file}`, width: info.standard[0], height: info.standard[1], format: "jpeg" as const },
      enhanced: { url: `/textures/decors/hd/${file}`, width: info.enhanced[0], height: info.enhanced[1], format: "jpeg" as const },
    },
    provenance: "Supplier board catalog crop (scripts/clickbed/sample_decor_swatches.py); see docs/clickbed-assets.md",
    lowDetail: info.standardBytes < LOW_DETAIL_BYTES,
  }));
}

export function hasDecorTexture(file: string): boolean {
  return file in FILES;
}
