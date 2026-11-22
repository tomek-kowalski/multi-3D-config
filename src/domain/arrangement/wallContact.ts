import { getFurnitureType } from "../modules/registry";
import type { ModuleInstance } from "../modules/types";
import { wallFrame, type WallFrame } from "../room/geometry";
import { WALL_IDS, WALL_LETTERS, type RoomConfiguration, type WallId } from "../room/types";
import { localToRoom, type PlacedBox, type PointXZ } from "../spatial/geometry";
import { placedCollisionBoxes } from "./spatial";

/**
 * Furniture ↔ wall relations, shared by positioning, collision validation, wall-mounting
 * requirements and the UI. All values are millimetres in IEEE 754 doubles; nothing is rounded here
 * (configured positions and dimensions are whole millimetres, derived corners may be fractional).
 */

/** Largest non-penetrating clearance at which furniture counts as standing against a wall. */
export const WALL_CONTACT_TOLERANCE_MM = 1.0;
/** Absorbs floating-point error only; never treated as physical clearance. */
export const GEOMETRY_EPSILON_MM = 1e-6;

export type WallContactStatus = "contact" | "separated" | "collision";

/**
 * Classifies a signed clearance (positive: gap, 0: touching, negative: penetrating) already measured
 * against a spatially relevant wall. It does not decide relevance (see `wallRelations`).
 */
export function classifyWallContact(signedDistanceMm: number): WallContactStatus {
  if (!Number.isFinite(signedDistanceMm)) throw new Error("Invalid wall distance");
  if (signedDistanceMm < -GEOMETRY_EPSILON_MM) return "collision";
  if (signedDistanceMm <= WALL_CONTACT_TOLERANCE_MM + GEOMETRY_EPSILON_MM) return "contact";
  return "separated";
}

/** Signed distance of a plan point from the wall's interior face (positive inside the room). */
export function signedDistanceToWall(point: PointXZ, frame: WallFrame): number {
  const d = (point.x - frame.origin.x) * frame.inward.x + (point.z - frame.origin.z) * frame.inward.z;
  return d === 0 ? 0 : d; // no −0 for exact contact
}

function alongWall(point: PointXZ, frame: WallFrame): number {
  return (point.x - frame.origin.x) * frame.along.x + (point.z - frame.origin.z) * frame.along.z;
}

/**
 * Signed clearance between the transformed boundary of the boxes and the wall plane: the smallest
 * signed distance of any corner. Boxes are convex, so the nearest point of a box to a plane is a corner;
 * this uses the real orientation and size, not the centre, origin or an axis-aligned bound.
 */
export function signedClearance(boxes: readonly PlacedBox[], frame: WallFrame): number {
  let min = Infinity;
  for (const box of boxes) for (const corner of box.corners) min = Math.min(min, signedDistanceToWall(corner, frame));
  return min;
}

export interface WallRelation {
  readonly wall: WallId;
  /** Signed clearance to the wall plane (exact, unrounded). */
  readonly clearanceMm: number;
  readonly status: WallContactStatus;
  /**
   * Whether the furniture lies within the wall's finite extent (along the wall and in height).
   * Nearness to the infinite plane of a wall the furniture is not in front of is not contact.
   */
  readonly withinExtent: boolean;
}

export function wallRelations(room: RoomConfiguration, boxes: readonly PlacedBox[]): WallRelation[] {
  return WALL_IDS.map((wall) => {
    const frame = wallFrame(room, wall);
    let minAlong = Infinity;
    let maxAlong = -Infinity;
    let yMin = Infinity;
    let yMax = -Infinity;
    for (const box of boxes) {
      for (const c of box.corners) {
        const u = alongWall(c, frame);
        minAlong = Math.min(minAlong, u);
        maxAlong = Math.max(maxAlong, u);
      }
      yMin = Math.min(yMin, box.yMin);
      yMax = Math.max(yMax, box.yMax);
    }
    const alongOverlap = Math.min(maxAlong, frame.length) - Math.max(minAlong, 0);
    const heightOverlap = Math.min(yMax, room.height) - Math.max(yMin, 0);
    const clearanceMm = signedClearance(boxes, frame);
    return {
      wall,
      clearanceMm,
      status: classifyWallContact(clearanceMm),
      withinExtent: alongOverlap > GEOMETRY_EPSILON_MM && heightOverlap > GEOMETRY_EPSILON_MM,
    };
  });
}

/** The module's relations to every wall, from its occupied volume in the displayed state. */
export function moduleWallRelations(room: RoomConfiguration, module: ModuleInstance): WallRelation[] {
  return wallRelations(room, placedCollisionBoxes(module));
}

/**
 * Whether boxes stay inside the room: no corner behind any wall plane (the room is convex, so the four
 * infinite planes bound it exactly) and nothing below the floor or above the ceiling — each beyond
 * numerical epsilon only, so a 0.01 mm penetration is already outside.
 */
export function insideRoom(room: RoomConfiguration, boxes: readonly PlacedBox[]): boolean {
  for (const wall of WALL_IDS) if (signedClearance(boxes, wallFrame(room, wall)) < -GEOMETRY_EPSILON_MM) return false;
  return boxes.every((b) => b.yMin >= -GEOMETRY_EPSILON_MM && b.yMax <= room.height + GEOMETRY_EPSILON_MM);
}

/** Walls the module stands against or penetrates (within their finite extent) — what the UI reports. */
export function relevantWallRelations(relations: readonly WallRelation[]): WallRelation[] {
  return relations.filter((r) => r.withinExtent && r.status !== "separated");
}

export interface BackContact {
  readonly wall: WallId;
  /** Signed clearances of the back face's two corners (left, right). */
  readonly cornerClearancesMm: readonly [number, number];
}

/**
 * The wall the module's back face stands against, if any: both back corners are in contact with the
 * same wall (the face is flush and parallel within the tolerance), the face lies entirely within the
 * wall's length, and no part of the module penetrates that wall.
 */
export function backWallContact(room: RoomConfiguration, module: ModuleInstance): BackContact | null {
  const footprint = getFurnitureType(module.typeId).footprint(module.configuration);
  const left = localToRoom({ x: 0, z: 0 }, module.placement, footprint);
  const right = localToRoom({ x: footprint.width, z: 0 }, module.placement, footprint);
  const relations = moduleWallRelations(room, module);
  for (const wall of WALL_IDS) {
    const frame = wallFrame(room, wall);
    const d: [number, number] = [signedDistanceToWall(left, frame), signedDistanceToWall(right, frame)];
    if (d.some((v) => classifyWallContact(v) !== "contact")) continue;
    const inLength = [left, right].every((p) => {
      const u = alongWall(p, frame);
      return u >= -GEOMETRY_EPSILON_MM && u <= frame.length + GEOMETRY_EPSILON_MM;
    });
    if (!inLength) continue;
    if (relations.find((r) => r.wall === wall)?.status === "collision") continue;
    return { wall, cornerClearancesMm: d };
  }
  return null;
}

/** Whether the module satisfies its type's wall-mounting requirement (true when it has none). */
export function meetsWallMounting(room: RoomConfiguration, module: ModuleInstance): boolean {
  const requirement = getFurnitureType(module.typeId).wallMounting;
  if (!requirement) return true;
  return backWallContact(room, module) !== null;
}

/**
 * Display text of a clearance, independent of the calculation: |d| ≤ ε shows as 0, integers as
 * integers, other values with up to 12 significant digits (strips float noise such as
 * 0.49999999999998, but a real 1.00001 stays 1.00001 and a positive gap never becomes "0").
 */
export function formatClearanceMm(distanceMm: number): string {
  if (Math.abs(distanceMm) <= GEOMETRY_EPSILON_MM) return "0";
  if (Number.isInteger(distanceMm)) return String(distanceMm);
  return String(Number(distanceMm.toPrecision(12)));
}

/**
 * What the UI shows for a wall relation (the message itself is localized by the UI):
 * - `collision`: "Kolizja ze ścianą A";
 * - `contact` with a real gap: "Ściana A — kontakt (0.5 mm)";
 * - `distance` for exact contact (|d| ≤ ε) and for separation: "Ściana A — odległość 0 mm" / "… 5 mm".
 */
export interface WallContactDisplay {
  readonly kind: "collision" | "contact" | "distance";
  readonly wallLetter: string;
  readonly distanceText: string;
}

export function wallContactDisplay(relation: Pick<WallRelation, "wall" | "clearanceMm">): WallContactDisplay {
  const status = classifyWallContact(relation.clearanceMm);
  const distanceText = formatClearanceMm(relation.clearanceMm);
  const wallLetter = WALL_LETTERS[relation.wall];
  if (status === "collision") return { kind: "collision", wallLetter, distanceText };
  if (status === "contact" && distanceText !== "0") return { kind: "contact", wallLetter, distanceText };
  return { kind: "distance", wallLetter, distanceText };
}

/** The relations to report for a module: walls it touches or penetrates, else the nearest wall it faces. */
export function reportedWallRelations(relations: readonly WallRelation[]): WallRelation[] {
  const relevant = relevantWallRelations(relations);
  if (relevant.length > 0) return relevant;
  const facing = relations.filter((r) => r.withinExtent).sort((a, b) => a.clearanceMm - b.clearanceMm);
  return facing.slice(0, 1);
}
