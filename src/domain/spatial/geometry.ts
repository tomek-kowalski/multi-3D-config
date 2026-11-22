import type { BoxMm } from "../compartments/types";
import type { Millimeters } from "../furniture/types";

/**
 * Room coordinate system (millimetres), shared by the room, the arrangement and every module:
 * - origin at the floor corner where the back wall meets the left wall (seen from inside the room,
 *   facing the back wall);
 * - X runs along the back wall to the right (0 … room width);
 * - Y is the height above the floor (0 … room height);
 * - Z runs from the back wall into the room (0 … room depth).
 *
 * Module local frame: origin at the back-left-bottom corner of the module's footprint, X to the
 * module's right (as seen from its front), Y up, Z towards its front. With rotation 0 a module stands
 * with its back against the back wall and its front facing +Z, so local and room axes coincide.
 */
export interface PointXZ {
  readonly x: Millimeters;
  readonly z: Millimeters;
}

export interface Placement {
  /** Room X of the footprint centre. */
  readonly x: Millimeters;
  /** Height of the module's bottom above the floor. */
  readonly y: Millimeters;
  /** Room Z of the footprint centre. */
  readonly z: Millimeters;
  /** Rotation about the vertical axis, degrees counter-clockwise seen from above, [0, 360). */
  readonly rotationDeg: number;
}

/** Width (local X) and depth (local Z) of the box a placement refers to. */
export interface Footprint {
  readonly width: Millimeters;
  readonly depth: Millimeters;
}

/** A box after placement: a convex quadrilateral in plan plus a vertical interval. */
export interface PlacedBox {
  /** Corners in plan, counter-clockwise or clockwise (consistent order). */
  readonly corners: readonly [PointXZ, PointXZ, PointXZ, PointXZ];
  readonly yMin: Millimeters;
  readonly yMax: Millimeters;
}

/**
 * Module-to-module overlaps smaller than this are treated as touching (adjacent furniture). Walls use
 * the stricter rules of src/domain/arrangement/wallContact.ts.
 */
export const CONTACT_TOLERANCE_MM = 0.5;

export function normalizeRotation(deg: number): number {
  const r = ((deg % 360) + 360) % 360;
  return r === 360 ? 0 : r;
}

function cosSin(deg: number): [number, number] {
  const rad = (normalizeRotation(deg) * Math.PI) / 180;
  // Snap right angles exactly so axis-aligned modules produce exact coordinates.
  const round = (v: number) => (Math.abs(v) < 1e-12 ? 0 : Math.abs(Math.abs(v) - 1) < 1e-12 ? Math.sign(v) : v);
  return [round(Math.cos(rad)), round(Math.sin(rad))];
}

/** Room-plan direction of the module's local +X (its right) and local +Z (its front). */
export function localAxes(rotationDeg: number): { right: PointXZ; front: PointXZ } {
  const [c, s] = cosSin(rotationDeg);
  // Same convention as a Three.js rotation about +Y: local (1,0,0) → (cos, 0, −sin), (0,0,1) → (sin, 0, cos).
  return { right: { x: c, z: 0 - s || 0 }, front: { x: s, z: c } };
}

/** Maps a point in the module's local frame to room coordinates (plan only). */
export function localToRoom(local: PointXZ, placement: Placement, footprint: Footprint): PointXZ {
  const { right, front } = localAxes(placement.rotationDeg);
  const lx = local.x - footprint.width / 2;
  const lz = local.z - footprint.depth / 2;
  return { x: placement.x + lx * right.x + lz * front.x, z: placement.z + lx * right.z + lz * front.z };
}

/** Maps a room point to the module's local frame (inverse of `localToRoom`). */
export function roomToLocal(point: PointXZ, placement: Placement, footprint: Footprint): PointXZ {
  const { right, front } = localAxes(placement.rotationDeg);
  const dx = point.x - placement.x;
  const dz = point.z - placement.z;
  return { x: dx * right.x + dz * right.z + footprint.width / 2, z: dx * front.x + dz * front.z + footprint.depth / 2 };
}

export function placeBox(box: BoxMm, placement: Placement, footprint: Footprint): PlacedBox {
  const { position: p, dimensions: d } = box;
  const corner = (x: number, z: number) => localToRoom({ x, z }, placement, footprint);
  return {
    corners: [
      corner(p.x, p.z),
      corner(p.x + d.width, p.z),
      corner(p.x + d.width, p.z + d.depth),
      corner(p.x, p.z + d.depth),
    ],
    yMin: placement.y + p.y,
    yMax: placement.y + p.y + d.height,
  };
}

/** Axis-aligned box directly in room coordinates. */
export function roomBox(minX: number, maxX: number, minZ: number, maxZ: number, yMin: number, yMax: number): PlacedBox {
  return {
    corners: [
      { x: minX, z: minZ },
      { x: maxX, z: minZ },
      { x: maxX, z: maxZ },
      { x: minX, z: maxZ },
    ],
    yMin,
    yMax,
  };
}

function project(corners: readonly PointXZ[], axis: PointXZ): [number, number] {
  let min = Infinity;
  let max = -Infinity;
  for (const c of corners) {
    const v = c.x * axis.x + c.z * axis.z;
    if (v < min) min = v;
    if (v > max) max = v;
  }
  return [min, max];
}

function edgeNormals(corners: readonly PointXZ[]): PointXZ[] {
  const normals: PointXZ[] = [];
  for (let i = 0; i < 2; i++) {
    // A rectangle has two distinct edge directions.
    const a = corners[i];
    const b = corners[i + 1];
    const ex = b.x - a.x;
    const ez = b.z - a.z;
    const len = Math.hypot(ex, ez);
    if (len > 0) normals.push({ x: -ez / len, z: ex / len });
  }
  return normals;
}

/**
 * Whether two placed boxes intersect by more than `tolerance` in every direction (separating axis
 * theorem in plan, interval test in height). Boxes that only touch do not intersect.
 */
export function boxesIntersect(a: PlacedBox, b: PlacedBox, tolerance = CONTACT_TOLERANCE_MM): boolean {
  if (Math.min(a.yMax, b.yMax) - Math.max(a.yMin, b.yMin) <= tolerance) return false;
  for (const axis of [...edgeNormals(a.corners), ...edgeNormals(b.corners)]) {
    const [aMin, aMax] = project(a.corners, axis);
    const [bMin, bMax] = project(b.corners, axis);
    if (Math.min(aMax, bMax) - Math.max(aMin, bMin) <= tolerance) return false;
  }
  return true;
}

/** Axis-aligned plan bounds of a placed box. */
export function planBounds(box: PlacedBox): { minX: number; maxX: number; minZ: number; maxZ: number } {
  const xs = box.corners.map((c) => c.x);
  const zs = box.corners.map((c) => c.z);
  return { minX: Math.min(...xs), maxX: Math.max(...xs), minZ: Math.min(...zs), maxZ: Math.max(...zs) };
}
