import { roomBox, type PlacedBox } from "../spatial/geometry";
import { wallFrame, wallLength, wallPoint } from "./geometry";
import type { RoomConfiguration, RoomOpening } from "./types";

/**
 * The movable parts of windows and doors and the space they sweep when opened. The room model's
 * openings are generic: a door has one leaf hinged on its left (seen from inside the room, handle on
 * the right), a window two casement sashes hinged at its outer edges; all open inward, into the room,
 * by OPENING_ANGLE_DEG. The frame never moves. Wall-local millimetres: u along the wall from its left
 * end, v up from the floor, "into" the room from the wall plane.
 */

/** Width of the fixed frame around the movable leaves (also used by the 3D model). */
export const OPENING_FRAME_MM = 60;
export const OPENING_ANGLE_DEG = 90;

export interface OpeningLeaf {
  readonly id: "leaf" | "left-sash" | "right-sash";
  /** Hinge line position along the wall (mm from the wall's left end). */
  readonly hingeU: number;
  /** +1: the leaf extends to the right of its hinge (along +u); −1: to the left. */
  readonly direction: 1 | -1;
  readonly width: number;
  readonly bottom: number;
  readonly top: number;
}

export function openingLeaves(opening: RoomOpening): OpeningLeaf[] {
  const f = OPENING_FRAME_MM;
  if (opening.kind === "door") {
    // The leaf reaches the floor; the frame is on the sides and at the top only.
    return [{ id: "leaf", hingeU: opening.offset + f, direction: 1, width: opening.width - 2 * f, bottom: opening.elevation, top: opening.elevation + opening.height - f }];
  }
  const half = (opening.width - 2 * f) / 2;
  const bottom = opening.elevation + f;
  const top = opening.elevation + opening.height - f;
  return [
    { id: "left-sash", hingeU: opening.offset + f, direction: 1, width: half, bottom, top },
    { id: "right-sash", hingeU: opening.offset + opening.width - f, direction: -1, width: half, bottom, top },
  ];
}

/**
 * The space each leaf sweeps while opening (plan: from its hinge along the wall by its width and the
 * same depth into the room; height: the leaf's), in room coordinates. Used to check whether a window or
 * door can be opened; never drawn.
 */
export function openingSwingBoxes(room: RoomConfiguration, opening: RoomOpening): PlacedBox[] {
  const frame = wallFrame(room, opening.wall);
  return openingLeaves(opening).map((leaf) => {
    const a = wallPoint(frame, leaf.hingeU, 0);
    const b = wallPoint(frame, leaf.hingeU + leaf.direction * leaf.width, leaf.width);
    return roomBox(Math.min(a.x, b.x), Math.max(a.x, b.x), Math.min(a.z, b.z), Math.max(a.z, b.z), leaf.bottom, leaf.top);
  });
}

/** Where an opening may be placed on its wall: whole millimetres, inside the wall and below the ceiling. */
export function clampOpeningPosition(room: RoomConfiguration, opening: RoomOpening, offset: number, elevation: number) {
  const length = wallLength(room, opening.wall);
  return {
    offset: Math.round(Math.min(Math.max(offset, 0), Math.max(0, length - opening.width))),
    // Doors stand on the floor: their elevation is kept.
    elevation: opening.kind === "door" ? opening.elevation : Math.round(Math.min(Math.max(elevation, 0), Math.max(0, room.height - opening.height))),
  };
}

/** The other opening on the same wall this position would overlap, if any. */
export function overlappingOpening(room: RoomConfiguration, opening: RoomOpening, offset: number, elevation: number): RoomOpening | null {
  return (
    room.openings.find(
      (o) =>
        o.id !== opening.id &&
        o.wall === opening.wall &&
        Math.min(o.offset + o.width, offset + opening.width) - Math.max(o.offset, offset) > 0 &&
        Math.min(o.elevation + o.height, elevation + opening.height) - Math.max(o.elevation, elevation) > 0,
    ) ?? null
  );
}

export interface OpeningPositioning {
  /** The valid position to use (the requested one, or the nearest free one along the wall). */
  readonly offset: number;
  readonly elevation: number;
  /** The requested position was valid as is. */
  readonly valid: boolean;
  /** Why the requested position was not valid (for one short explanation). */
  readonly reason: { readonly code: "opening_clamped_to_wall" } | { readonly code: "opening_moved_off"; readonly other: string } | null;
}

/**
 * Positioning assistance for dragging a window or door: the requested position (wall-local) is kept
 * inside the wall and below the ceiling, and if it would overlap another opening the nearest free
 * offset on the same wall (at the requested height) is used instead — the opening never sits in an
 * invalid place, and the customer is told why it stopped there.
 */
export function assistOpeningPosition(room: RoomConfiguration, opening: RoomOpening, offset: number, elevation: number): OpeningPositioning {
  const clamped = clampOpeningPosition(room, opening, offset, elevation);
  const wasClamped = clamped.offset !== Math.round(offset) || (opening.kind !== "door" && clamped.elevation !== Math.round(elevation));
  const other = overlappingOpening(room, opening, clamped.offset, clamped.elevation);
  if (!other) return { ...clamped, valid: !wasClamped, reason: wasClamped ? { code: "opening_clamped_to_wall" } : null };
  const length = wallLength(room, opening.wall);
  const candidates: number[] = [];
  for (const o of room.openings) {
    if (o.id === opening.id || o.wall !== opening.wall) continue;
    candidates.push(o.offset - opening.width, o.offset + o.width);
  }
  const free = candidates
    .filter((c) => c >= 0 && c + opening.width <= length)
    .filter((c) => !overlappingOpening(room, opening, c, clamped.elevation))
    .sort((a, b) => Math.abs(a - clamped.offset) - Math.abs(b - clamped.offset));
  const position = free.length ? { offset: free[0], elevation: clamped.elevation } : { offset: opening.offset, elevation: opening.elevation };
  return { ...position, valid: false, reason: { code: "opening_moved_off", other: other.id } };
}
