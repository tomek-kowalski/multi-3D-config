import { getFrontProjection } from "../attachments/geometry";
import { cabinetOrderItems } from "../commerce/cabinetSkus";
import { validateCabinet } from "../constraints/validateCabinet";
import { DEFAULT_CABINET } from "../furniture/defaults";
import type { CabinetConfiguration } from "../furniture/types";
import { getFurnitureBounds } from "../geometry/buildCabinet";
import { parseCabinetDocument, toCabinetDocument } from "../serialization/cabinetJson";
import { fail, ok } from "../shared/issues";
import type { FurnitureTypeDefinition } from "./types";

export const CABINET_TYPE_ID = "cabinet";

/**
 * The existing parametric cabinet (kitchen-config), adapted to the module interface. Geometry,
 * validation, materials and the JSON format are the unchanged cabinet code; this file only maps
 * them onto the shared contract. The cabinet is static furniture: one state, no operation envelope
 * at room level (door and drawer swing inside the cabinet is checked by the cabinet's own rules).
 */
export const cabinetType: FurnitureTypeDefinition<CabinetConfiguration> = {
  id: CABINET_TYPE_ID,
  geometrySource: "parametric",
  category: "cabinet",
  nameKey: "furniture.cabinet",
  createDefault: () => DEFAULT_CABINET,
  // The footprint is the carcass; overlay fronts stand out in front of it (see collisionBoxes).
  footprint: (c) => ({ width: c.width, depth: c.depth, height: c.height }),
  states: () => ["closed"],
  collisionBoxes: (c) => [getFurnitureBounds(c, getFrontProjection(c))],
  operationEnvelope: () => null,
  validate: (c) =>
    validateCabinet(c).errors.map((e) => ({
      code: `cabinet.${e.code}`,
      path: e.field,
      // The cabinet's own (Polish) message is kept for detail; the UI localizes by code.
      params: { message: e.message },
    })),
  serialize: (c) => toCabinetDocument(c),
  parse: (data) => {
    const result = parseCabinetDocument(data);
    return result.ok
      ? ok(result.configuration)
      : fail(...result.issues.map((i) => ({ code: "cabinet.import_invalid", path: i.path, params: { message: i.message } })));
  },
  productReference: (c) => {
    const items = cabinetOrderItems(c);
    return { kind: "sku-bundle", skus: items.ok ? items.value.map((i) => (i.kind === "sku" ? i.sku : "")).filter(Boolean) : [] };
  },
  orderItems: cabinetOrderItems,
  summary: (c) => [
    { labelKey: "summary.dimensions", value: `${c.width} × ${c.height} × ${c.depth} mm` },
    { labelKey: "summary.panelThickness", value: `${c.panelThickness} mm` },
    { labelKey: "summary.bodyMaterial", value: c.materials.body },
    { labelKey: "summary.doorsAndDrawers", value: String(c.attachments.length) },
  ],
};
