import { findDecor, getBedOptions, type BedDecor } from "../beds/catalog";
import { MATERIAL_CATALOG, type MaterialId as CabinetMaterialId } from "../furniture/materials";
import { HARDWARE_FINISHES, type HardwareFinishId } from "../hardware/catalog";
import { FLOOR_MATERIAL_IDS, type FloorMaterialId } from "../room/types";
import type {
  BaseColor,
  DecorDefinition,
  FinishProfile,
  LegacyResolver,
  MaterialDefinition,
  MaterialRegistry,
  MaterialSelection,
  RegistryData,
  RegistryResolvedMaterial,
  SurfaceAssignment,
} from "./contracts";
import { pbrBaseColor, pbrCalibratedBaseColor, pbrRegisteredSurface, pbrTextureAssets, type PbrSetId } from "./pbrAssets";
import { FINISH_PROFILES, SURFACE_PROFILES } from "./profiles";
import { DECOR_SWATCH_COVERAGE_M, decorAssetId, decorTextureAssets, hasDecorTexture } from "./textures";

/**
 * Existing selections → universal registry. Every existing identifier keeps its meaning: cabinet
 * finish IDs, ClickBed decor entries (product, category, entry), hardware finish IDs and the room's
 * configured colours resolve here, for rendering only.
 */

// ---- Cabinet finishes (src/domain/furniture/materials.ts): solid colours, their own roughness. ----

export const CABINET_FINISH_NAMESPACE = "cabinet-finish";

const cabinetFinishProfile = (id: string, roughness: number): FinishProfile => ({
  id: `finish/cabinet-${id}`,
  roughness,
  metalness: 0,
  specularIntensity: 1,
});

/**
 * Generic wood images for the wood finishes of the catalog (Phase 4A). The catalog colour stays the
 * reference: each image is calibrated to it (BaseColor.calibration), so the finish keeps its ID and
 * colour and gains grain, pores and gloss variation. These are generic veneers, not a board
 * manufacturer's decor. Data only: another finish (or another furniture type's finish) gains a texture
 * by adding an entry here.
 */
export const CABINET_WOOD_TEXTURES: Readonly<Partial<Record<CabinetMaterialId, PbrSetId>>> = {
  "natural-oak": "oak_veneer_02",
  "sonoma-oak": "oak_veneer_03",
  walnut: "walnut_veneer_02",
};

/** Surface profile of a generic set's own relief and gloss (in register with its base colour). */
const pbrSurfaceId = (set: PbrSetId) => `surface/pbr-${set}`;

const CABINET_MATERIALS: MaterialDefinition[] = MATERIAL_CATALOG.map((m): MaterialDefinition => {
  const set = CABINET_WOOD_TEXTURES[m.id];
  return set
    ? {
        id: `cabinet/${m.id}`,
        category: "veneer",
        color: pbrCalibratedBaseColor(set, m.color),
        surfaceProfileId: pbrSurfaceId(set),
        finishProfileId: `finish/cabinet-${m.id}`,
        provenance: `src/domain/furniture/materials.ts colour (visual approximation) on a generic ${set} texture calibrated to it`,
      }
    : {
        id: `cabinet/${m.id}`,
        category: "laminate",
        color: { kind: "solid", srgbHex: m.color },
        surfaceProfileId: "surface/smooth-board",
        finishProfileId: `finish/cabinet-${m.id}`,
        provenance: "src/domain/furniture/materials.ts (visual approximation, not a certified manufacturer value)",
      };
});

export function cabinetFinishSelection(id: CabinetMaterialId): MaterialSelection {
  return { kind: "legacy", namespace: CABINET_FINISH_NAMESPACE, key: [id] };
}

const cabinetResolver: LegacyResolver = {
  namespace: CABINET_FINISH_NAMESPACE,
  resolve: ([id], registry) => {
    if (!MATERIAL_CATALOG.some((m) => m.id === id)) return null;
    return registry.resolve({ kind: "registered", id: `cabinet/${id}` });
  },
};

// ---- Hardware finishes (src/domain/hardware/catalog.ts). ----

export const HARDWARE_FINISH_NAMESPACE = "hardware-finish";

/** Physical class of each generic hardware finish: bare metals are metals, coated ones dielectric. */
const HARDWARE_PROFILES: Readonly<Record<HardwareFinishId, { category: MaterialDefinition["category"]; finish: string }>> = {
  chrome: { category: "metal", finish: "finish/metal-polished" },
  "brushed-steel": { category: "metal", finish: "finish/metal-brushed" },
  brass: { category: "metal", finish: "finish/metal-satin" },
  "black-matte": { category: "paint", finish: "finish/powder-coat-matte" },
  white: { category: "paint", finish: "finish/plastic-satin" },
};

const HARDWARE_MATERIALS: MaterialDefinition[] = HARDWARE_FINISHES.map((f) => ({
  id: `hardware/${f.id}`,
  category: HARDWARE_PROFILES[f.id].category,
  color: { kind: "solid", srgbHex: f.color },
  surfaceProfileId: HARDWARE_PROFILES[f.id].category === "metal" ? "surface/metal" : "surface/paint",
  finishProfileId: HARDWARE_PROFILES[f.id].finish,
  provenance: "src/domain/hardware/catalog.ts (generic finish)",
}));

export function hardwareFinishSelection(id: HardwareFinishId): MaterialSelection {
  return { kind: "legacy", namespace: HARDWARE_FINISH_NAMESPACE, key: [id] };
}

const hardwareResolver: LegacyResolver = {
  namespace: HARDWARE_FINISH_NAMESPACE,
  resolve: ([id], registry) => (HARDWARE_FINISHES.some((f) => f.id === id) ? registry.resolve({ kind: "registered", id: `hardware/${id}` }) : null),
};

// ---- ClickBed decors (src/domain/beds/data/clickbedOptions.json). ----

export const BED_DECOR_NAMESPACE = "clickbed-decor";

/** Neutral preview of decors the supplied catalog has no swatch for (the unavailable indicator). */
export const UNAVAILABLE_PREVIEW_HEX = "#B9B6B0";

/** High-gloss structures: MG mirror gloss, AG acrylic gloss, HG/PG high/premium gloss. */
const GLOSS_STRUCTURES = /^(MG|AG|HG|PG)$/;

export function decorFinishProfileId(decor: Pick<BedDecor, "code" | "structure">): string {
  if (GLOSS_STRUCTURES.test(decor.structure)) return "finish/lacquer-high-gloss";
  if (decor.code.startsWith("AL")) return "finish/metal-foil-satin";
  return "finish/board-satin";
}

function decorCategory(decor: Pick<BedDecor, "code" | "structure">): MaterialDefinition["category"] {
  if (GLOSS_STRUCTURES.test(decor.structure)) return "lacquer";
  if (decor.code.startsWith("AL")) return "metal";
  return "laminate";
}

/** Source of the ClickBed decor list (the board manufacturer is not named there). */
export const CLICKBED_DECOR_SOURCE = "ClickBed shop option form (board supplier catalog)";

/** Fallback surface of every board decor without a more specific assignment. */
const DEFAULT_BOARD_SURFACE = "surface/smooth-board";

/**
 * Surface profile assignments of the ClickBed decors (data, most specific rule wins). Today they only
 * separate the physical classes already known from the shop data — printed board, high-gloss lacquer
 * (MG/AG/HG/PG), metal foil (AL codes) — and every profile is map-free: no structure relief is
 * claimed until measured, registered maps are supplied (Phase 4 adds rules such as
 * `{ structure: "PW" } → surface/<supplier>-pw` with evidence, or per-decor registered profiles).
 */
export const CLICKBED_SURFACE_ASSIGNMENTS: readonly SurfaceAssignment[] = [
  { id: "clickbed/board", match: { manufacturer: CLICKBED_DECOR_SOURCE }, surfaceProfileId: DEFAULT_BOARD_SURFACE, evidence: "shop decor list" },
  ...["MG", "AG", "HG", "PG"].map(
    (structure): SurfaceAssignment => ({
      id: `clickbed/structure-${structure}`,
      match: { manufacturer: CLICKBED_DECOR_SOURCE, structure },
      surfaceProfileId: "surface/lacquer",
      evidence: "structure code: high-gloss lacquer/acrylic",
    }),
  ),
  ...["AL01", "AL02", "AL03", "AL04", "AL05", "AL06"].map(
    (code): SurfaceAssignment => ({
      id: `clickbed/code-${code}`,
      match: { manufacturer: CLICKBED_DECOR_SOURCE, code },
      surfaceProfileId: "surface/metal",
      evidence: "decor code: metal foil board",
    }),
  ),
];

export function decorDefinition(decor: BedDecor): DecorDefinition {
  const swatch = decor.swatch && hasDecorTexture(decor.swatch.texture) ? decor.swatch : null;
  const baseColor: BaseColor = swatch
    ? {
        kind: "map",
        map: {
          assetId: decorAssetId(swatch.texture),
          alignment: { kind: "surface-repeat", coverageM: DECOR_SWATCH_COVERAGE_M, directional: swatch.grain !== undefined && swatch.grain !== "none" },
        },
        meanSrgbHex: swatch.hex,
      }
    : { kind: "unavailable", reason: "no-authorized-swatch" };
  return {
    id: decor.id,
    manufacturer: CLICKBED_DECOR_SOURCE,
    code: decor.code,
    structure: decor.structure,
    name: decor.name,
    baseColor,
    coverageEvidence: swatch ? "legacy-assumption" : "unknown",
    sourceMatch: !swatch ? "missing" : swatch.match === "exact" ? "exact" : "same-code-alternate-structure",
  };
}

export function bedDecorSelection(productId: number, categoryId: string, decorId: string): MaterialSelection {
  return { kind: "legacy", namespace: BED_DECOR_NAMESPACE, key: [String(productId), categoryId, decorId] };
}

const bedDecorResolver: LegacyResolver = {
  namespace: BED_DECOR_NAMESPACE,
  resolve: ([product, categoryId, decorId], registry): RegistryResolvedMaterial | null => {
    let decor: BedDecor | null;
    try {
      decor = findDecor(getBedOptions(Number(product)), categoryId, decorId);
    } catch {
      return null;
    }
    if (!decor) return null;
    const definition = decorDefinition(decor);
    const color = definition.baseColor;
    // Data-driven: the decor's surface assignment, validated against its print (registration, coverage,
    // phase, orientation); an incompatible profile is used without its maps and reported.
    const { surface, issues } = registry.surfaceForDecor(definition, DEFAULT_BOARD_SURFACE);
    return {
      source: "registry",
      id: `clickbed-decor/${decor.id}`,
      label: `${decor.code} ${decor.structure}`.trim(),
      category: decorCategory(decor),
      decor: definition,
      color,
      surface,
      finish: registry.getFinishProfile(decorFinishProfileId(decor)),
      availability: color.kind === "unavailable" ? "missing-authorized-swatch" : "available",
      ...(issues.length > 0 ? { resolutionIssues: issues } : {}),
    };
  },
};

// ---- Room, openings, model slots and generic materials. ----

export const ROOM_WALL_TEMPLATE = "room/wall-paint";
export const ROOM_FLOOR_TEMPLATE = "room/floor-finish";
export const OPENING_FRAME_TEMPLATE = "room/opening-frame";
export const DOOR_LEAF_TEMPLATE = "room/door-leaf";

const template = (id: string, category: MaterialDefinition["category"], surface: string, finish: string, provenance: string): MaterialDefinition => ({
  id,
  category,
  color: { kind: "configured" },
  surfaceProfileId: surface,
  finishProfileId: finish,
  provenance,
});

const solid = (id: string, category: MaterialDefinition["category"], hex: string, surface: string, finish: string, provenance: string): MaterialDefinition => ({
  id,
  category,
  color: { kind: "solid", srgbHex: hex },
  surfaceProfileId: surface,
  finishProfileId: finish,
  provenance,
});

const ROOM_MATERIALS: MaterialDefinition[] = [
  template(ROOM_WALL_TEMPLATE, "paint", "surface/wall-plaster", "finish/paint-matte", "Configured wall colour (SpacePanel)"),
  template(ROOM_FLOOR_TEMPLATE, "laminate", "surface/floor-covering", "finish/floor-satin", "Configured floor colour (SpacePanel); no plank pattern"),
  template(OPENING_FRAME_TEMPLATE, "plastic", "surface/plastic", "finish/plastic-satin", "Window/door frame colour (roomScene.ts)"),
  template(DOOR_LEAF_TEMPLATE, "paint", "surface/paint", "finish/paint-satin", "Configured door colour"),
  solid("room/door-handle", "metal", "#8D9094", "surface/metal", "finish/metal-brushed", "Generic door handle (roomScene.ts)"),
  solid("glass/float-clear", "glass", "#F3F8F6", "surface/glass", "finish/glass-clear", "Clear float glass"),
  solid("hardware/recess-shadow", "plastic", "#1B1B1B", "surface/plastic", "finish/plastic-matte", "Dark plate of a recessed grip (HandleMesh)"),
];

/**
 * Floor materials of the room (Phase 4B): generic sets, their own colour (not calibrated: the image is
 * the appearance), relief and gloss. Planks run along u; RoomModel's floor UVs put u along the selected
 * plank axis at physical scale.
 */
const FLOOR_MATERIAL_SETS: Readonly<Record<FloorMaterialId, { set: PbrSetId; category: MaterialDefinition["category"]; finish: string; normalScale: number }>> = {
  "wood-planks": { set: "wood_floor", category: "wood", finish: "finish/floor-wood-satin", normalScale: 1 },
  laminate: { set: "laminate_floor_03", category: "laminate", finish: "finish/floor-laminate-satin", normalScale: 1 },
  "herringbone-parquet": { set: "herringbone_parquet", category: "wood", finish: "finish/floor-parquet-lacquered", normalScale: 1 },
};

export function floorMaterialRegistryId(id: FloorMaterialId): string {
  return `floor/${id}`;
}

const FLOOR_MATERIALS: MaterialDefinition[] = FLOOR_MATERIAL_IDS.map((id) => ({
  id: floorMaterialRegistryId(id),
  category: FLOOR_MATERIAL_SETS[id].category,
  color: pbrBaseColor(FLOOR_MATERIAL_SETS[id].set),
  surfaceProfileId: pbrSurfaceId(FLOOR_MATERIAL_SETS[id].set),
  finishProfileId: FLOOR_MATERIAL_SETS[id].finish,
  provenance: `Generic floor texture ${FLOOR_MATERIAL_SETS[id].set} (CC0), not a flooring manufacturer's product`,
}));

/** Relief/gloss profiles of the generic sets that supply their own colour (wood finishes, floors). */
const PBR_SURFACES = [
  ...Object.values(CABINET_WOOD_TEXTURES).map((set) => pbrRegisteredSurface(pbrSurfaceId(set!), "veneer", set!, 1)),
  ...FLOOR_MATERIAL_IDS.map((id) => {
    const f = FLOOR_MATERIAL_SETS[id];
    return pbrRegisteredSurface(pbrSurfaceId(f.set), f.category, f.set, f.normalScale);
  }),
];

export const REGISTERED = {
  doorHandle: "room/door-handle",
  glass: "glass/float-clear",
  recessShadow: "hardware/recess-shadow",
} as const;

/** ClickBed model slots (scripts/assets/convert-clickbed.mjs): authored materials with finish overrides. */
export const BED_SLOT_FINISHES = {
  mattress: "finish/textile-ticking",
  hardware: "finish/mechanism-painted-metal",
} as const;

export const MATERIAL_SEED: RegistryData = {
  textures: [...decorTextureAssets(), ...pbrTextureAssets()],
  surfaces: [...SURFACE_PROFILES, ...PBR_SURFACES],
  finishes: [...FINISH_PROFILES, ...MATERIAL_CATALOG.map((m) => cabinetFinishProfile(m.id, m.roughness))],
  materials: [...CABINET_MATERIALS, ...HARDWARE_MATERIALS, ...ROOM_MATERIALS, ...FLOOR_MATERIALS],
  legacy: [cabinetResolver, hardwareResolver, bedDecorResolver],
  surfaceAssignments: CLICKBED_SURFACE_ASSIGNMENTS,
};

export function configuredColor(templateId: string, srgbHex: string): MaterialSelection {
  return { kind: "configured-color", templateId, srgbHex };
}

export type { MaterialRegistry };
