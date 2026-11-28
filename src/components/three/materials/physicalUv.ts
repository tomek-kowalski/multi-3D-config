import { BufferAttribute, BoxGeometry, type BufferGeometry } from "three";
import type { MappingSpec } from "@/domain/materials/contracts";

/**
 * Physical UV0 (architecture §4): UVs in metres, so a texture keeps its real size whatever the part's
 * dimensions, with an explicit grain axis per part instead of an aspect-ratio heuristic (which flips
 * the grain when a panel's width crosses its height). UVs are computed once per part size in the
 * part's own frame, so moving parts (doors, drawers) carry static UVs.
 */

export type Axis = "x" | "y" | "z";
const AXES: readonly Axis[] = ["x", "y", "z"];
const AXIS_INDEX: Readonly<Record<Axis, number>> = { x: 0, y: 1, z: 2 };

/** Size of a part in metres along x, y, z. */
export type SizeM = readonly [number, number, number];

/**
 * Grain (texture u) axis of a face with the given normal axis: the part's grain axis when it lies in
 * the face, otherwise the face's longer in-plane axis (edges: along the edge, as an edge band runs).
 */
export function faceUAxis(normal: Axis, grain: Axis, size: SizeM): Axis {
  const inPlane = AXES.filter((a) => a !== normal);
  if (inPlane.includes(grain)) return grain;
  return size[AXIS_INDEX[inPlane[0]]] >= size[AXIS_INDEX[inPlane[1]]] ? inPlane[0] : inPlane[1];
}

/** Deterministic phase of a part's pattern within the tile (stable across rebuilds and resizes). */
export function patternOffsetM(partId: string, tileM = 0.6): [number, number] {
  let h = 2166136261;
  for (let i = 0; i < partId.length; i++) h = Math.imul(h ^ partId.charCodeAt(i), 16777619);
  const a = ((h >>> 0) % 997) / 997;
  const b = ((Math.imul(h, 2654435761) >>> 0) % 991) / 991;
  return [a * tileM, b * tileM];
}

/**
 * Metre UV0 for a unit box (BoxGeometry 1×1×1, rendered scaled to `size`): u runs along each face's
 * grain axis, v along the other in-plane axis, both from the part's minimum corner plus `offset`.
 * Opposite faces share the axis direction, so the pattern continues across an edge.
 */
export function writeUnitBoxMetreUvs(geometry: BufferGeometry, size: SizeM, grain: Axis, offset: readonly [number, number] = [0, 0]): void {
  // Unit box (±0.5) scaled to `size`: positions are normalized by the size.
  const position = geometry.getAttribute("position");
  const normal = geometry.getAttribute("normal");
  const uv = new Float32Array(position.count * 2);
  for (let i = 0; i < position.count; i++) {
    const n = [Math.abs(normal.getX(i)), Math.abs(normal.getY(i)), Math.abs(normal.getZ(i))];
    const nAxis: Axis = n[0] >= n[1] && n[0] >= n[2] ? "x" : n[1] >= n[2] ? "y" : "z";
    const uAxis = faceUAxis(nAxis, grain, size);
    const vAxis = AXES.find((a) => a !== nAxis && a !== uAxis)!;
    const p = [position.getX(i), position.getY(i), position.getZ(i)];
    uv[i * 2] = (p[AXIS_INDEX[uAxis]] + 0.5) * size[AXIS_INDEX[uAxis]] + offset[0];
    uv[i * 2 + 1] = (p[AXIS_INDEX[vAxis]] + 0.5) * size[AXIS_INDEX[vAxis]] + offset[1];
  }
  geometry.setAttribute("uv", new BufferAttribute(uv, 2));
}

/** A unit box with metre UV0 for a part of `size` metres (rendered with mesh scale = size). */
export function unitBoxWithMetreUvs(size: SizeM, grain: Axis, offset: readonly [number, number] = [0, 0]): BoxGeometry {
  const geometry = new BoxGeometry(1, 1, 1);
  writeUnitBoxMetreUvs(geometry, size, grain, offset);
  return geometry;
}

/**
 * Exact mapping metadata of a part whose UV0 was generated here: the convention, the grain axis and
 * the pattern phase actually used (the factory derives the physical repeat from it; it no longer claims
 * a single u/v projection for a box whose faces each have their own).
 */
export function partMapping(convention: "box" | "cylinder", grain: Axis, phaseM: readonly [number, number] = [0, 0]): MappingSpec {
  return { kind: "part-metres", convention, grainAxis: grain, phaseM: [phaseM[0], phaseM[1]] };
}

/**
 * Metre UV0 for a box geometry of real size (BoxGeometry(width, height, depth), rendered unscaled),
 * with the same face convention as writeUnitBoxMetreUvs.
 */
export function writeBoxMetreUvs(geometry: BufferGeometry, size: SizeM, grain: Axis, offset: readonly [number, number] = [0, 0]): void {
  const position = geometry.getAttribute("position");
  const normal = geometry.getAttribute("normal");
  const uv = new Float32Array(position.count * 2);
  for (let i = 0; i < position.count; i++) {
    const n = [Math.abs(normal.getX(i)), Math.abs(normal.getY(i)), Math.abs(normal.getZ(i))];
    const nAxis: Axis = n[0] >= n[1] && n[0] >= n[2] ? "x" : n[1] >= n[2] ? "y" : "z";
    const uAxis = faceUAxis(nAxis, grain, size);
    const vAxis = AXES.find((a) => a !== nAxis && a !== uAxis)!;
    const p = [position.getX(i), position.getY(i), position.getZ(i)];
    uv[i * 2] = p[AXIS_INDEX[uAxis]] + size[AXIS_INDEX[uAxis]] / 2 + offset[0];
    uv[i * 2 + 1] = p[AXIS_INDEX[vAxis]] + size[AXIS_INDEX[vAxis]] / 2 + offset[1];
  }
  geometry.setAttribute("uv", new BufferAttribute(uv, 2));
}

/**
 * Metre UV0 for a CylinderGeometry (axis = local Y): on the side, u runs along the surface from the
 * bottom (slant length — the length and brushing direction of a bar handle) and v around it (arc length
 * at the MEAN radius, so every generator is a line of constant v: no shear on tapered parts such as
 * knobs, whose ends are then scaled by r / r_mean); the caps are planar (u = x, v = z). The
 * circumference seam lies where three's cylinder seam lies.
 */
export function writeCylinderMetreUvs(geometry: BufferGeometry, heightM: number, offset: readonly [number, number] = [0, 0]): void {
  const position = geometry.getAttribute("position");
  const normal = geometry.getAttribute("normal");
  const uvIn = geometry.getAttribute("uv");
  const uv = new Float32Array(position.count * 2);
  const params = (geometry as BufferGeometry & { parameters?: { radiusTop?: number; radiusBottom?: number } }).parameters;
  const radiusTop = params?.radiusTop;
  const radiusBottom = params?.radiusBottom;
  const meanRadius = radiusTop !== undefined && radiusBottom !== undefined ? (radiusTop + radiusBottom) / 2 : null;
  const slant = radiusTop !== undefined && radiusBottom !== undefined ? Math.hypot(heightM, radiusBottom - radiusTop) / heightM : 1;
  for (let i = 0; i < position.count; i++) {
    const x = position.getX(i);
    const y = position.getY(i);
    const z = position.getZ(i);
    if (Math.abs(normal.getY(i)) > 0.999) {
      uv[i * 2] = x + offset[0];
      uv[i * 2 + 1] = z + offset[1];
      continue;
    }
    const radius = meanRadius ?? Math.hypot(x, z);
    // three's side u (0..1) is the angle fraction; it also marks the seam vertices consistently.
    const angleFraction = uvIn ? uvIn.getX(i) : (Math.atan2(x, z) / (2 * Math.PI) + 1) % 1;
    uv[i * 2] = (y + heightM / 2) * slant + offset[0];
    uv[i * 2 + 1] = angleFraction * 2 * Math.PI * radius + offset[1];
  }
  geometry.setAttribute("uv", new BufferAttribute(uv, 2));
}

/**
 * Room-local planar metre UVs for a floor plane (PlaneGeometry width × depth rotated −90° about X and
 * centred on the room), measured from the room's back-left corner, so enlarging the room never moves
 * the pattern already on the floor. Floor materials run their planks along u:
 * - `plankAxis` "x" (default): u = room x, v = room z;
 * - `plankAxis` "z": u = room z, v = −room x — the same layout turned 90° (a rotation, not a mirror, so
 *   the relief keeps its handedness).
 */
export function writeFloorMetreUvs(geometry: BufferGeometry, widthM: number, depthM: number, plankAxis: "x" | "z" = "x"): void {
  const position = geometry.getAttribute("position");
  const uv = new Float32Array(position.count * 2);
  for (let i = 0; i < position.count; i++) {
    const [u, v] = floorUv(position.getX(i) + widthM / 2, depthM / 2 - position.getY(i), plankAxis);
    uv[i * 2] = u;
    uv[i * 2 + 1] = v;
  }
  geometry.setAttribute("uv", new BufferAttribute(uv, 2));
}

/** Floor UV of a room point (x, z in metres from the back-left corner) for a plank axis. */
export function floorUv(x: number, z: number, plankAxis: "x" | "z" = "x"): [number, number] {
  return plankAxis === "x" ? [x, z] : [z, -x];
}

/**
 * Floor UVs for geometry modelled directly in room coordinates (x, z in metres from the back-left
 * corner, y up) — e.g. the floor continuing through a doorway: continuous with the room's floor.
 */
export function writeRoomFloorUvs(geometry: BufferGeometry, plankAxis: "x" | "z" = "x"): void {
  const position = geometry.getAttribute("position");
  const uv = new Float32Array(position.count * 2);
  for (let i = 0; i < position.count; i++) {
    const [u, v] = floorUv(position.getX(i), position.getZ(i), plankAxis);
    uv[i * 2] = u;
    uv[i * 2 + 1] = v;
  }
  geometry.setAttribute("uv", new BufferAttribute(uv, 2));
}

/**
 * Checks that UV0 is metric on every triangle: |ΔUV| equals the physical edge length (scaled by
 * `scale`, the mesh scale of a unit geometry). Returns the largest relative error.
 */
export function maxMetricUvError(geometry: BufferGeometry, scale: SizeM = [1, 1, 1]): number {
  const position = geometry.getAttribute("position");
  const uv = geometry.getAttribute("uv");
  const index = geometry.index;
  const count = index ? index.count : position.count;
  const at = (k: number) => (index ? index.getX(k) : k);
  let worst = 0;
  for (let t = 0; t < count; t += 3) {
    for (let e = 0; e < 3; e++) {
      const a = at(t + e);
      const b = at(t + ((e + 1) % 3));
      const dx = (position.getX(b) - position.getX(a)) * scale[0];
      const dy = (position.getY(b) - position.getY(a)) * scale[1];
      const dz = (position.getZ(b) - position.getZ(a)) * scale[2];
      const lengthM = Math.hypot(dx, dy, dz);
      const lengthUv = Math.hypot(uv.getX(b) - uv.getX(a), uv.getY(b) - uv.getY(a));
      if (lengthM > 1e-9) worst = Math.max(worst, Math.abs(lengthUv - lengthM) / lengthM);
    }
  }
  return worst;
}
