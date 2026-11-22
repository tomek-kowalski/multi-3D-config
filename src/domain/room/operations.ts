import { fail, ok, type Result } from "../shared/issues";
import { OPENING_DEFAULTS } from "./defaults";
import { wallLength } from "./geometry";
import type {
  HexColor,
  OpeningKind,
  OpeningNumericField,
  RoomConfiguration,
  RoomDimensionKey,
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

function nextOpeningId(room: RoomConfiguration, kind: OpeningKind): string {
  const used = new Set(room.openings.map((o) => o.id));
  for (let i = 1; ; i++) {
    const id = `${kind}-${i}`;
    if (!used.has(id)) return id;
  }
}

/**
 * Adds an opening centred on the wall with the default size, shrunk to fit the wall and the room
 * height when needed. Fails if it would overlap another opening; the customer then moves it.
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
  const id = nextOpeningId(room, kind);
  const opening: RoomOpening = {
    id,
    kind,
    wall,
    offset: Math.round((length - width) / 2),
    elevation: defaults.elevation,
    width,
    height,
    clearanceDepth: defaults.clearanceDepth,
    ...(kind === "door" ? { color: defaults.color } : {}),
  };
  const result = commit({ ...room, openings: [...room.openings, opening] });
  return result.ok ? ok({ room: result.value, id }) : result;
}

export type OpeningPatch = Partial<Pick<RoomOpening, OpeningNumericField | "wall" | "color">>;

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
