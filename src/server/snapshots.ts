import "server-only";
import { arrangementKey, parseSnapshot, snapshotJson, SNAPSHOT_MAX_BYTES, SNAPSHOT_SCHEMA_VERSION, type Snapshot } from "@/domain/sharing/snapshot";
import { randomToken, sha256Hex } from "./crypto";

/**
 * Server-side validation of a configuration snapshot sent by the browser: it is parsed with the same
 * domain rules as an import (room, openings, every module and its configuration) and stored in its
 * canonical form, so only known fields are ever stored — no personal data, cart or price can be smuggled
 * into a shared configuration.
 */
export interface CanonicalSnapshot {
  readonly snapshot: Snapshot;
  readonly json: string;
  readonly schemaVersion: number;
  /** SHA-256 of the canonical arrangement: binds a quotation to the snapshot it was reserved with. */
  readonly arrangementSha256: string;
}

export function canonicalSnapshot(data: unknown): CanonicalSnapshot | null {
  const parsed = parseSnapshot(data);
  if (!parsed.ok) return null;
  const json = snapshotJson(parsed.value);
  if (json.length > SNAPSHOT_MAX_BYTES) return null;
  return {
    snapshot: parsed.value,
    json,
    schemaVersion: SNAPSHOT_SCHEMA_VERSION,
    arrangementSha256: sha256Hex(arrangementKey(parsed.value.arrangement)),
  };
}

/** A new shared-link token: the plaintext goes to the customer only; WordPress stores the hash. */
export function newShareToken(): { token: string; tokenHash: string } {
  const token = randomToken();
  return { token, tokenHash: sha256Hex(token) };
}

export function shareUrl(base: string, token: string): string {
  return `${base}/c/${token}`;
}
