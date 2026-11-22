import { getFurnitureType } from "../modules/registry";
import type { ModuleFootprint, ModuleInstance } from "../modules/types";
import { placeBox, type PlacedBox } from "../spatial/geometry";

export function moduleFootprint(module: ModuleInstance): ModuleFootprint {
  return getFurnitureType(module.typeId).footprint(module.configuration);
}

/** The module's occupied volume in its current state, in room coordinates. */
export function placedCollisionBoxes(module: ModuleInstance, state = module.state): PlacedBox[] {
  const type = getFurnitureType(module.typeId);
  const footprint = type.footprint(module.configuration);
  return type.collisionBoxes(module.configuration, state).map((b) => placeBox(b, module.placement, footprint));
}

/** The space the module sweeps in normal operation (transforming furniture), or an empty list. */
export function placedOperationEnvelope(module: ModuleInstance): PlacedBox[] {
  const type = getFurnitureType(module.typeId);
  const footprint = type.footprint(module.configuration);
  return (type.operationEnvelope(module.configuration) ?? []).map((b) => placeBox(b, module.placement, footprint));
}
