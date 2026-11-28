import { fail, ok, type Result } from "../shared/issues";
import { OPENING_DEFAULTS } from "./defaults";
import { wallLength } from "./geometry";
import { WALL_LETTERS } from "./types";
import type {
  HexColor,
  OpeningKind,
  OpeningNumericField,
  RoomConfiguration,
  RoomDimensionKey,
  RoomFloor,
  RoomOpening,
  WallId,
} from "./types";
import { validateRoom } from "./validateRoom";

/** Every room edit goes through here: the candidate is returned only when the whole room is valid. */
function commit(candidate: RoomConfiguration): Result<RoomConfiguration> {
  const issues = validateRoom(candidate);
  return issues.length > 0 ? fail(...issues) : ok(candidate);
}

export function setRoomDimension(room: RoomConfiguration, key: RoomDimensionKey, value: number): Result<RoomConfiguration> {
  return commit({ ...room, [key]: value });
}

export function setWallColor(room: RoomConfiguration, wall: WallId, color: HexColor): Result<RoomConfiguration> {
  return commit({ ...room, wallColors: { ...room.wallColors, [wall]: color } });
}

export function setFloorColor(room: RoomConfiguration, color: HexColor): Result<RoomConfiguration> {
  return commit({ ...room, floorColor: color });
}

/** Floor material or colour floor; `floorColor` is kept, so switching back restores the chosen colour. */
export function setFloor(room: RoomConfiguration, floor: RoomFloor): Result<RoomConfiguration> {
  if (floor.kind === "color") {
    // A colour floor is stored as the absent field: identical to every room saved before floor materials.
    const { floor: _previous, ...rest } = room;
    void _previous;
    return commit(rest);
  }
  return commit({ ...room, floor: { kind: "material", materialId: floor.materialId, plankAxis: floor.plankAxis } });
}

function nextOpeningId(room: RoomConfiguration, kind: OpeningKind): string {
  const used = new Set(room.openings.map((o) => o.id));
  for (let i = 1; ; i++) {
    const id = `${kind}-${i}`;
    if (!used.has(id)) return id;
  }
}

/**
 * First offset (whole millimetres, searching from the wall's left end) at which an opening of the
 * given width and height range fits on the wall without overlapping an existing opening. Only
 * openings whose height range overlaps the new one block it (the same rule as validation).
 * Candidates are the wall's left end and the right edge of every blocking opening, so the result is
 * deterministic and as far left as possible. null when there is no room.
 */
export function findFreeOpeningOffset(
  room: RoomConfiguration,
  wall: WallId,
  width: number,
  elevation: number,
  height: number,
): number | null {
  const length = wallLength(room, wall);
  const blocking = room.openings
    .filter((o) => o.wall === wall)
    .filter((o) => Math.min(o.elevation + o.height, elevation + height) - Math.max(o.elevation, elevation) > 0)
    .map((o) => ({ start: o.offset, end: o.offset + o.width }));
  const candidates = [0, ...blocking.map((b) => b.end)].sort((a, b) => a - b);
  for (const x of candidates) {
    if (x + width > length) continue;
    if (blocking.every((b) => x >= b.end || x + width <= b.start)) return x;
  }
  return null;
}

/**
 * Adds an opening with the default size (shrunk to fit the wall and the room height when needed) at
 * the first free position from the wall's left end. Existing openings are never moved or resized;
 * when no free position exists the issue `no_space_for_opening` explains it.
 */
export function addOpening(
  room: RoomConfiguration,
  kind: OpeningKind,
  wall: WallId,
): Result<{ room: RoomConfiguration; id: string }> {
  const defaults = OPENING_DEFAULTS[kind];
  const length = wallLength(room, wall);
  const width = Math.min(defaults.width, length);
  const height = Math.min(defaults.height, room.height - defaults.elevation);
  const offset = findFreeOpeningOffset(room, wall, width, defaults.elevation, height);
  if (offset === null) {
    return fail({ code: "no_space_for_opening", params: { kind, wall: WALL_LETTERS[wall], width } });
  }
  const id = nextOpeningId(room, kind);
  const opening: RoomOpening = {
    id,
    kind,
    wall,
    offset,
    elevation: defaults.elevation,
    width,
    height,
    clearanceDepth: defaults.clearanceDepth,
    ...(kind === "door" ? { color: defaults.color } : {}),
  };
  const result = commit({ ...room, openings: [...room.openings, opening] });
  return result.ok ? ok({ room: result.value, id }) : result;
}

export type OpeningPatch = Partial<Pick<RoomOpening, OpeningNumericField | "wall" | "color" | "open">>;

export function updateOpening(room: RoomConfiguration, id: string, patch: OpeningPatch): Result<RoomConfiguration> {
  const index = room.openings.findIndex((o) => o.id === id);
  if (index < 0) return fail({ code: "opening_not_found", params: { id } });
  const openings = [...room.openings];
  openings[index] = { ...openings[index], ...patch };
  return commit({ ...room, openings });
}

export function removeOpening(room: RoomConfiguration, id: string): Result<RoomConfiguration> {
  if (!room.openings.some((o) => o.id === id)) return fail({ code: "opening_not_found", params: { id } });
  return commit({ ...room, openings: room.openings.filter((o) => o.id !== id) });
}
