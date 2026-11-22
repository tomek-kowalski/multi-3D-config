import { roomBox, type PlacedBox, type PointXZ } from "../spatial/geometry";
import type { RoomConfiguration, RoomOpening, WallId } from "./types";

/**
 * A wall seen from inside the room: `origin` is its left end on the floor, `along` points to its
 * right end, `inward` points into the room. Both directions are unit vectors in plan.
 */
export interface WallFrame {
  readonly wall: WallId;
  readonly origin: PointXZ;
  readonly along: PointXZ;
  readonly inward: PointXZ;
  readonly length: number;
}

export function wallFrame(room: Pick<RoomConfiguration, "width" | "depth">, wall: WallId): WallFrame {
  const { width: W, depth: D } = room;
  switch (wall) {
    case "back":
      return { wall, origin: { x: 0, z: 0 }, along: { x: 1, z: 0 }, inward: { x: 0, z: 1 }, length: W };
    case "right":
      return { wall, origin: { x: W, z: 0 }, along: { x: 0, z: 1 }, inward: { x: -1, z: 0 }, length: D };
    case "front":
      return { wall, origin: { x: W, z: D }, along: { x: -1, z: 0 }, inward: { x: 0, z: -1 }, length: W };
    case "left":
      return { wall, origin: { x: 0, z: D }, along: { x: 0, z: -1 }, inward: { x: 1, z: 0 }, length: D };
  }
}

export function wallLength(room: Pick<RoomConfiguration, "width" | "depth">, wall: WallId): number {
  return wall === "back" || wall === "front" ? room.width : room.depth;
}

/** Room point at `along` mm from the wall's left end and `into` mm away from the wall. */
export function wallPoint(frame: WallFrame, along: number, into: number): PointXZ {
  return {
    x: frame.origin.x + frame.along.x * along + frame.inward.x * into,
    z: frame.origin.z + frame.along.z * along + frame.inward.z * into,
  };
}

/** Minimum depth of an opening's keep-free zone: furniture standing against the wall in front of it collides. */
const MIN_KEEP_FREE_DEPTH_MM = 1;

/**
 * The volume that must stay free for an opening: the opening itself (in the wall plane) extended
 * `clearanceDepth` into the room, over the opening's height.
 */
export function openingKeepFreeBox(room: RoomConfiguration, opening: RoomOpening): PlacedBox {
  const frame = wallFrame(room, opening.wall);
  const depth = Math.max(opening.clearanceDepth, MIN_KEEP_FREE_DEPTH_MM);
  const a = wallPoint(frame, opening.offset, 0);
  const b = wallPoint(frame, opening.offset + opening.width, depth);
  return roomBox(
    Math.min(a.x, b.x),
    Math.max(a.x, b.x),
    Math.min(a.z, b.z),
    Math.max(a.z, b.z),
    opening.elevation,
    opening.elevation + opening.height,
  );
}
