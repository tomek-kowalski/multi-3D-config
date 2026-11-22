import { BED_TYPES } from "../beds/bedType";
import { cabinetType } from "./cabinetType";
import type { FurnitureTypeDefinition, FurnitureTypeId } from "./types";

/**
 * The furniture catalog of the configurator: register a new type here (domain definition) and in
 * src/components/three/modules/moduleRenderers.tsx (3D view) and src/components/room/moduleEditors.tsx
 * (configuration menu). Room, arrangement, collision and order code need no change.
 */
export type AnyFurnitureType = FurnitureTypeDefinition<unknown>;

const TYPES: readonly AnyFurnitureType[] = [cabinetType, ...BED_TYPES] as readonly AnyFurnitureType[];

const BY_ID = new Map(TYPES.map((t) => [t.id, t]));

export function listFurnitureTypes(): readonly AnyFurnitureType[] {
  return TYPES;
}

export function getFurnitureType(id: FurnitureTypeId): AnyFurnitureType {
  const type = BY_ID.get(id);
  if (!type) throw new Error(`Unknown furniture type "${id}"`);
  return type;
}

export function isFurnitureTypeId(id: unknown): id is FurnitureTypeId {
  return typeof id === "string" && BY_ID.has(id);
}
