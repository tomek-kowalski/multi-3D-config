import type { Arrangement } from "../arrangement/types";
import { getFurnitureType } from "../modules/registry";
import type { ConfigurationSummaryRow, ModuleFootprint, ModuleId, ModuleInstance, ProductReference } from "../modules/types";
import { parseArrangementDocument, toArrangementDocument, type ArrangementDocument } from "../serialization/arrangementJson";
import { fail, ok, type Issue, type Result } from "../shared/issues";
import type { Placement } from "../spatial/geometry";
import type { WooLineItem } from "./types";

/**
 * The order payload sent to WooCommerce (wordpress/multi3d-configurator). It contains:
 * - `modules`: what to add to the cart, per ordered instance (WooCommerce line items), with the module's
 *   instance id, type, product reference, dimensions, placement and a readable summary;
 * - `arrangement`: the complete arrangement document, so the shop keeps everything needed to
 *   reconstruct the ordered furniture and its layout — also when only some modules are ordered.
 * Prices are never part of the payload: WooCommerce prices every line itself.
 */
export const ORDER_FORMAT = "multi3d-order";
export const ORDER_SCHEMA_VERSION = 1;

export interface OrderedModule {
  readonly moduleId: ModuleId;
  readonly typeId: string;
  readonly productReference: ProductReference;
  readonly dimensions: ModuleFootprint;
  readonly placement: Placement;
  readonly state: string;
  readonly summary: readonly ConfigurationSummaryRow[];
  readonly items: readonly WooLineItem[];
}

export interface OrderPayload {
  readonly format: typeof ORDER_FORMAT;
  readonly schemaVersion: typeof ORDER_SCHEMA_VERSION;
  /** `arrangement`: every instance; `modules`: a selection. */
  readonly scope: "arrangement" | "modules";
  readonly arrangement: ArrangementDocument;
  readonly modules: readonly OrderedModule[];
}

function orderModule(instance: ModuleInstance): Result<OrderedModule> {
  const type = getFurnitureType(instance.typeId);
  const issues = type.validate(instance.configuration);
  if (issues.length > 0) return fail(...issues.map((i) => ({ ...i, params: { ...i.params, moduleId: instance.id } })));
  const items = type.orderItems(instance.configuration);
  if (!items.ok) return fail(...items.issues.map((i) => ({ ...i, params: { ...i.params, moduleId: instance.id } })));
  return ok({
    moduleId: instance.id,
    typeId: instance.typeId,
    productReference: type.productReference(instance.configuration),
    dimensions: type.footprint(instance.configuration),
    placement: instance.placement,
    state: instance.state,
    summary: type.summary(instance.configuration),
    items: items.value,
  });
}

/** Builds the payload for the whole arrangement (no ids) or for selected modules. */
export function buildOrder(arrangement: Arrangement, moduleIds?: readonly ModuleId[]): Result<OrderPayload> {
  const selected = moduleIds ? arrangement.modules.filter((m) => moduleIds.includes(m.id)) : arrangement.modules;
  if (moduleIds && selected.length !== moduleIds.length) return fail({ code: "module_not_found" });
  if (selected.length === 0) return fail({ code: "order_empty" });
  const issues: Issue[] = [];
  const modules: OrderedModule[] = [];
  for (const instance of selected) {
    const result = orderModule(instance);
    if (result.ok) modules.push(result.value);
    else issues.push(...result.issues);
  }
  if (issues.length > 0) return fail(...issues);
  return ok({
    format: ORDER_FORMAT,
    schemaVersion: ORDER_SCHEMA_VERSION,
    scope: moduleIds ? "modules" : "arrangement",
    arrangement: toArrangementDocument(arrangement),
    modules,
  });
}

/**
 * Rebuilds the arrangement from a stored order and checks that every ordered module's line items
 * still follow from its stored configuration (so the order can be reproduced exactly).
 */
export function reconstructOrder(payload: unknown): Result<{ arrangement: Arrangement; orderedModuleIds: ModuleId[] }> {
  if (typeof payload !== "object" || payload === null) return fail({ code: "invalid_document" });
  const p = payload as Partial<OrderPayload>;
  if (p.format !== ORDER_FORMAT || p.schemaVersion !== ORDER_SCHEMA_VERSION || !Array.isArray(p.modules)) {
    return fail({ code: "invalid_document", path: "format" });
  }
  const arrangement = parseArrangementDocument(p.arrangement);
  if (!arrangement.ok) return arrangement;
  const issues: Issue[] = [];
  for (const ordered of p.modules) {
    const instance = arrangement.value.modules.find((m) => m.id === ordered.moduleId);
    if (!instance) {
      issues.push({ code: "module_not_found", params: { id: String(ordered.moduleId) } });
      continue;
    }
    const items = getFurnitureType(instance.typeId).orderItems(instance.configuration);
    if (!items.ok || JSON.stringify(items.value) !== JSON.stringify(ordered.items)) {
      issues.push({ code: "order_items_mismatch", params: { id: instance.id } });
    }
  }
  if (issues.length > 0) return fail(...issues);
  return ok({ arrangement: arrangement.value, orderedModuleIds: p.modules.map((m) => m.moduleId) });
}
