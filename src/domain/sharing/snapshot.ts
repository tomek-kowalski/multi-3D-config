import type { Arrangement } from "../arrangement/types";
import { ORDER_FORMAT } from "../commerce/order";
import {
  ARRANGEMENT_FORMAT,
  parseArrangementDocument,
  toArrangementDocument,
  type ArrangementDocument,
} from "../serialization/arrangementJson";
import { fail, ok, type Result } from "../shared/issues";

/**
 * An immutable configuration snapshot, as stored for a shared link ("Udostępnij konfigurację") and for
 * the configuration link printed on a quotation. It contains everything needed to rebuild the
 * arrangement and its presentation, and nothing else: no session, cart, quotation, price or personal
 * data. The arrangement part is the versioned arrangement document (each furniture type keeps its own
 * configuration format inside it: dimensions, compartments, shelves, doors, drawers, materials,
 * accessories, mattress, operational state such as folded/unfolded).
 *
 * - v1: `{ format, schemaVersion: 1, arrangement, presentation }`.
 * Older inputs are migrated on read: a bare arrangement document (exported file, order meta) and an
 * order payload (its `arrangement`).
 */
export const SNAPSHOT_FORMAT = "multi3d-configuration-snapshot";
export const SNAPSHOT_SCHEMA_VERSION = 1;
/** Upper bound for a stored snapshot (the server rejects larger ones). */
export const SNAPSHOT_MAX_BYTES = 512 * 1024;

export type Vec3 = readonly [number, number, number];

/** How the arrangement was being looked at: restored for the recipient, never required. */
export interface Presentation {
  readonly camera?: { readonly position: Vec3; readonly target: Vec3 };
  /** Open doors and drawers of one cabinet (their open state lives in the cabinet's editing session). */
  readonly openFronts?: { readonly moduleId: string; readonly attachmentIds: readonly string[] };
  readonly showWallLabels?: boolean;
}

export interface SnapshotDocument {
  readonly format: typeof SNAPSHOT_FORMAT;
  readonly schemaVersion: typeof SNAPSHOT_SCHEMA_VERSION;
  readonly arrangement: ArrangementDocument;
  readonly presentation: Presentation;
}

export interface Snapshot {
  readonly arrangement: Arrangement;
  readonly presentation: Presentation;
}

type JsonRecord = Record<string, unknown>;
const isRecord = (v: unknown): v is JsonRecord => typeof v === "object" && v !== null && !Array.isArray(v);
const isFiniteNumber = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const isVec3 = (v: unknown): v is Vec3 => Array.isArray(v) && v.length === 3 && v.every((n) => isFiniteNumber(n) && Math.abs(n) < 1e4);
const SAFE_ID = /^[A-Za-z0-9_.:-]{1,80}$/;

/** Keeps only the known presentation fields with valid values (unknown or invalid ones are dropped). */
export function sanitizePresentation(data: unknown, arrangement: Arrangement): Presentation {
  if (!isRecord(data)) return {};
  const out: { -readonly [K in keyof Presentation]: Presentation[K] } = {};
  const camera = data.camera;
  if (isRecord(camera) && isVec3(camera.position) && isVec3(camera.target)) {
    const round = (v: Vec3): Vec3 => v.map((n) => Math.round(n * 1000) / 1000) as unknown as Vec3;
    out.camera = { position: round(camera.position), target: round(camera.target) };
  }
  const fronts = data.openFronts;
  if (
    isRecord(fronts) &&
    typeof fronts.moduleId === "string" &&
    arrangement.modules.some((m) => m.id === fronts.moduleId) &&
    Array.isArray(fronts.attachmentIds) &&
    fronts.attachmentIds.length <= 200 &&
    fronts.attachmentIds.every((id) => typeof id === "string" && SAFE_ID.test(id))
  ) {
    out.openFronts = { moduleId: fronts.moduleId, attachmentIds: [...new Set(fronts.attachmentIds as string[])].sort() };
  }
  if (typeof data.showWallLabels === "boolean") out.showWallLabels = data.showWallLabels;
  return out;
}

export function toSnapshotDocument(snapshot: Snapshot): SnapshotDocument {
  return {
    format: SNAPSHOT_FORMAT,
    schemaVersion: SNAPSHOT_SCHEMA_VERSION,
    arrangement: toArrangementDocument(snapshot.arrangement),
    presentation: sanitizePresentation(snapshot.presentation, snapshot.arrangement),
  };
}

/** Deterministic JSON of a snapshot (the same snapshot always gives the same text). */
export function snapshotJson(snapshot: Snapshot): string {
  return JSON.stringify(toSnapshotDocument(snapshot));
}

/**
 * Reads a snapshot of any supported version, migrating older formats. The arrangement is validated
 * completely (room, openings, every module and its configuration); any problem rejects the snapshot.
 */
export function parseSnapshot(data: unknown): Result<Snapshot> {
  if (!isRecord(data)) return fail({ code: "invalid_document", path: "format" });
  let arrangementData: unknown;
  let presentationData: unknown = {};
  if (data.format === SNAPSHOT_FORMAT) {
    if (data.schemaVersion !== SNAPSHOT_SCHEMA_VERSION) {
      return fail({ code: "unsupported_version", path: "schemaVersion", params: { version: JSON.stringify(data.schemaVersion) } });
    }
    arrangementData = data.arrangement;
    presentationData = data.presentation;
  } else if (data.format === ARRANGEMENT_FORMAT) {
    arrangementData = data; // Migration: a bare arrangement document.
  } else if (data.format === ORDER_FORMAT) {
    arrangementData = data.arrangement; // Migration: an order payload.
  } else {
    return fail({ code: "invalid_document", path: "format" });
  }
  const arrangement = parseArrangementDocument(arrangementData);
  if (!arrangement.ok) return arrangement;
  return ok({ arrangement: arrangement.value, presentation: sanitizePresentation(presentationData, arrangement.value) });
}

export function parseSnapshotJson(json: string): Result<Snapshot> {
  if (json.length > SNAPSHOT_MAX_BYTES) return fail({ code: "snapshot_too_large" });
  let data: unknown;
  try {
    data = JSON.parse(json);
  } catch {
    return fail({ code: "invalid_json" });
  }
  return parseSnapshot(data);
}

/** Canonical arrangement JSON, used to compare arrangements (dirty state, quotation snapshots). */
export function arrangementKey(arrangement: Arrangement): string {
  return JSON.stringify(toArrangementDocument(arrangement));
}
