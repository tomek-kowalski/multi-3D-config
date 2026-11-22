import { calculateCompartmentBounds } from "../compartments/layout";
import type { CabinetConfiguration } from "../furniture/types";
import { buildFurniture } from "../geometry/buildFurniture";
import type { PanelType } from "../geometry/types";
import { fail, ok, type Issue, type Result } from "../shared/issues";
import type { WooLineItem } from "./types";

/**
 * Cabinet → WooCommerce component products, implementing the catalog rules of
 * docs/woocommerce-catalog-generation.md (owner specification of 2026-11-20). The configuration keeps
 * the exact millimetre values; WooCommerce receives the band-level product (variation) of every
 * component plus the colour product of the component's material slot.
 *
 * If the catalog generator's config changes (bands, products, axes), this table must change with it.
 */

interface Band {
  readonly min: number;
  readonly max: number;
}

type BandKey = "T" | "BT" | "W" | "H" | "D";

/** §4 Pricing bands: key → (SKU prefix, ranges). T and BT both use the SKU prefix "T". */
export const CABINET_BANDS: Readonly<Record<BandKey, { prefix: string; ranges: readonly Band[] }>> = {
  T: { prefix: "T", ranges: [{ min: 16, max: 18 }, { min: 19, max: 22 }, { min: 23, max: 25 }] },
  BT: { prefix: "T", ranges: [{ min: 3, max: 8 }, { min: 9, max: 14 }, { min: 15, max: 18 }] },
  W: { prefix: "W", ranges: [{ min: 300, max: 800 }, { min: 801, max: 1600 }, { min: 1601, max: 2400 }] },
  H: { prefix: "H", ranges: [{ min: 400, max: 1200 }, { min: 1201, max: 2000 }, { min: 2001, max: 2800 }] },
  D: { prefix: "D", ranges: [{ min: 200, max: 400 }, { min: 401, max: 600 }, { min: 601, max: 900 }] },
};

/** §2/§3 Products, their PanelTypes and band axes in attribute (= SKU token) order. */
const PRODUCTS: readonly { sku: string; partTypes: readonly PanelType[]; axes: readonly BandKey[] }[] = [
  { sku: "KC-SIDE", partTypes: ["left-side", "right-side"], axes: ["T", "H", "W"] },
  { sku: "KC-TOP-BOTTOM", partTypes: ["top", "bottom"], axes: ["T", "W", "D"] },
  { sku: "KC-SHELF", partTypes: ["shelf"], axes: ["T", "D"] },
  { sku: "KC-DIVIDER", partTypes: ["divider"], axes: ["T", "D"] },
  { sku: "KC-BACK-PANEL", partTypes: ["back-panel"], axes: ["BT", "W", "H"] },
  { sku: "KC-PLINTH", partTypes: ["plinth"], axes: ["W"] },
  { sku: "KC-DOOR", partTypes: ["door"], axes: ["W", "H"] },
  { sku: "KC-DRAWER-FRONT", partTypes: ["drawer-front"], axes: [] },
  { sku: "KC-DRAWER-SIDE", partTypes: ["drawer-side"], axes: [] },
  { sku: "KC-DRAWER-BACK", partTypes: ["drawer-back"], axes: [] },
  { sku: "KC-DRAWER-BOTTOM", partTypes: ["drawer-bottom"], axes: [] },
];

const PRODUCT_BY_PART = new Map(PRODUCTS.flatMap((p) => p.partTypes.map((t) => [t, p] as const)));

/** §7 Colour products: one simple product per board finish / handle finish. */
export function colorSku(materialId: string): string {
  return `KC-COLOR-${materialId.toUpperCase()}`;
}

export function handleFinishSku(finishId: string): string {
  return `KC-HANDLE-FINISH-${finishId.toUpperCase()}`;
}

/** §5 Bands are inclusive; values are whole millimetres (non-integers are rejected, never rounded). */
export function resolveBand(key: BandKey, value: number, options: { clampBelow?: boolean } = {}): Result<string> {
  if (!Number.isInteger(value)) return fail({ code: "catalog_non_integer", params: { band: key, value } });
  const { prefix, ranges } = CABINET_BANDS[key];
  const effective = options.clampBelow && value < ranges[0].min ? ranges[0].min : value;
  const band = ranges.find((r) => effective >= r.min && effective <= r.max);
  if (!band) return fail({ code: "catalog_out_of_band", params: { band: key, value } });
  return ok(`${prefix}${band.min}-${band.max}`);
}

/** Half-up rounding to whole millimetres (800.5 → 801), used for door leaf values (§4). */
function roundHalfUp(value: number): number {
  return Math.floor(value + 0.5);
}

/** §4 Door exception: per leaf, from the door opening (the compartment); double doors halve the width. */
export function doorLeafValues(openingWidth: number, openingHeight: number, layout: "single" | "double") {
  const leaves = layout === "double" ? 2 : 1;
  return { leaves, width: roundHalfUp(openingWidth / leaves), height: roundHalfUp(openingHeight) };
}

/** Every band is looked up from the customer-selected cabinet value (§4), except doors. */
function cabinetValue(configuration: CabinetConfiguration, key: BandKey): number {
  switch (key) {
    case "T":
      return configuration.panelThickness;
    case "BT":
      return configuration.backPanel.thickness;
    case "W":
      return configuration.width;
    case "H":
      return configuration.height;
    case "D":
      return configuration.depth;
  }
}

function variationSku(parent: string, tokens: readonly string[]): string {
  return tokens.length === 0 ? parent : `${parent}-${tokens.join("-")}`;
}

const HANDLE_SKU_TOKEN: Readonly<Record<string, string>> = { knob: "KNOB", bar: "BAR", recessed: "RECESSED" };

/**
 * The WooCommerce lines that order one configured cabinet: one line per component product with its
 * occurrence count, each followed by the colour product of its material slot (same quantity), plus
 * handles and handle finishes. Lines are aggregated by (SKU, note) and sorted for stable output.
 */
export function cabinetOrderItems(configuration: CabinetConfiguration): Result<readonly WooLineItem[]> {
  const { panels, hardware } = buildFurniture(configuration);
  const issues: Issue[] = [];
  const lines = new Map<string, { sku: string; quantity: number; note?: string }>();
  const add = (sku: string, quantity: number, note?: string) => {
    const key = `${sku}|${note ?? ""}`;
    const line = lines.get(key);
    if (line) line.quantity += quantity;
    else lines.set(key, { sku, quantity, ...(note ? { note } : {}) });
  };

  const compartments = new Map(calculateCompartmentBounds(configuration).map((c) => [c.id, c.bounds]));
  const doorsCounted = new Set<string>();

  for (const part of panels) {
    const product = PRODUCT_BY_PART.get(part.type);
    if (!product) {
      issues.push({ code: "catalog_unmapped_part", params: { part: part.type } });
      continue;
    }
    let sku: string;
    let quantity = 1;
    if (part.type === "door") {
      // A door is ordered per attachment (single: 1 leaf, double: 2 leaves of the half width).
      if (!part.attachmentId || doorsCounted.has(part.attachmentId)) continue;
      doorsCounted.add(part.attachmentId);
      const door = configuration.attachments.find((a) => a.id === part.attachmentId);
      const opening = door && compartments.get(door.compartmentId);
      if (!door || door.type !== "door" || !opening) {
        issues.push({ code: "catalog_unmapped_part", params: { part: part.id } });
        continue;
      }
      const leaf = doorLeafValues(opening.dimensions.width, opening.dimensions.height, door.configuration.layout);
      const w = resolveBand("W", leaf.width, { clampBelow: true });
      const h = resolveBand("H", leaf.height, { clampBelow: true });
      if (!w.ok || !h.ok) {
        issues.push(...(!w.ok ? w.issues : []), ...(!h.ok ? h.issues : []));
        continue;
      }
      sku = variationSku(product.sku, [w.value, h.value]);
      quantity = leaf.leaves;
    } else {
      const tokens: string[] = [];
      for (const axis of product.axes) {
        const band = resolveBand(axis, cabinetValue(configuration, axis));
        if (band.ok) tokens.push(band.value);
        else issues.push(...band.issues);
      }
      if (tokens.length !== product.axes.length) continue;
      sku = variationSku(product.sku, tokens);
    }
    add(sku, quantity);
    add(colorSku(part.materialId), quantity, sku);
  }

  for (const handle of hardware) {
    const token = HANDLE_SKU_TOKEN[handle.type];
    if (!token) continue;
    const sku = `KC-HANDLE-${token}`;
    add(sku, 1);
    add(handleFinishSku(handle.finish), 1, sku);
  }

  if (issues.length > 0) return fail(...issues);
  const sorted = [...lines.values()].sort((a, b) => a.sku.localeCompare(b.sku) || (a.note ?? "").localeCompare(b.note ?? ""));
  return ok(sorted.map((l) => ({ kind: "sku" as const, ...l })));
}
