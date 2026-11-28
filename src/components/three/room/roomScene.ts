import { Color } from "three";
import { wallFrame, wallPoint } from "@/domain/room/geometry";
import { OPENING_ANGLE_DEG, OPENING_FRAME_MM, openingLeaves, type OpeningLeaf } from "@/domain/room/openingMotion";
import { WALL_IDS, WALL_LETTERS, type RoomConfiguration, type RoomOpening, type WallId } from "@/domain/room/types";
import { materialRegistry } from "@/domain/materials";
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
  /** Configured or default colour (frames, sills, leaves). Glass and handles use registered materials. */
  readonly color: string;
  /**
   * In the viewport windows and doors never cast or receive shadows: the viewport's walls cast none, so a
   * leaf's shadow would fall through its own wall into the room. (Photos let walls and the door leaf cast
   * shadows — see photoScene.ts — so the floor under the door's undercut is shaded there.)
   */
  readonly castShadow: false;
  readonly receiveShadow: false;
}

export const FRAME_COLOR = "#F4F3F0";
export const FRAME_EDGE_COLOR = "#5E6166";
/** The viewport glass proxy colour, read from the single registered glass definition. */
export const GLASS_COLOR = materialRegistry.getFinishProfile("finish/glass-clear").transmission!.proxy.srgbHex;
const FRAME_DEPTH_MM = 80;
const SILL_DEPTH_MM = 140;

function part(key: string, role: ScenePart["role"], center: [number, number, number], size: [number, number, number], color: string): ScenePart {
  return { key, role, center, size, color, castShadow: false, receiveShadow: false };
}

/**
 * Clearance between a door leaf and the finished floor (undercut): residential interior doors hang
 * 8–12 mm above the floor covering; 10 mm. The opening, frame and swing geometry are unchanged — only
 * the drawn leaf ends 10 mm above the floor instead of standing on it.
 */
export const DOOR_UNDERCUT_MM = 10;

/** Depth of a door frame, half of which projects beyond the wall line into the doorway (metres). */
export const DOOR_FRAME_DEPTH_M = (FRAME_DEPTH_MM / 1000) * 1.2;

export interface OpeningLeafScene {
  readonly id: OpeningLeaf["id"];
  /** Hinge line in the opening's frame (metres): on the frame's inner face, at the leaf's bottom. */
  readonly pivot: readonly [number, number, number];
  /** +1: the leaf extends along +x from the hinge; −1: along −x. */
  readonly direction: 1 | -1;
  /** The leaf's parts relative to its pivot, closed. */
  readonly parts: readonly ScenePart[];
}

export interface OpeningScene {
  /** Frame (and window sill): never moves. */
  readonly fixed: readonly ScenePart[];
  /** Door leaf or window sashes: turn about their hinge when the opening is open. */
  readonly leaves: readonly OpeningLeafScene[];
}

/**
 * Rotation about +Y of a leaf group: turning inward (towards +z, into the room) by `progress` (0 closed,
 * 1 fully open) of OPENING_ANGLE_DEG.
 */
export function leafRotation(direction: 1 | -1, progress: number): number {
  return (-direction * progress * OPENING_ANGLE_DEG * Math.PI) / 180;
}

const LEAF_THICKNESS = 0.04;
const SASH_THICKNESS = 0.05;

/**
 * A window or door: a stationary frame and the movable leaves (see openingLeaves in the domain, which
 * gives the same leaves for the swing collision checks). A door has one leaf hinged on its left with the
 * handle on the right; a window two casement sashes hinged at its outer edges.
 */
export function openingScene(opening: RoomOpening): OpeningScene {
  const w = mmToM(opening.width);
  const h = mmToM(opening.height);
  const f = mmToM(OPENING_FRAME_MM);
  const d = mmToM(FRAME_DEPTH_MM);
  const leaves = openingLeaves(opening);
  if (opening.kind === "window") {
    const fixed = [
      part("left", "frame", [f / 2, h / 2, 0], [f, h, d], FRAME_COLOR),
      part("right", "frame", [w - f / 2, h / 2, 0], [f, h, d], FRAME_COLOR),
      part("bottom", "frame", [w / 2, f / 2, 0], [w, f, d], FRAME_COLOR),
      part("top", "frame", [w / 2, h - f / 2, 0], [w, f, d], FRAME_COLOR),
      // Interior sill: makes the window's place in the wall readable from inside the room.
      part("sill", "sill", [w / 2, -0.01, mmToM(SILL_DEPTH_MM) / 2], [w + 2 * f, 0.02, mmToM(SILL_DEPTH_MM)], FRAME_COLOR),
    ];
    return {
      fixed,
      leaves: leaves.map((leaf) => {
        const sw = mmToM(leaf.width);
        const sh = mmToM(leaf.top - leaf.bottom);
        const bar = f * 0.6;
        const s = leaf.direction; // sash parts extend along s·x from the hinge
        const z = -SASH_THICKNESS / 2;
        const x = (c: number) => s * c;
        return {
          id: leaf.id,
          pivot: [mmToM(leaf.hingeU - opening.offset), f, d / 2] as const,
          direction: leaf.direction,
          parts: [
            part(`${leaf.id}-outer`, "frame", [x(bar / 2), sh / 2, z], [bar, sh, SASH_THICKNESS], FRAME_COLOR),
            part(`${leaf.id}-inner`, "frame", [x(sw - bar / 2), sh / 2, z], [bar, sh, SASH_THICKNESS], FRAME_COLOR),
            part(`${leaf.id}-bottom`, "frame", [x(sw / 2), bar / 2, z], [sw, bar, SASH_THICKNESS], FRAME_COLOR),
            part(`${leaf.id}-top`, "frame", [x(sw / 2), sh - bar / 2, z], [sw, bar, SASH_THICKNESS], FRAME_COLOR),
            part(`${leaf.id}-glass`, "glass", [x(sw / 2), sh / 2, z], [sw - bar, sh - bar, 0.006], GLASS_COLOR),
          ],
        };
      }),
    };
  }
  const fixed = [
    part("left", "frame", [f / 2, h / 2, 0], [f, h, d * 1.2], FRAME_COLOR),
    part("right", "frame", [w - f / 2, h / 2, 0], [f, h, d * 1.2], FRAME_COLOR),
    part("top", "frame", [w / 2, h - f / 2, 0], [w, f, d * 1.2], FRAME_COLOR),
  ];
  return {
    fixed,
    leaves: leaves.map((leaf) => {
      const lw = mmToM(leaf.width);
      const lh = mmToM(leaf.top - leaf.bottom);
      const undercut = leaf.bottom === 0 ? mmToM(DOOR_UNDERCUT_MM) : 0;
      return {
        id: leaf.id,
        pivot: [mmToM(leaf.hingeU - opening.offset), 0, (d * 1.2) / 2] as const,
        direction: leaf.direction,
        parts: [
          part("leaf", "leaf", [lw / 2, (lh + undercut) / 2, -LEAF_THICKNESS / 2], [lw, lh - undercut, LEAF_THICKNESS], opening.color ?? "#FFFFFF"),
          // Handle on the room side, near the free edge.
          part("handle", "handle", [lw - 0.08, lh * 0.48, 0.015], [0.12, 0.02, 0.02], "#8D9094"),
        ],
      };
    }),
  };
}

/** Every part of the opening at its closed position, in the opening's frame. */
export function openingParts(opening: RoomOpening): ScenePart[] {
  const scene = openingScene(opening);
  return [
    ...scene.fixed,
    ...scene.leaves.flatMap((leaf) =>
      leaf.parts.map((p) => ({ ...p, center: [p.center[0] + leaf.pivot[0], p.center[1] + leaf.pivot[1], p.center[2] + leaf.pivot[2]] as const })),
    ),
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

/**
 * Photos: a wall the camera stands behind (outside the room) would block the view; the photo renderer
 * leaves it out of that photo, with its windows and doors (the configuration is not changed).
 */
export function wallHiddenForCamera(room: RoomConfiguration, wall: WallId, camera: readonly [number, number, number] | null): boolean {
  if (!camera) return false;
  const frame = wallFrame(room, wall);
  const x = camera[0] * 1000;
  const z = camera[2] * 1000;
  return (x - frame.origin.x) * frame.inward.x + (z - frame.origin.z) * frame.inward.z < 0;
}
