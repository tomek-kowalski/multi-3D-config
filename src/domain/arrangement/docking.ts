import type { ModuleId } from "../modules/types";
import { normalizeRotation, type Placement } from "../spatial/geometry";
import { detectCollisions } from "./collisions";
import { adjacentPlacement } from "./operations";
import type { Arrangement, Side } from "./types";

/**
 * Optional docking for every furniture type (cabinet–cabinet, bed–bed, cabinet–bed, …): when a module
 * is moved close to the left or right side of another module with the same orientation, the exact
 * side-by-side position is proposed. It works only through the common module interface (footprint,
 * volumes per state, operation envelope), so new furniture types dock without changes here. The
 * position is applied only after the customer confirms; only the moved module ever moves.
 */

/** How close (centre to proposed centre, in plan) a module has to be for docking to be proposed. */
export const DOCKING_DISTANCE_MM = 150;
/** Rotations that differ by less than this are considered the same orientation. */
const SAME_ROTATION_DEG = 0.5;

export interface DockingProposal {
  readonly moduleId: ModuleId;
  readonly targetId: ModuleId;
  /** Side of the target module (seen from its front) the moved module would stand on. */
  readonly side: Side;
  readonly placement: Placement;
  /** Plan distance from the current position to the proposed one. */
  readonly distanceMm: number;
}

function sameOrientation(a: number, b: number): boolean {
  const d = Math.abs(normalizeRotation(a) - normalizeRotation(b));
  return Math.min(d, 360 - d) < SAME_ROTATION_DEG;
}

/**
 * The nearest valid docking position for the module, or null. Positions use the real outlines and the
 * orientation (backs aligned, sides touching; see adjacentPlacement). A position is valid only if the
 * moved module would then have no issue at all in the regular collision detection: room boundaries,
 * windows/doors and their clearance, other furniture — including the operation envelopes of
 * transforming beds (both states) — and wall-mounting requirements.
 */
export function proposeDocking(arrangement: Arrangement, moduleId: ModuleId, maxDistanceMm = DOCKING_DISTANCE_MM): DockingProposal | null {
  const moving = arrangement.modules.find((m) => m.id === moduleId);
  if (!moving) return null;
  let best: DockingProposal | null = null;
  for (const target of arrangement.modules) {
    if (target.id === moving.id) continue;
    if (!sameOrientation(target.placement.rotationDeg, moving.placement.rotationDeg)) continue;
    for (const side of ["left", "right"] as const) {
      const placement = adjacentPlacement(target, moving, side);
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
