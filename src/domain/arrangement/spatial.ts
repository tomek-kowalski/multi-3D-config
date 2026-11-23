import type { RoomConfiguration } from "../room/types";
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

/**
 * The module's lateral extent in its own frame (local X, millimetres): the union of its volumes in
 * every operational state and its operation envelope. Side-by-side placement uses this, so two
 * modules only touch by their real outlines and their operation stays free of each other.
 */
export function moduleLocalExtentX(module: Pick<ModuleInstance, "typeId" | "configuration">): { min: number; max: number } {
  const type = getFurnitureType(module.typeId);
  const boxes = [
    ...type.states(module.configuration).flatMap((state) => type.collisionBoxes(module.configuration, state)),
    ...(type.operationEnvelope(module.configuration) ?? []),
  ];
  return {
    min: Math.min(...boxes.map((b) => b.position.x)),
    max: Math.max(...boxes.map((b) => b.position.x + b.dimensions.width)),
  };
}

/**
 * Axis-aligned bounds (room millimetres) of everything placed, in the displayed states; the room's
 * floor area when nothing is placed. Used to frame presentation renderings.
 */
export function arrangementBounds(arrangement: { room: RoomConfiguration; modules: readonly ModuleInstance[] }): {
  min: { x: number; y: number; z: number };
  max: { x: number; y: number; z: number };
} {
  const boxes = arrangement.modules.flatMap((m) => placedCollisionBoxes(m));
  if (boxes.length === 0) {
    const { width, depth, height } = arrangement.room;
    return { min: { x: 0, y: 0, z: 0 }, max: { x: width, y: height, z: depth } };
  }
  const xs = boxes.flatMap((b) => b.corners.map((c) => c.x));
  const zs = boxes.flatMap((b) => b.corners.map((c) => c.z));
  return {
    min: { x: Math.min(...xs), y: Math.min(...boxes.map((b) => b.yMin)), z: Math.min(...zs) },
    max: { x: Math.max(...xs), y: Math.max(...boxes.map((b) => b.yMax)), z: Math.max(...zs) },
  };
}
