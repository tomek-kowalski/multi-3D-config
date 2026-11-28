import type { FinishProfile, MaterialCategory, SurfaceProfile } from "./contracts";
import { pbrIsotropicSurface } from "./pbrAssets";

/**
 * Reusable physical surface and finish profiles. A profile describes a kind of surface, never a
 * product: every material keeps its own colour identity and only shares the response of its finish.
 *
 * Values are the ones each renderer already used, unified (previously the viewport and the photo
 * renderer disagreed for the same surface — e.g. gloss decors 0.25 vs 0.12 + clear coat):
 * - dielectrics use the standard specular response (F0 = 0.04, specularIntensity 1), which is
 *   physically right for melamine, lacquer, paint and plastic;
 * - metals are fully metallic (a reflection environment is always provided, see SurfaceEnvironment);
 * - relief is never inferred from colour images: only measured normal/roughness maps are used (Phase 4:
 *   generic CC0 sets, see pbrAssets.ts; manufacturer decors stay map-free until measured maps exist).
 */

/**
 * Normal strength of the plaster relief under paint. The source is a raw trowelled plaster (slope
 * standard deviation 0.083 at 1K); a painted interior wall shows a much softer texture: 0.35 keeps it
 * readable under raking light near windows and invisible at frontal light (calibrated on renders, see
 * docs/material-phase4ab-report.md). The roughness map (mean 0.909, calibrated to the paint finish)
 * adds slight sheen variation only.
 */
export const WALL_PLASTER_NORMAL_SCALE = 0.35;

const flatSurface = (id: string, category: MaterialCategory): SurfaceProfile => ({
  id,
  category,
  sharing: { kind: "universal-isotropic" },
  maps: {},
  normalScale: [1, 1],
});

export const SURFACE_PROFILES: readonly SurfaceProfile[] = [
  flatSurface("surface/smooth-board", "laminate"),
  flatSurface("surface/wood-board", "wood"),
  flatSurface("surface/veneer", "veneer"),
  flatSurface("surface/lacquer", "lacquer"),
  flatSurface("surface/textile", "textile"),
  flatSurface("surface/leather", "leather"),
  flatSurface("surface/metal", "metal"),
  flatSurface("surface/plastic", "plastic"),
  flatSurface("surface/glass", "glass"),
  flatSurface("surface/stone", "stone"),
  flatSurface("surface/ceramic", "ceramic"),
  flatSurface("surface/concrete", "concrete"),
  flatSurface("surface/paint", "paint"),
  // Room surfaces own their profiles: wall plaster/paint and floor-covering microstructure (Phase 4 maps)
  // can never reach doors, coated hardware, cabinet boards or decors that share a category.
  pbrIsotropicSurface("surface/wall-plaster", "paint", "white_plaster_02", WALL_PLASTER_NORMAL_SCALE),
  flatSurface("surface/floor-covering", "laminate"),
];

const dielectric = (id: string, roughness: number, extra: Partial<FinishProfile> = {}): FinishProfile => ({
  id,
  roughness,
  metalness: 0,
  specularIntensity: 1,
  ...extra,
});

export const FINISH_PROFILES: readonly FinishProfile[] = [
  // Boards: melamine / laminate prints (matt to satin).
  dielectric("finish/board-matte", 0.85),
  dielectric("finish/board-satin", 0.65),
  // High-gloss lacquer or acrylic (decor structures MG, AG, HG, PG): smooth clear coat over the decor.
  dielectric("finish/lacquer-high-gloss", 0.12, { clearcoat: { amount: 1, roughness: 0.04 } }),
  // Metal-look decor boards (AL codes): metallic foil laminate.
  { id: "finish/metal-foil-satin", roughness: 0.32, metalness: 0.75, specularIntensity: 1 },
  // Metals.
  { id: "finish/metal-polished", roughness: 0.12, metalness: 1, specularIntensity: 1 },
  { id: "finish/metal-brushed", roughness: 0.35, metalness: 1, specularIntensity: 1 },
  { id: "finish/metal-satin", roughness: 0.28, metalness: 1, specularIntensity: 1 },
  // Painted steel of the bed mechanism (supplied model: metallic 0.5 / roughness 0.45; photo 0.4).
  { id: "finish/mechanism-painted-metal", roughness: 0.4, metalness: 0.5, specularIntensity: 1 },
  // Coatings and plastics.
  dielectric("finish/powder-coat-matte", 0.6),
  dielectric("finish/plastic-satin", 0.45),
  dielectric("finish/plastic-matte", 0.9),
  dielectric("finish/paint-satin", 0.45),
  // Matt emulsion paint (walls).
  dielectric("finish/paint-matte", 0.92),
  // Floor covering (configured colour only; no plank pattern selected).
  dielectric("finish/floor-satin", 0.7),
  // Floor materials (generic sets; the map's measured variation is scaled around these means):
  // oiled/matt-lacquered planks (sample mean 0.47), satin laminate (0.52), lacquered parquet - the sample
  // is a fresh high-gloss coat (0.10), held at a satin 0.32 so the floor never reads as a mirror.
  dielectric("finish/floor-wood-satin", 0.5),
  dielectric("finish/floor-laminate-satin", 0.5),
  dielectric("finish/floor-parquet-lacquered", 0.32),
  // Mattress ticking: fully rough fabric with a soft sheen rim; real white cotton/polyester ticking
  // reflects about 70 % (the supplied model's 0.90 albedo rendered as flat white).
  dielectric("finish/textile-ticking", 1, { maxLinearAlbedo: 0.72, sheen: { amount: 0.35, roughness: 0.8, baseColorFactor: 0.6 } }),
  // Upholstery fabric (no product uses it yet): rough with a gentle sheen.
  dielectric("finish/textile-upholstery", 0.95, { maxLinearAlbedo: 0.75, sheen: { amount: 0.5, roughness: 0.6, baseColorFactor: 0.8 } }),
  dielectric("finish/leather-semi-matte", 0.55, { maxLinearAlbedo: 0.8 }),
  dielectric("finish/stone-honed", 0.5),
  dielectric("finish/ceramic-glazed", 0.15, { clearcoat: { amount: 0.6, roughness: 0.05 } }),
  dielectric("finish/concrete-sealed", 0.75),
  // Shown for manufacturer decors without an authorized swatch: a plain, neutral dielectric (never the
  // selected structure's gloss or metal response, which would suggest a known appearance).
  dielectric("finish/unavailable-neutral", 0.75),
  // Clear float glass (windows, doors, glass fronts).
  {
    id: "finish/glass-clear",
    roughness: 0,
    metalness: 0,
    specularIntensity: 1,
    transmission: { amount: 1, ior: 1.5, thicknessM: 0.004, tintSrgbHex: "#F3F8F6", proxy: { srgbHex: "#A9CBE0", opacity: 0.45 } },
  },
];
