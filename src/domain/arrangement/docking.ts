import { getFurnitureType } from "../modules/registry";
import type { ModuleId, ModuleInstance } from "../modules/types";
import { normalizeRotation, type Placement } from "../spatial/geometry";
import { detectCollisions } from "./collisions";
import { adjacentPlacement } from "./operations";
import type { Arrangement, Side } from "./types";

/**
 * Optional docking of cabinets: when a cabinet is moved close to the left or right side of another
 * cabinet with the same orientation, the exact side-by-side position is proposed. It is only applied
 * after the customer confirms; nothing is ever moved automatically, and only the moved cabinet moves.
 */

/** How close (centre to proposed centre, in plan) a cabinet has to be for docking to be proposed. */
export const DOCKING_DISTANCE_MM = 150;
/** Rotations that differ by less than this are considered the same orientation. */
const SAME_ROTATION_DEG = 0.5;

export interface DockingProposal {
  readonly moduleId: ModuleId;
  readonly targetId: ModuleId;
  /** Side of the target cabinet (seen from its front) the moved cabinet would stand on. */
  readonly side: Side;
  readonly placement: Placement;
  /** Plan distance from the current position to the proposed one. */
  readonly distanceMm: number;
}

function isCabinet(module: ModuleInstance): boolean {
  return getFurnitureType(module.typeId).category === "cabinet";
}

function sameOrientation(a: number, b: number): boolean {
  const d = Math.abs(normalizeRotation(a) - normalizeRotation(b));
  return Math.min(d, 360 - d) < SAME_ROTATION_DEG;
}

/**
 * The nearest valid docking position for the cabinet, or null. A position is valid only if the moved
 * cabinet would collide with nothing there (walls, openings, other furniture — the regular collision
 * detection). Positions use the real footprints and orientation (backs aligned, sides touching).
 */
export function proposeDocking(arrangement: Arrangement, moduleId: ModuleId, maxDistanceMm = DOCKING_DISTANCE_MM): DockingProposal | null {
  const moving = arrangement.modules.find((m) => m.id === moduleId);
  if (!moving || !isCabinet(moving)) return null;
  const footprint = getFurnitureType(moving.typeId).footprint(moving.configuration);
  let best: DockingProposal | null = null;
  for (const target of arrangement.modules) {
    if (target.id === moving.id || !isCabinet(target)) continue;
    if (!sameOrientation(target.placement.rotationDeg, moving.placement.rotationDeg)) continue;
    for (const side of ["left", "right"] as const) {
      const placement = adjacentPlacement(target, footprint, side);
      const distanceMm = Math.hypot(placement.x - moving.placement.x, placement.z - moving.placement.z);
      // Already docked (or exactly there): nothing to propose.
      if (distanceMm < 0.5 && placement.y === moving.placement.y) continue;
      if (distanceMm > maxDistanceMm || (best && distanceMm >= best.distanceMm)) continue;
      const candidate: Arrangement = {
        ...arrangement,
        modules: arrangement.modules.map((m) => (m.id === moving.id ? { ...m, placement } : m)),
      };
      const conflicts = detectCollisions(candidate).filter(
        (i) => i.moduleId === moving.id || (i.kind === "module" && i.otherId === moving.id),
      );
      if (conflicts.length > 0) continue;
      best = { moduleId: moving.id, targetId: target.id, side, placement, distanceMm };
    }
  }
  return best;
}
