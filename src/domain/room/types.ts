import type { Millimeters } from "../furniture/types";

/**
 * Walls, named as seen from inside the room facing the back wall. See src/domain/spatial/geometry.ts
 * for the coordinate system: back = z 0, front = z depth, left = x 0, right = x width.
 */
export const WALL_IDS = ["back", "right", "front", "left"] as const;
export type WallId = (typeof WALL_IDS)[number];

/** Short wall identifiers shown in the menus, on the walls in 3D and in wall-contact messages. */
export const WALL_LETTERS: Readonly<Record<WallId, string>> = { back: "A", right: "B", front: "C", left: "D" };

export type HexColor = `#${string}`;

export type OpeningKind = "window" | "door";

/**
 * A window or door in a wall. It is a spatial reference only (never a product): it is drawn in the
 * wall and furniture must not block it or its reserved clearance.
 */
export interface RoomOpening {
  readonly id: string;
  readonly kind: OpeningKind;
  readonly wall: WallId;
  /**
   * Distance along the wall from the wall's left end (seen from inside the room, facing that wall)
   * to the opening's left edge.
   */
  readonly offset: Millimeters;
  /** Height of the opening's bottom edge above the floor (window sill; 0 for a typical door). */
  readonly elevation: Millimeters;
  readonly width: Millimeters;
  readonly height: Millimeters;
  /**
   * Depth of the space in front of the opening, measured into the room, that furniture must keep
   * free (e.g. a door's swing). 0 means only the opening itself must stay unobstructed.
   */
  readonly clearanceDepth: Millimeters;
  /** Door leaf colour; windows have none. */
  readonly color?: HexColor;
  /** Opened (leaf/sashes turned into the room). Display state like a bed's folded/unfolded; default closed. */
  readonly open?: boolean;
}

export interface RoomConfiguration {
  /** Interior width along X (back and front walls). */
  readonly width: Millimeters;
  /** Interior depth along Z (left and right walls). */
  readonly depth: Millimeters;
  readonly height: Millimeters;
  readonly wallColors: Readonly<Record<WallId, HexColor>>;
  readonly floorColor: HexColor;
  readonly openings: readonly RoomOpening[];
}

export type RoomDimensionKey = "width" | "depth" | "height";

export type OpeningNumericField = "offset" | "elevation" | "width" | "height" | "clearanceDepth";
