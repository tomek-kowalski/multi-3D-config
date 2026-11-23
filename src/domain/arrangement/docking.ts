import type { ModuleId } from "../modules/types";
import { localAxes, normalizeRotation, type Placement } from "../spatial/geometry";
import { detectCollisions, type CollisionIssue } from "./collisions";
import { adjacentPlacement } from "./operations";
import { moduleFootprint } from "./spatial";
import type { Arrangement, Side } from "./types";

/**
 * Optional docking for every furniture type (cabinet–cabinet, bed–bed, cabinet–bed, …): when a module
 * is moved close to the left or right side of another module with the same orientation, the exact
 * side-by-side position is proposed. It works only through the common module interface (footprint,
 * volumes per state, operation envelope), so new furniture types dock without changes here. The
 * position is applied only after the customer confirms; only the moved module ever moves.
 *
 * Closeness is measured in the target's own frame, separately for the two things a person lines up by
 * eye: the gap between the facing sides and the front/back alignment (a single centre distance, as
 * before, rejected most hand-made drags of wide modules such as beds).
 */

/** Largest gap between the facing sides for docking to be proposed (mm). */
export const DOCKING_GAP_MM = 200;
/** Largest front/back misalignment (backs not in line) for docking to be proposed (mm). */
export const DOCKING_ALIGNMENT_MM = 250;
/**
 * While dragging, the current proposal is kept until the module leaves its capture area by this much,
 * and another candidate replaces it only if it is this much closer: no flicker between neighbours.
 */
export const DOCKING_HYSTERESIS_MM = 100;
/** Rotations that differ by less than this are considered the same orientation. */
const SAME_ROTATION_DEG = 0.5;

/**
 * - ok: the position is free;
 * - warning: physically free, but the position blocks the operation of a transforming bed (its swept
 *   space), which is checked separately; can be confirmed;
 * - invalid: the module would physically collide (another module, the room's walls, a window/door or
 *   its clearance) or a wall-mounted bed would not be fixed to a wall; explained, cannot be confirmed.
 */
export type DockingVerdict = "ok" | "warning" | "invalid";

export interface DockingProposal {
  readonly kind: "module";
  readonly moduleId: ModuleId;
  readonly targetId: ModuleId;
  /** Side of the target module (seen from its front) the moved module would stand on. */
  readonly side: Side;
  readonly placement: Placement;
  /** Plan distance from the current position to the proposed one. */
  readonly distanceMm: number;
  readonly verdict: DockingVerdict;
  /** The issues the moved module would have at the proposed position (explained to the customer). */
  readonly issues: readonly CollisionIssue[];
}

export interface DockingCandidateKey {
  readonly targetId: ModuleId;
  readonly side: Side;
}

function sameOrientation(a: number, b: number): boolean {
  const d = Math.abs(normalizeRotation(a) - normalizeRotation(b));
  return Math.min(d, 360 - d) < SAME_ROTATION_DEG;
}

/**
 * Problems of the docked position itself (cannot dock): physical collisions and a missing wall mounting
 * (docking must not leave a wall-mounted bed unmounted). Operation issues are reported separately.
 */
export function isBlockingIssue(issue: CollisionIssue): boolean {
  return issue.phase === "static";
}

function verdictOf(issues: readonly CollisionIssue[]): DockingVerdict {
  if (issues.some(isBlockingIssue)) return "invalid";
  return issues.length > 0 ? "warning" : "ok";
}

/**
 * Every side of every same-oriented module the moved module is close to, nearest first, each validated
 * at its exact side-by-side position (backs aligned, sides touching; see adjacentPlacement) with the
 * regular collision detection. `slackMm` widens the capture area (hysteresis while dragging).
 */
export function dockingCandidates(arrangement: Arrangement, moduleId: ModuleId, slackMm = 0): DockingProposal[] {
  const moving = arrangement.modules.find((m) => m.id === moduleId);
  if (!moving) return [];
  const movingWidth = moduleFootprint(moving).width;
  const candidates: DockingProposal[] = [];
  for (const target of arrangement.modules) {
    if (target.id === moving.id) continue;
    if (!sameOrientation(target.placement.rotationDeg, moving.placement.rotationDeg)) continue;
    const { right, front } = localAxes(target.placement.rotationDeg);
    const overlapLimit = Math.min(movingWidth, moduleFootprint(target).width) / 2;
    for (const side of ["left", "right"] as const) {
      const placement = adjacentPlacement(target, moving, side);
      const dx = moving.placement.x - placement.x;
      const dz = moving.placement.z - placement.z;
      const distanceMm = Math.hypot(dx, dz);
      // Already docked (or exactly there): nothing to propose.
      if (distanceMm < 0.5 && placement.y === moving.placement.y) continue;
      // In the target's frame: the gap between the facing sides (negative: overlapping) and the alignment.
      const along = dx * right.x + dz * right.z;
      const gap = side === "right" ? along : -along;
      const alignment = Math.abs(dx * front.x + dz * front.z);
      if (gap > DOCKING_GAP_MM + slackMm || gap < -(overlapLimit + slackMm) || alignment > DOCKING_ALIGNMENT_MM + slackMm) continue;
      const candidate: Arrangement = {
        ...arrangement,
        modules: arrangement.modules.map((m) => (m.id === moving.id ? { ...m, placement } : m)),
      };
      const issues = detectCollisions(candidate).filter(
        (i) => i.moduleId === moving.id || (i.kind === "module" && i.otherId === moving.id),
      );
      candidates.push({ kind: "module", moduleId: moving.id, targetId: target.id, side, placement, distanceMm, verdict: verdictOf(issues), issues });
    }
  }
  return candidates.sort((a, b) => a.distanceMm - b.distanceMm);
}

/**
 * The docking position to propose, or null when the module is not close to any side. Positions that
 * can be docked (ok or warning) win over physically impossible ones, nearest first; an impossible one is
 * returned only when nothing else is close, so the customer learns why it does not dock instead of
 * nothing happening. With `previous` (the proposal shown while dragging), that proposal is kept while it
 * stays valid and the module stays near it, unless another one is clearly closer.
 */
export function proposeDocking(arrangement: Arrangement, moduleId: ModuleId, previous: DockingCandidateKey | null = null): DockingProposal | null {
  const regular = dockingCandidates(arrangement, moduleId);
  const best = regular.find((c) => c.verdict !== "invalid") ?? null;
  if (previous) {
    const same = (c: DockingProposal) => c.targetId === previous.targetId && c.side === previous.side;
    // The shown proposal stays while it is still dockable and the module is within the widened area…
    const pool = regular.some(same) ? regular : dockingCandidates(arrangement, moduleId, DOCKING_HYSTERESIS_MM);
    const kept = pool.find((c) => same(c) && c.verdict !== "invalid");
    // …unless another candidate is clearly closer.
    if (kept && (!best || same(best) || best.distanceMm > kept.distanceMm - DOCKING_HYSTERESIS_MM)) return kept;
  }
  if (best) return best;
  return regular.find((c) => c.verdict === "invalid") ?? null;
}
