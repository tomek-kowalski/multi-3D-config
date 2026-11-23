import type { ModuleId, ModuleInstance } from "../modules/types";
import { getFurnitureType } from "../modules/registry";
import { wallFrame, wallPoint } from "../room/geometry";
import { WALL_IDS, type WallId } from "../room/types";
import { localToRoom, normalizeRotation, type Placement } from "../spatial/geometry";
import { detectCollisions, type CollisionIssue } from "./collisions";
import type { DockingVerdict } from "./docking";
import { WALL_ROTATION } from "./operations";
import { moduleFootprint } from "./spatial";
import { backWallContact } from "./wallContact";
import type { Arrangement } from "./types";

/**
 * Wall docking for wall-mounted furniture (ClickBed O Classico and Desk must be fixed to a wall): when
 * such a module comes near a wall, the exact mounting pose is proposed — its mounting face (the back of
 * its footprint, local z = 0, where the carcass of every converted model starts; see the tests) flush
 * against the wall, turned so that it faces into the room, at the same place along the wall. The pose
 * is validated with the regular collision detection; if the spot straight ahead is taken, the nearest
 * free spot along the same wall is offered instead, otherwise the obstacle is explained. Nothing moves
 * before the customer confirms.
 */

/** The mounting face this close to a wall (mm, either side) activates the proposal. */
export const WALL_DOCKING_DISTANCE_MM = 500;
/** Kept while dragging until the face is this much further away (no flicker). */
export const WALL_DOCKING_HYSTERESIS_MM = 150;
/** Turning the module counts like this much extra distance per degree when choosing between walls. */
const ROTATION_COST_MM_PER_DEG = 3;
/** Search along the wall for a free spot: step and maximum shift (mm). */
const SLIDE_STEP_MM = 50;
const SLIDE_MAX_MM = 2500;

export interface WallDockingProposal {
  readonly kind: "wall";
  readonly moduleId: ModuleId;
  readonly wall: WallId;
  readonly placement: Placement;
  /** Distance of the mounting face from the wall before docking (mm, negative: penetrating). */
  readonly distanceMm: number;
  /** How far the module turns (degrees, signed, −180…180). */
  readonly rotationDeltaDeg: number;
  /** Shift along the wall from the spot straight ahead, when that spot was taken (mm). */
  readonly slidMm: number;
  readonly verdict: DockingVerdict;
  /** What the module would conflict with (invalid: why it cannot dock; warning: what it would block). */
  readonly issues: readonly CollisionIssue[];
}

/** Whether the module's type must be fixed to a wall. */
export function requiresWallMounting(module: Pick<ModuleInstance, "typeId">): boolean {
  return getFurnitureType(module.typeId).wallMounting !== undefined;
}

function signedDeltaDeg(from: number, to: number): number {
  let d = normalizeRotation(to) - normalizeRotation(from);
  if (d > 180) d -= 360;
  if (d <= -180) d += 360;
  return d;
}

/** Issues of the moved module at `placement` (its own and those of module–module conflicts with it). */
function issuesAt(arrangement: Arrangement, module: ModuleInstance, placement: Placement): CollisionIssue[] {
  const candidate: Arrangement = { ...arrangement, modules: arrangement.modules.map((m) => (m.id === module.id ? { ...m, placement } : m)) };
  return detectCollisions(candidate).filter((i) => i.moduleId === module.id || (i.kind === "module" && i.otherId === module.id));
}

/** static issues (including a missing wall mounting) make a pose impossible; operation ones only warn. */
function verdictOf(issues: readonly CollisionIssue[]): DockingVerdict {
  if (issues.some((i) => i.phase === "static")) return "invalid";
  return issues.length ? "warning" : "ok";
}

/** The mounting pose against `wall` with the mounting face centre at `along` mm from the wall's left end. */
export function wallMountingPose(arrangement: Arrangement, module: ModuleInstance, wall: WallId, along: number): Placement {
  const frame = wallFrame(arrangement.room, wall);
  const fp = moduleFootprint(module);
  const u = Math.min(Math.max(along, fp.width / 2), Math.max(fp.width / 2, frame.length - fp.width / 2));
  // Footprint centre: depth/2 in from the wall, so the back face (local z = 0) lies on the wall.
  const centre = wallPoint(frame, u, fp.depth / 2);
  // Whole millimetres (the arrangement's unit); the contact stays exact because the centre is depth/2
  // from the wall along a wall axis and every catalogue depth is an even number of millimetres.
  return { x: Math.round(centre.x), y: module.placement.y, z: Math.round(centre.z), rotationDeg: WALL_ROTATION[wall] };
}

/**
 * Per wall: the mounting face's distance from it and its position along it (the pose reference), and how
 * close the module comes to it at all (nearest footprint corner: a bed standing front first against a
 * wall is near it although its mounting face is not).
 */
function mountingFace(arrangement: Arrangement, module: ModuleInstance) {
  const fp = moduleFootprint(module);
  const centre = localToRoom({ x: fp.width / 2, z: 0 }, module.placement, fp);
  const corners = [
    { x: 0, z: 0 },
    { x: fp.width, z: 0 },
    { x: 0, z: fp.depth },
    { x: fp.width, z: fp.depth },
  ].map((c) => localToRoom(c, module.placement, fp));
  return WALL_IDS.map((wall) => {
    const frame = wallFrame(arrangement.room, wall);
    const into = (p: { x: number; z: number }) => (p.x - frame.origin.x) * frame.inward.x + (p.z - frame.origin.z) * frame.inward.z;
    const along = (centre.x - frame.origin.x) * frame.along.x + (centre.z - frame.origin.z) * frame.along.z;
    return { wall, frame, distanceMm: into(centre), nearestMm: Math.min(...corners.map(into)), along };
  });
}

/** The best pose against one wall: straight ahead if possible, else the nearest free spot along it. */
function poseOnWall(arrangement: Arrangement, module: ModuleInstance, wall: WallId, along: number, distanceMm: number): WallDockingProposal {
  const make = (placement: Placement, slidMm: number): WallDockingProposal => {
    const issues = issuesAt(arrangement, module, placement);
    return {
      kind: "wall",
      moduleId: module.id,
      wall,
      placement,
      distanceMm,
      rotationDeltaDeg: signedDeltaDeg(module.placement.rotationDeg, placement.rotationDeg),
      slidMm,
      verdict: verdictOf(issues),
      issues,
    };
  };
  const ahead = make(wallMountingPose(arrangement, module, wall, along), 0);
  if (ahead.verdict !== "invalid") return ahead;
  for (let shift = SLIDE_STEP_MM; shift <= SLIDE_MAX_MM; shift += SLIDE_STEP_MM)
    for (const sign of [1, -1]) {
      const placement = wallMountingPose(arrangement, module, wall, along + sign * shift);
      if (placement.x === ahead.placement.x && placement.z === ahead.placement.z) continue; // clamped at the wall's end
      const slid = make(placement, sign * shift);
      if (slid.verdict !== "invalid") return slid;
    }
  // Nowhere on this wall: explain the spot straight ahead.
  return ahead;
}

/**
 * The wall-mounting pose to propose for a wall-mounted module (any module when `explicit`), or null when
 * it is not near a wall or already stands with its back against one. Walls within the activation distance of its mounting face are compared by distance
 * plus the turn needed (the closest wall is not automatically the right one); dockable poses win over
 * impossible ones, which are returned only to explain why. `explicit`: the customer asked for it — any
 * wall counts, however far. `previous`: the wall shown while dragging, kept while still near and valid.
 */
export function proposeWallDocking(
  arrangement: Arrangement,
  moduleId: ModuleId,
  options: { explicit?: boolean; previousWall?: WallId | null } = {},
): WallDockingProposal | null {
  const instance = arrangement.modules.find((m) => m.id === moduleId);
  // Automatic proposals only for wall-mounted furniture; on request for any module.
  if (!instance || (!options.explicit && !requiresWallMounting(instance))) return null;
  if (backWallContact(arrangement.room, instance)) return null; // already mounted
  const faces = mountingFace(arrangement, instance);
  const candidates: { proposal: WallDockingProposal; score: number }[] = [];
  for (const face of faces) {
    const limit = WALL_DOCKING_DISTANCE_MM + (face.wall === options.previousWall ? WALL_DOCKING_HYSTERESIS_MM : 0);
    if (!options.explicit && Math.min(Math.abs(face.distanceMm), Math.abs(face.nearestMm)) > limit) continue;
    // The mounting face must be in front of this wall (within its length).
    if (face.along < -WALL_DOCKING_DISTANCE_MM || face.along > face.frame.length + WALL_DOCKING_DISTANCE_MM) continue;
    const proposal = poseOnWall(arrangement, instance, face.wall, face.along, face.distanceMm);
    // How far the module has to turn to face into the room from this wall.
    const turn = Math.abs(proposal.rotationDeltaDeg);
    const score = Math.abs(face.distanceMm) + turn * ROTATION_COST_MM_PER_DEG + Math.abs(proposal.slidMm) * 0.5;
    candidates.push({ proposal, score: face.wall === options.previousWall ? score - WALL_DOCKING_HYSTERESIS_MM : score });
  }
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => a.score - b.score);
  return (candidates.find((c) => c.proposal.verdict !== "invalid") ?? candidates[0]).proposal;
}
