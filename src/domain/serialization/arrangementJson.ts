import type { Arrangement } from "../arrangement/types";
import { getFurnitureType, isFurnitureTypeId } from "../modules/registry";
import type { ModuleInstance } from "../modules/types";
import { validateRoom, isHexColor } from "../room/validateRoom";
import { WALL_IDS, type RoomConfiguration, type RoomOpening } from "../room/types";
import { fail, ok, type Issue, type Result } from "../shared/issues";
import { normalizeRotation } from "../spatial/geometry";

/**
 * Versioned JSON document of a complete arrangement (room + every module with its own
 * configuration). Module configurations are stored in their furniture type's own versioned format
 * (e.g. the cabinet document v5), so each type evolves independently.
 *
 * - v1: `{ format, schemaVersion: 1, room, modules: [{ id, typeId, productReference, placement, state, configuration }] }`.
 *   `productReference` is informational (derived from the configuration) and ignored on import.
 */
export const ARRANGEMENT_FORMAT = "multi3d-arrangement";
export const ARRANGEMENT_SCHEMA_VERSION = 1;

export interface ArrangementDocument {
  readonly format: typeof ARRANGEMENT_FORMAT;
  readonly schemaVersion: typeof ARRANGEMENT_SCHEMA_VERSION;
  readonly room: RoomConfiguration;
  readonly modules: readonly {
    readonly id: string;
    readonly typeId: string;
    readonly productReference: unknown;
    readonly placement: ModuleInstance["placement"];
    readonly state: string;
    readonly configuration: unknown;
  }[];
}

export function toArrangementDocument(arrangement: Arrangement): ArrangementDocument {
  const { room } = arrangement;
  return {
    format: ARRANGEMENT_FORMAT,
    schemaVersion: ARRANGEMENT_SCHEMA_VERSION,
    room: {
      width: room.width,
      depth: room.depth,
      height: room.height,
      wallColors: { ...room.wallColors },
      floorColor: room.floorColor,
      openings: room.openings.map((o) => ({ ...o })),
    },
    modules: arrangement.modules.map((m) => {
      const type = getFurnitureType(m.typeId);
      return {
        id: m.id,
        typeId: m.typeId,
        productReference: type.productReference(m.configuration),
        placement: { ...m.placement },
        state: m.state,
        configuration: type.serialize(m.configuration),
      };
    }),
  };
}

export function exportArrangementJson(arrangement: Arrangement): string {
  return JSON.stringify(toArrangementDocument(arrangement), null, 2);
}

type JsonRecord = Record<string, unknown>;
const isRecord = (v: unknown): v is JsonRecord => typeof v === "object" && v !== null && !Array.isArray(v);
const isNumber = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

function readRoom(data: unknown, issues: Issue[]): RoomConfiguration | null {
  if (!isRecord(data)) {
    issues.push({ code: "invalid_document", path: "room" });
    return null;
  }
  const { width, depth, height, wallColors, floorColor, openings } = data;
  if (!isNumber(width) || !isNumber(depth) || !isNumber(height)) {
    issues.push({ code: "invalid_document", path: "room" });
    return null;
  }
  if (!isRecord(wallColors) || !WALL_IDS.every((w) => isHexColor(wallColors[w])) || !isHexColor(floorColor)) {
    issues.push({ code: "invalid_color", path: "room.wallColors" });
    return null;
  }
  if (!Array.isArray(openings)) {
    issues.push({ code: "invalid_document", path: "room.openings" });
    return null;
  }
  const parsedOpenings: RoomOpening[] = [];
  for (const [i, o] of openings.entries()) {
    const fields = ["offset", "elevation", "width", "height", "clearanceDepth"] as const;
    if (
      !isRecord(o) ||
      typeof o.id !== "string" ||
      (o.kind !== "window" && o.kind !== "door") ||
      !WALL_IDS.includes(o.wall as never) ||
      !fields.every((f) => isNumber(o[f]))
    ) {
      issues.push({ code: "invalid_document", path: `room.openings.${i}` });
      return null;
    }
    parsedOpenings.push({
      id: o.id,
      kind: o.kind,
      wall: o.wall as RoomOpening["wall"],
      offset: o.offset as number,
      elevation: o.elevation as number,
      width: o.width as number,
      height: o.height as number,
      clearanceDepth: o.clearanceDepth as number,
      ...(o.color !== undefined ? { color: o.color as RoomOpening["color"] } : {}),
    });
  }
  const room: RoomConfiguration = {
    width,
    depth,
    height,
    wallColors: Object.fromEntries(WALL_IDS.map((w) => [w, wallColors[w]])) as RoomConfiguration["wallColors"],
    floorColor: floorColor as RoomConfiguration["floorColor"],
    openings: parsedOpenings,
  };
  const roomIssues = validateRoom(room);
  if (roomIssues.length > 0) {
    issues.push(...roomIssues.map((i) => ({ ...i, path: `room.${i.path ?? ""}` })));
    return null;
  }
  return room;
}

/** Parses an already-decoded document. Never guesses or clamps values; any problem rejects the whole file. */
export function parseArrangementDocument(data: unknown): Result<Arrangement> {
  if (!isRecord(data) || data.format !== ARRANGEMENT_FORMAT) return fail({ code: "invalid_document", path: "format" });
  if (data.schemaVersion !== ARRANGEMENT_SCHEMA_VERSION) {
    return fail({ code: "unsupported_version", path: "schemaVersion", params: { version: JSON.stringify(data.schemaVersion) } });
  }
  const issues: Issue[] = [];
  const room = readRoom(data.room, issues);
  if (!Array.isArray(data.modules)) issues.push({ code: "invalid_document", path: "modules" });
  if (!room || issues.length > 0) return fail(...issues);

  const modules: ModuleInstance[] = [];
  const ids = new Set<string>();
  for (const [i, m] of (data.modules as unknown[]).entries()) {
    const path = `modules.${i}`;
    if (!isRecord(m) || typeof m.id !== "string" || !isRecord(m.placement) || typeof m.state !== "string") {
      issues.push({ code: "invalid_document", path });
      continue;
    }
    if (ids.has(m.id)) issues.push({ code: "duplicate_id", path: `${path}.id` });
    ids.add(m.id);
    if (!isFurnitureTypeId(m.typeId)) {
      issues.push({ code: "unknown_furniture_type", path: `${path}.typeId`, params: { value: String(m.typeId) } });
      continue;
    }
    const type = getFurnitureType(m.typeId);
    const configuration = type.parse(m.configuration);
    if (!configuration.ok) {
      issues.push(...configuration.issues.map((issue) => ({ ...issue, path: `${path}.configuration${issue.path ? `.${issue.path}` : ""}` })));
      continue;
    }
    const p = m.placement;
    if (![p.x, p.y, p.z].every((v) => isNumber(v) && Number.isInteger(v)) || !isNumber(p.rotationDeg) || (p.y as number) < 0) {
      issues.push({ code: "invalid_document", path: `${path}.placement` });
      continue;
    }
    if (!type.states(configuration.value).includes(m.state)) {
      issues.push({ code: "unknown_state", path: `${path}.state`, params: { state: m.state } });
      continue;
    }
    modules.push({
      id: m.id,
      typeId: m.typeId,
      configuration: configuration.value,
      placement: { x: p.x as number, y: p.y as number, z: p.z as number, rotationDeg: normalizeRotation(p.rotationDeg as number) },
      state: m.state,
    });
  }
  return issues.length > 0 ? fail(...issues) : ok({ room, modules });
}

export function importArrangementJson(json: string): Result<Arrangement> {
  let data: unknown;
  try {
    data = JSON.parse(json);
  } catch {
    return fail({ code: "invalid_json" });
  }
  return parseArrangementDocument(data);
}
