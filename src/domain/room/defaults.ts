import type { HexColor, OpeningKind, RoomConfiguration } from "./types";

/**
 * Input limits for the room model. They only keep the reference space sensible; the room is not
 * an architectural model (no wall thickness, niches or slopes).
 */
export const ROOM_LIMITS = Object.freeze({
  width: { min: 1000, max: 20000 },
  depth: { min: 1000, max: 20000 },
  height: { min: 1800, max: 6000 },
  opening: {
    width: { min: 300, max: 6000 },
    height: { min: 300, max: 6000 },
    clearanceDepth: { min: 0, max: 3000 },
  },
});

/** Default values for a newly added opening. They are starting points the customer edits, not product data. */
export const OPENING_DEFAULTS: Readonly<
  Record<OpeningKind, { width: number; height: number; elevation: number; clearanceDepth: number; color?: HexColor }>
> = Object.freeze({
  window: { width: 1200, height: 1400, elevation: 900, clearanceDepth: 0 },
  // An inward-opening door needs its leaf width in front of it.
  door: { width: 900, height: 2050, elevation: 0, clearanceDepth: 900, color: "#FFFFFF" },
});

export const DEFAULT_WALL_COLOR: HexColor = "#F2F0EB";
export const DEFAULT_FLOOR_COLOR: HexColor = "#C8B49A";

/** Preset swatches offered next to the free colour picker. */
export const WALL_COLOR_PRESETS: readonly HexColor[] = ["#F2F0EB", "#FFFFFF", "#E6E1D6", "#D9DEE2", "#C9D3C1", "#E8D5C4", "#8E9AA6", "#4B4F54"];
export const DOOR_COLOR_PRESETS: readonly HexColor[] = ["#FFFFFF", "#E9E4DA", "#B9946A", "#7A5A3F", "#6B6E72", "#2E2F31"];
export const FLOOR_COLOR_PRESETS: readonly HexColor[] = ["#C8B49A", "#D9C7A7", "#A88462", "#6F5442", "#BDBDBA", "#8A8A88"];

export const DEFAULT_ROOM: RoomConfiguration = Object.freeze({
  width: 4000,
  depth: 3500,
  height: 2600,
  wallColors: Object.freeze({
    back: DEFAULT_WALL_COLOR,
    right: DEFAULT_WALL_COLOR,
    front: DEFAULT_WALL_COLOR,
    left: DEFAULT_WALL_COLOR,
  }),
  floorColor: DEFAULT_FLOOR_COLOR,
  openings: Object.freeze([]),
});
