import type { Issue } from "../shared/issues";
import { ROOM_LIMITS } from "./defaults";
import { wallLength } from "./geometry";
import {
  FLOOR_MATERIAL_IDS,
  FLOOR_PLANK_AXES,
  WALL_IDS,
  type FloorMaterialId,
  type FloorPlankAxis,
  type HexColor,
  type RoomConfiguration,
  type RoomFloor,
  type RoomOpening,
} from "./types";

const HEX_COLOR = /^#[0-9A-Fa-f]{6}$/;

export function isHexColor(value: unknown): value is HexColor {
  return typeof value === "string" && HEX_COLOR.test(value);
}

/** Dimensions are whole millimetres; fractions are rejected rather than rounded. */
function checkInteger(value: number, path: string, issues: Issue[]): boolean {
  if (!Number.isFinite(value)) {
    issues.push({ code: "not_a_number", path });
    return false;
  }
  if (!Number.isInteger(value)) {
    issues.push({ code: "not_integer", path });
    return false;
  }
  return true;
}

function checkRange(value: number, range: { min: number; max: number }, path: string, issues: Issue[]) {
  if (!checkInteger(value, path, issues)) return;
  if (value < range.min) issues.push({ code: "below_minimum", path, params: { min: range.min } });
  else if (value > range.max) issues.push({ code: "above_maximum", path, params: { max: range.max } });
}

function validateOpening(room: RoomConfiguration, opening: RoomOpening, issues: Issue[]) {
  const base = `openings.${opening.id}`;
  const limits = ROOM_LIMITS.opening;
  checkRange(opening.width, limits.width, `${base}.width`, issues);
  checkRange(opening.height, limits.height, `${base}.height`, issues);
  checkRange(opening.clearanceDepth, limits.clearanceDepth, `${base}.clearanceDepth`, issues);
  if (checkInteger(opening.offset, `${base}.offset`, issues) && opening.offset < 0) {
    issues.push({ code: "below_minimum", path: `${base}.offset`, params: { min: 0 } });
  }
  if (checkInteger(opening.elevation, `${base}.elevation`, issues) && opening.elevation < 0) {
    issues.push({ code: "below_minimum", path: `${base}.elevation`, params: { min: 0 } });
  }
  const length = wallLength(room, opening.wall);
  if (opening.offset + opening.width > length) {
    issues.push({ code: "opening_outside_wall", path: `${base}.offset`, params: { max: length - opening.width, wallLength: length } });
  }
  if (opening.elevation + opening.height > room.height) {
    issues.push({ code: "opening_above_ceiling", path: `${base}.elevation`, params: { max: room.height - opening.height } });
  }
  if (opening.kind === "door" && opening.color !== undefined && !isHexColor(opening.color)) {
    issues.push({ code: "invalid_color", path: `${base}.color` });
  }
  if (opening.open !== undefined && typeof opening.open !== "boolean") {
    issues.push({ code: "invalid_document", path: `${base}.open` });
  }
  if (opening.kind === "window" && opening.color !== undefined) {
    issues.push({ code: "window_has_no_color", path: `${base}.color` });
  }
}

/** Openings on the same wall must not overlap each other. */
function validateOverlaps(room: RoomConfiguration, issues: Issue[]) {
  const { openings } = room;
  for (let i = 0; i < openings.length; i++) {
    for (let j = i + 1; j < openings.length; j++) {
      const a = openings[i];
      const b = openings[j];
      if (a.wall !== b.wall) continue;
      const alongOverlap = Math.min(a.offset + a.width, b.offset + b.width) - Math.max(a.offset, b.offset);
      const heightOverlap = Math.min(a.elevation + a.height, b.elevation + b.height) - Math.max(a.elevation, b.elevation);
      if (alongOverlap > 0 && heightOverlap > 0) {
        issues.push({ code: "openings_overlap", path: `openings.${b.id}.offset`, params: { other: a.id } });
      }
    }
  }
}

/** A floor value this version understands (unknown materials or axes are rejected, never guessed). */
export function isRoomFloor(value: unknown): value is RoomFloor {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  if (v.kind === "color") return Object.keys(v).length === 1;
  return (
    v.kind === "material" &&
    FLOOR_MATERIAL_IDS.includes(v.materialId as FloorMaterialId) &&
    FLOOR_PLANK_AXES.includes(v.plankAxis as FloorPlankAxis) &&
    Object.keys(v).length === 3
  );
}

export function validateRoom(room: RoomConfiguration): Issue[] {
  const issues: Issue[] = [];
  checkRange(room.width, ROOM_LIMITS.width, "width", issues);
  checkRange(room.depth, ROOM_LIMITS.depth, "depth", issues);
  checkRange(room.height, ROOM_LIMITS.height, "height", issues);
  for (const wall of WALL_IDS) {
    if (!isHexColor(room.wallColors[wall])) issues.push({ code: "invalid_color", path: `wallColors.${wall}` });
  }
  if (!isHexColor(room.floorColor)) issues.push({ code: "invalid_color", path: "floorColor" });
  if (room.floor !== undefined && !isRoomFloor(room.floor)) issues.push({ code: "invalid_floor", path: "floor" });
  const ids = new Set<string>();
  for (const opening of room.openings) {
    if (ids.has(opening.id)) issues.push({ code: "duplicate_id", path: `openings.${opening.id}` });
    ids.add(opening.id);
    if (!WALL_IDS.includes(opening.wall)) {
      issues.push({ code: "unknown_wall", path: `openings.${opening.id}.wall` });
      continue;
    }
    validateOpening(room, opening, issues);
  }
  if (issues.length === 0) validateOverlaps(room, issues);
  return issues;
}
