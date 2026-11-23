import { Matrix4, PerspectiveCamera, Vector3 } from "three";
import { arrangementBounds } from "@/domain/arrangement/spatial";
import type { RoomConfiguration, WallId } from "@/domain/room/types";
import { WALL_IDS } from "@/domain/room/types";
import { wallHiddenForCamera } from "../room/roomScene";
import type { ModuleInstance } from "@/domain/modules/types";

export type Vec3 = readonly [number, number, number];

/** Photographic lens: ~32 mm equivalent on full frame, natural perspective without wide-angle distortion. */
export const PHOTO_FOV_DEG = 40;
/** Default free space around the furniture in the frame (fraction of the half-frame); see PhotoSettings.frameMargin. */
export const FRAME_MARGIN = 0.1;
/** Floor and wall context around the furniture, in mm (clamped to the room). */
const CONTEXT_MM = 250;
const NEAR_M = 0.05;

/**
 * Camera views for the photos, as seen from the room's open front (+Z, out of the back wall):
 * 1. three-quarter view from the front right, 2. from the front left, 3. straight-on front view.
 * Azimuth: rotation about the vertical axis from the front (+ = right); elevation: above horizontal.
 * Lower than the editing views (eye level of a person standing in the room), so it reads as a photo.
 */
export const PHOTO_VIEWS = [
  { id: "front-right", azimuthDeg: 34, elevationDeg: 18 },
  { id: "front-left", azimuthDeg: -38, elevationDeg: 20 },
  { id: "front", azimuthDeg: 0, elevationDeg: 12 },
] as const;

export type PhotoViewId = (typeof PHOTO_VIEWS)[number]["id"];

export function viewDirection(view: { azimuthDeg: number; elevationDeg: number }): Vector3 {
  const az = (view.azimuthDeg * Math.PI) / 180;
  const el = (view.elevationDeg * Math.PI) / 180;
  return new Vector3(Math.sin(az) * Math.cos(el), Math.sin(el), Math.cos(az) * Math.cos(el));
}

export interface PhotoCamera {
  readonly position: Vec3;
  readonly target: Vec3;
  /** Vertical field of view in degrees. */
  readonly fov: number;
  readonly aspect: number;
  readonly near: number;
  readonly far: number;
}

export interface PlannedView {
  readonly id: PhotoViewId;
  readonly camera: PhotoCamera;
  /** Walls (with their openings) the camera stands behind; removed from this photo only. */
  readonly hiddenWalls: readonly WallId[];
}

export interface BoxM {
  readonly min: Vec3;
  readonly max: Vec3;
}

export function boxCorners(box: BoxM): Vector3[] {
  const corners: Vector3[] = [];
  for (const x of [box.min[0], box.max[0]])
    for (const y of [box.min[1], box.max[1]]) for (const z of [box.min[2], box.max[2]]) corners.push(new Vector3(x, y, z));
  return corners;
}

/**
 * What the photo frames, in metres: the furniture plus some floor and wall around it, or the empty room.
 * `drawn` is the world-space bounding box of the furniture geometry actually drawn (imported models,
 * moving bed parts in their current state, a selected mattress, handles, rotations): the frame always
 * contains it completely, also where a model reaches beyond its collision boxes.
 */
export function photoSubject(arrangement: { room: RoomConfiguration; modules: readonly ModuleInstance[] }, drawn: BoxM | null = null): BoxM {
  const b = arrangementBounds(arrangement);
  const { room } = arrangement;
  const empty = arrangement.modules.length === 0;
  const pad = empty ? 0 : CONTEXT_MM;
  const clamp = (v: number, max: number) => Math.min(max, Math.max(0, v));
  const planned: BoxM = {
    min: [clamp(b.min.x - pad, room.width) / 1000, 0, clamp(b.min.z - pad, room.depth) / 1000],
    max: [clamp(b.max.x + pad, room.width) / 1000, Math.max(b.max.y, empty ? room.height : 0) / 1000, clamp(b.max.z + pad, room.depth) / 1000],
  };
  if (!drawn) return planned;
  return {
    min: [0, 1, 2].map((i) => Math.min(planned.min[i], drawn.min[i])) as unknown as Vec3,
    max: [0, 1, 2].map((i) => Math.max(planned.max[i], drawn.max[i])) as unknown as Vec3,
  };
}

/** Camera basis looking along −direction (towards the target), Y up. */
function basis(direction: Vector3) {
  const back = direction.clone().normalize();
  const right = new Vector3(0, 1, 0).cross(back).normalize();
  const up = back.clone().cross(right).normalize();
  return { right, up, back };
}

/**
 * Smallest camera distance along `direction` at which every corner lies inside the frame (with the
 * margin) and in front of the near plane, re-centred on the projected corners a few times so the
 * subject sits in the middle of the frame. No corner of the subject is ever clipped.
 */
export function fitPhotoCamera(subject: BoxM, direction: Vector3, aspect: number, fovDeg = PHOTO_FOV_DEG, margin = FRAME_MARGIN): PhotoCamera {
  const corners = boxCorners(subject);
  const { right, up, back } = basis(direction);
  const ty = Math.tan(((fovDeg * Math.PI) / 180) / 2) * (1 - margin);
  const tx = Math.tan(((fovDeg * Math.PI) / 180) / 2) * aspect * (1 - margin);
  const target = new Vector3(
    (subject.min[0] + subject.max[0]) / 2,
    (subject.min[1] + subject.max[1]) / 2,
    (subject.min[2] + subject.max[2]) / 2,
  );
  let distance = 0;
  for (let iteration = 0; iteration < 6; iteration++) {
    // Corner coordinates relative to the target in the camera basis (f: towards the camera).
    const rel = corners.map((c) => {
      const d = c.clone().sub(target);
      return { r: d.dot(right), u: d.dot(up), f: d.dot(back) };
    });
    distance = Math.max(...rel.map(({ r, u, f }) => f + Math.max(Math.abs(r) / tx, Math.abs(u) / ty, NEAR_M * 2)));
    // Re-centre: shift the target so the projected extents are symmetric.
    const xs = rel.map(({ r, f }) => r / (distance - f));
    const ys = rel.map(({ u, f }) => u / (distance - f));
    const cx = (Math.max(...xs) + Math.min(...xs)) / 2;
    const cy = (Math.max(...ys) + Math.min(...ys)) / 2;
    if (Math.abs(cx) < 1e-4 && Math.abs(cy) < 1e-4) break;
    target.addScaledVector(right, cx * distance).addScaledVector(up, cy * distance);
  }
  const position = target.clone().addScaledVector(back, distance);
  const far = Math.max(...corners.map((c) => c.distanceTo(position))) * 2 + 10;
  return {
    position: position.toArray() as unknown as Vec3,
    target: target.toArray() as unknown as Vec3,
    fov: fovDeg,
    aspect,
    near: NEAR_M,
    far,
  };
}

export function toThreeCamera(c: PhotoCamera): PerspectiveCamera {
  const camera = new PerspectiveCamera(c.fov, c.aspect, c.near, c.far);
  camera.position.set(...c.position);
  camera.lookAt(new Vector3(...c.target));
  camera.updateProjectionMatrix();
  camera.updateMatrixWorld(true);
  return camera;
}

/** Normalized device coordinates of a point as seen by the camera (|x|,|y| ≤ 1 inside the frame). */
export function projectNdc(c: PhotoCamera, point: Vector3): Vector3 {
  const camera = toThreeCamera(c);
  return point.clone().applyMatrix4(new Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse));
}

/**
 * Azimuth (degrees, about the vertical axis from +Z) the furniture faces on average: furniture along
 * the back wall faces +Z (0°), along the left wall +X (90°). The photo views are placed around it, so
 * the camera always looks at the fronts. Furniture facing opposite ways (no clear average): 0°.
 */
export function arrangementFacingDeg(modules: readonly ModuleInstance[]): number {
  let x = 0;
  let z = 0;
  for (const m of modules) {
    const r = (m.placement.rotationDeg * Math.PI) / 180;
    x += Math.sin(r);
    z += Math.cos(r);
  }
  if (Math.hypot(x, z) < 0.5) return 0;
  return Math.round((Math.atan2(x, z) * 180) / Math.PI);
}

export function planPhotoViews(
  arrangement: { room: RoomConfiguration; modules: readonly ModuleInstance[] },
  count: number,
  aspect: number,
  options: { drawn?: BoxM | null; margin?: number } = {},
): PlannedView[] {
  if (!Number.isInteger(count) || count < 1 || count > PHOTO_VIEWS.length) throw new Error(`View count must be 1–3, got ${count}`);
  const subject = photoSubject(arrangement, options.drawn ?? null);
  const facing = arrangementFacingDeg(arrangement.modules);
  return PHOTO_VIEWS.slice(0, count).map((view) => {
    const camera = fitPhotoCamera(subject, viewDirection({ ...view, azimuthDeg: view.azimuthDeg + facing }), aspect, PHOTO_FOV_DEG, options.margin ?? FRAME_MARGIN);
    return {
      id: view.id,
      camera,
      hiddenWalls: WALL_IDS.filter((w) => wallHiddenForCamera(arrangement.room, w, camera.position)),
    };
  });
}
