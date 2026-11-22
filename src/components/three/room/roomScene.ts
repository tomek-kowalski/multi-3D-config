import { Color } from "three";
import { wallFrame, wallPoint } from "@/domain/room/geometry";
import { WALL_IDS, WALL_LETTERS, type RoomConfiguration, type RoomOpening, type WallId } from "@/domain/room/types";
import { mmToM } from "../units";

/**
 * Pure descriptions of the room scene (metres, Three.js units), so the drawing rules can be tested
 * without WebGL. Openings are drawn in their wall's frame: x along the wall from the opening's left
 * edge, y up from its bottom edge, z towards the room. These parts are display only — collision
 * detection uses the opening geometry of src/domain/room/geometry.ts.
 */

export interface ScenePart {
  readonly key: string;
  readonly role: "frame" | "glass" | "sill" | "leaf" | "handle";
  readonly center: readonly [number, number, number];
  readonly size: readonly [number, number, number];
  readonly color: string;
  readonly opacity: number;
  /** Windows and doors never cast or receive shadows (they would darken the wall and the opening). */
  readonly castShadow: false;
  readonly receiveShadow: false;
}

export const FRAME_COLOR = "#F4F3F0";
export const FRAME_EDGE_COLOR = "#5E6166";
export const GLASS_COLOR = "#A9CBE0";
const FRAME_MM = 60;
const FRAME_DEPTH_MM = 80;
const SILL_DEPTH_MM = 140;

function part(key: string, role: ScenePart["role"], center: [number, number, number], size: [number, number, number], color: string, opacity = 1): ScenePart {
  return { key, role, center, size, color, opacity, castShadow: false, receiveShadow: false };
}

export function openingParts(opening: RoomOpening): ScenePart[] {
  const w = mmToM(opening.width);
  const h = mmToM(opening.height);
  const f = mmToM(FRAME_MM);
  const d = mmToM(FRAME_DEPTH_MM);
  if (opening.kind === "window") {
    return [
      part("left", "frame", [f / 2, h / 2, 0], [f, h, d], FRAME_COLOR),
      part("right", "frame", [w - f / 2, h / 2, 0], [f, h, d], FRAME_COLOR),
      part("bottom", "frame", [w / 2, f / 2, 0], [w, f, d], FRAME_COLOR),
      part("top", "frame", [w / 2, h - f / 2, 0], [w, f, d], FRAME_COLOR),
      part("mullion", "frame", [w / 2, h / 2, 0], [f * 0.6, h, d * 0.8], FRAME_COLOR),
      part("glass", "glass", [w / 2, h / 2, 0], [w - f, h - f, 0.006], GLASS_COLOR, 0.45),
      // Interior sill: makes the window's place in the wall readable from inside the room.
      part("sill", "sill", [w / 2, -0.01, mmToM(SILL_DEPTH_MM) / 2], [w + 2 * f, 0.02, mmToM(SILL_DEPTH_MM)], FRAME_COLOR),
    ];
  }
  return [
    part("left", "frame", [f / 2, h / 2, 0], [f, h, d * 1.2], FRAME_COLOR),
    part("right", "frame", [w - f / 2, h / 2, 0], [f, h, d * 1.2], FRAME_COLOR),
    part("top", "frame", [w / 2, h - f / 2, 0], [w, f, d * 1.2], FRAME_COLOR),
    part("leaf", "leaf", [w / 2, (h - f) / 2, 0], [w - 2 * f, h - f, 0.04], opening.color ?? "#FFFFFF"),
    part("handle", "handle", [w - f - 0.08, (h - f) * 0.48, 0.035], [0.12, 0.02, 0.02], "#8D9094"),
  ];
}

/** Reveal outline drawn on the wall around the opening (closed loop, wall-local metres). */
export function openingOutline(opening: RoomOpening): [number, number, number][] {
  const m = 0.02;
  const w = mmToM(opening.width);
  const h = mmToM(opening.height);
  const z = 0.002;
  const bottom = opening.elevation === 0 ? 0.001 : -m;
  return [
    [-m, bottom, z],
    [w + m, bottom, z],
    [w + m, h + m, z],
    [-m, h + m, z],
    [-m, bottom, z],
  ];
}

/** Outline colour that contrasts with the wall colour (darker on light walls, lighter on dark ones). */
export function contrastColor(wallColor: string): string {
  const c = new Color(wallColor);
  const { l } = c.getHSL({ h: 0, s: 0, l: 0 });
  c.offsetHSL(0, 0, l < 0.4 ? 0.35 : -0.35);
  return `#${c.getHexString()}`;
}

/** Rotation about +Y that maps the wall frame's x axis onto the wall (z then points into the room). */
export function wallAngle(room: RoomConfiguration, wall: WallId): number {
  const frame = wallFrame(room, wall);
  return Math.atan2(-frame.along.z, frame.along.x);
}

export const ACTIVE_WALL_COLOR = "#2563eb";

/** Only the active wall is highlighted. */
export function wallHighlights(activeWall: WallId | null): Readonly<Record<WallId, boolean>> {
  return Object.fromEntries(WALL_IDS.map((w) => [w, w === activeWall])) as Record<WallId, boolean>;
}

/** Highlight frame of a wall: its perimeter (wall-local metres, closed loop), a hair in front of it. */
export function wallHighlightOutline(room: RoomConfiguration, wall: WallId): [number, number, number][] {
  const L = mmToM(wallFrame(room, wall).length);
  const H = mmToM(room.height);
  const i = 0.01;
  const z = 0.004;
  return [
    [i, i, z],
    [L - i, i, z],
    [L - i, H - i, z],
    [i, H - i, z],
    [i, i, z],
  ];
}

/** Floor band along the active wall ("shadow" strip), room metres: centre and size. */
export function wallFloorBand(room: RoomConfiguration, wall: WallId) {
  const frame = wallFrame(room, wall);
  const depth = 180;
  const a = wallPoint(frame, 0, 0);
  const b = wallPoint(frame, frame.length, depth);
  return {
    center: [mmToM((a.x + b.x) / 2), 0.002, mmToM((a.z + b.z) / 2)] as const,
    size: [mmToM(Math.abs(b.x - a.x)), mmToM(Math.abs(b.z - a.z))] as const,
  };
}

export interface WallLabelSpec {
  readonly wall: WallId;
  /** Same identifier as in the menus (A–D). */
  readonly letter: string;
  readonly position: readonly [number, number, number];
  readonly active: boolean;
}

/** One label per wall, at the middle of its top edge, slightly in front of it. */
export function wallLabels(room: RoomConfiguration, activeWall: WallId | null): WallLabelSpec[] {
  return WALL_IDS.map((wall) => {
    const frame = wallFrame(room, wall);
    const p = wallPoint(frame, frame.length / 2, 60);
    return { wall, letter: WALL_LETTERS[wall], position: [mmToM(p.x), mmToM(room.height) + 0.12, mmToM(p.z)], active: wall === activeWall };
  });
}

/**
 * The openings drawn in the 3D scene: always every opening on every wall. Only the configuration
 * menu is filtered by the active wall (see openingsOnWall).
 */
export function sceneOpenings(room: Pick<RoomConfiguration, "openings">): readonly RoomOpening[] {
  return room.openings;
}
