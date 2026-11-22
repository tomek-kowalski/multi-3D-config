import { getFurnitureType } from "../modules/registry";
import type { FurnitureTypeId, ModuleId, ModuleInstance, OperationalStateId } from "../modules/types";
import { wallFrame } from "../room/geometry";
import type { RoomConfiguration, WallId } from "../room/types";
import { fail, ok, type Result } from "../shared/issues";
import { localAxes, localToRoom, normalizeRotation, type Placement } from "../spatial/geometry";
import { fitsAt } from "./collisions";
import { moduleFootprint } from "./spatial";
import type { Arrangement, Side } from "./types";

/**
 * Pure arrangement edits. Each returns a new arrangement (nothing is mutated) or the issues that
 * prevented the edit. Positions are whole millimetres; the numbers are the authoritative position and
 * dragging in the 3D view goes through `setPlacement` too.
 */

export type ArrangementResult<T = object> = Result<{ readonly arrangement: Arrangement } & T>;

function findModule(arrangement: Arrangement, id: ModuleId): ModuleInstance | undefined {
  return arrangement.modules.find((m) => m.id === id);
}

function replaceModule(arrangement: Arrangement, instance: ModuleInstance): Arrangement {
  return { ...arrangement, modules: arrangement.modules.map((m) => (m.id === instance.id ? instance : m)) };
}

export function nextModuleId(arrangement: Arrangement): ModuleId {
  const used = new Set(arrangement.modules.map((m) => m.id));
  let max = 0;
  for (const id of used) {
    const n = /^module-(\d+)$/.exec(id);
    if (n) max = Math.max(max, Number(n[1]));
  }
  return `module-${max + 1}`;
}

/** Deep copy through the type's own serializer, so a copy never shares state with its source. */
function cloneConfiguration(typeId: FurnitureTypeId, configuration: unknown): unknown {
  const type = getFurnitureType(typeId);
  const parsed = type.parse(JSON.parse(JSON.stringify(type.serialize(configuration))));
  if (!parsed.ok) throw new Error(`Configuration of ${typeId} does not round-trip`);
  return parsed.value;
}

const roundMm = (v: number) => Math.round(v);

function roundPlacement(p: Placement): Placement {
  return { x: roundMm(p.x), y: roundMm(p.y), z: roundMm(p.z), rotationDeg: normalizeRotation(Math.round(p.rotationDeg * 10) / 10) };
}

/** Rotation that puts a module's back against the given wall, facing into the room. */
export const WALL_ROTATION: Readonly<Record<WallId, number>> = { back: 0, left: 90, front: 180, right: 270 };

/**
 * First free spot along the walls (back, left, right, front), scanning from each wall's left end;
 * the room centre if nothing fits (the collision report then shows the conflict).
 */
function findFreePlacement(arrangement: Arrangement, probe: ModuleInstance): Placement {
  const { room } = arrangement;
  const fp = moduleFootprint(probe);
  const STEP = 50;
  for (const wall of ["back", "left", "right", "front"] as WallId[]) {
    const frame = wallFrame(room, wall);
    for (let along = fp.width / 2; along <= frame.length - fp.width / 2; along += STEP) {
      const placement = roundPlacement({
        x: frame.origin.x + frame.along.x * along + frame.inward.x * (fp.depth / 2),
        y: 0,
        z: frame.origin.z + frame.along.z * along + frame.inward.z * (fp.depth / 2),
        rotationDeg: WALL_ROTATION[wall],
      });
      if (fitsAt(room, arrangement.modules, { ...probe, placement })) return placement;
    }
  }
  return roundPlacement({ x: room.width / 2, y: 0, z: room.depth / 2, rotationDeg: 0 });
}

export function addModule(
  arrangement: Arrangement,
  typeId: FurnitureTypeId,
  configuration?: unknown,
): ArrangementResult<{ id: ModuleId }> {
  const type = getFurnitureType(typeId);
  const config = configuration ?? type.createDefault();
  const issues = type.validate(config);
  if (issues.length > 0) return fail(...issues);
  const id = nextModuleId(arrangement);
  const probe: ModuleInstance = {
    id,
    typeId,
    configuration: config,
    placement: { x: 0, y: 0, z: 0, rotationDeg: 0 },
    state: type.states(config)[0],
  };
  const instance = { ...probe, placement: findFreePlacement(arrangement, probe) };
  return ok({ arrangement: { ...arrangement, modules: [...arrangement.modules, instance] }, id });
}

export function removeModule(arrangement: Arrangement, id: ModuleId): ArrangementResult {
  if (!findModule(arrangement, id)) return fail({ code: "module_not_found", params: { id } });
  return ok({ arrangement: { ...arrangement, modules: arrangement.modules.filter((m) => m.id !== id) } });
}

export function setPlacement(arrangement: Arrangement, id: ModuleId, patch: Partial<Placement>): ArrangementResult {
  const instance = findModule(arrangement, id);
  if (!instance) return fail({ code: "module_not_found", params: { id } });
  const next = { ...instance.placement, ...patch };
  for (const key of ["x", "y", "z"] as const) {
    if (!Number.isFinite(next[key])) return fail({ code: "not_a_number", path: `placement.${key}` });
    if (!Number.isInteger(next[key])) return fail({ code: "not_integer", path: `placement.${key}` });
  }
  if (!Number.isFinite(next.rotationDeg)) return fail({ code: "not_a_number", path: "placement.rotationDeg" });
  if (next.y < 0) return fail({ code: "below_minimum", path: "placement.y", params: { min: 0 } });
  return ok({ arrangement: replaceModule(arrangement, { ...instance, placement: roundPlacement(next) }) });
}

/** Rotates about the footprint centre. */
export function rotateModule(arrangement: Arrangement, id: ModuleId, deltaDeg: number): ArrangementResult {
  const instance = findModule(arrangement, id);
  if (!instance) return fail({ code: "module_not_found", params: { id } });
  return setPlacement(arrangement, id, { rotationDeg: normalizeRotation(instance.placement.rotationDeg + deltaDeg) });
}

/** Turns the module's back to the wall and moves it flush against it, keeping its position along the wall. */
export function snapToWall(arrangement: Arrangement, id: ModuleId, wall: WallId): ArrangementResult {
  const instance = findModule(arrangement, id);
  if (!instance) return fail({ code: "module_not_found", params: { id } });
  const { room } = arrangement;
  const fp = moduleFootprint(instance);
  const frame = wallFrame(room, wall);
  const along =
    (instance.placement.x - frame.origin.x) * frame.along.x + (instance.placement.z - frame.origin.z) * frame.along.z;
  const clamped = Math.min(Math.max(along, fp.width / 2), Math.max(fp.width / 2, frame.length - fp.width / 2));
  return setPlacement(arrangement, id, {
    x: roundMm(frame.origin.x + frame.along.x * clamped + frame.inward.x * (fp.depth / 2)),
    z: roundMm(frame.origin.z + frame.along.z * clamped + frame.inward.z * (fp.depth / 2)),
    rotationDeg: WALL_ROTATION[wall],
  });
}

/**
 * Placement directly to the left or right of `reference`, relative to the reference's own
 * orientation (its right is +X of its local frame, i.e. the right-hand side seen from its front).
 * The new instance gets the same rotation and elevation and its back is aligned with the reference's back.
 */
export function adjacentPlacement(reference: ModuleInstance, footprint: { width: number; depth: number }, side: Side): Placement {
  const refFp = moduleFootprint(reference);
  const { right, front } = localAxes(reference.placement.rotationDeg);
  const sign = side === "right" ? 1 : -1;
  const along = (sign * (refFp.width + footprint.width)) / 2;
  const forward = (footprint.depth - refFp.depth) / 2;
  return roundPlacement({
    x: reference.placement.x + right.x * along + front.x * forward,
    y: reference.placement.y,
    z: reference.placement.z + right.z * along + front.z * forward,
    rotationDeg: reference.placement.rotationDeg,
  });
}

function placeNextTo(
  arrangement: Arrangement,
  reference: ModuleInstance,
  candidate: Omit<ModuleInstance, "placement">,
  side: Side,
): ArrangementResult<{ id: ModuleId }> {
  const footprint = getFurnitureType(candidate.typeId).footprint(candidate.configuration);
  const instance: ModuleInstance = { ...candidate, placement: adjacentPlacement(reference, footprint, side) };
  if (!fitsAt(arrangement.room, arrangement.modules, instance)) return fail({ code: "no_space_beside", params: { side } });
  return ok({ arrangement: { ...arrangement, modules: [...arrangement.modules, instance] }, id: instance.id });
}

/** Copies the instance (new id, independent copy of its configuration) directly to its left or right. */
export function duplicateModule(arrangement: Arrangement, id: ModuleId, side: Side): ArrangementResult<{ id: ModuleId }> {
  const source = findModule(arrangement, id);
  if (!source) return fail({ code: "module_not_found", params: { id } });
  return placeNextTo(
    arrangement,
    source,
    {
      id: nextModuleId(arrangement),
      typeId: source.typeId,
      configuration: cloneConfiguration(source.typeId, source.configuration),
      state: source.state,
    },
    side,
  );
}

/** Adds a new instance of any type (default configuration) directly beside an existing one. */
export function addModuleNextTo(
  arrangement: Arrangement,
  referenceId: ModuleId,
  typeId: FurnitureTypeId,
  side: Side,
): ArrangementResult<{ id: ModuleId }> {
  const reference = findModule(arrangement, referenceId);
  if (!reference) return fail({ code: "module_not_found", params: { id: referenceId } });
  const type = getFurnitureType(typeId);
  const configuration = type.createDefault();
  return placeNextTo(
    arrangement,
    reference,
    { id: nextModuleId(arrangement), typeId, configuration, state: type.states(configuration)[0] },
    side,
  );
}

/**
 * Replaces one module's configuration (after validation). The instance keeps its back-left corner in
 * place, so it grows or shrinks to the right and to the front like the standalone cabinet does.
 */
export function updateModuleConfiguration(arrangement: Arrangement, id: ModuleId, configuration: unknown): ArrangementResult {
  const instance = findModule(arrangement, id);
  if (!instance) return fail({ code: "module_not_found", params: { id } });
  if (instance.configuration === configuration) return ok({ arrangement });
  const type = getFurnitureType(instance.typeId);
  const issues = type.validate(configuration);
  if (issues.length > 0) return fail(...issues);
  const oldFp = type.footprint(instance.configuration);
  const newFp = type.footprint(configuration);
  const corner = localToRoom({ x: 0, z: 0 }, instance.placement, oldFp);
  const { right, front } = localAxes(instance.placement.rotationDeg);
  const placement = roundPlacement({
    ...instance.placement,
    x: corner.x + right.x * (newFp.width / 2) + front.x * (newFp.depth / 2),
    z: corner.z + right.z * (newFp.width / 2) + front.z * (newFp.depth / 2),
  });
  const states = type.states(configuration);
  const state = states.includes(instance.state) ? instance.state : states[0];
  return ok({ arrangement: replaceModule(arrangement, { ...instance, configuration, placement, state }) });
}

export function setModuleState(arrangement: Arrangement, id: ModuleId, state: OperationalStateId): ArrangementResult {
  const instance = findModule(arrangement, id);
  if (!instance) return fail({ code: "module_not_found", params: { id } });
  if (!getFurnitureType(instance.typeId).states(instance.configuration).includes(state)) {
    return fail({ code: "unknown_state", params: { state } });
  }
  return ok({ arrangement: replaceModule(arrangement, { ...instance, state }) });
}

export function setRoom(arrangement: Arrangement, room: RoomConfiguration): Arrangement {
  return { ...arrangement, room };
}

/** The module's back-left corner (its local origin) in room coordinates, for display. */
export function moduleCorner(instance: ModuleInstance) {
  return localToRoom({ x: 0, z: 0 }, instance.placement, moduleFootprint(instance));
}
