import type { NextRequest } from "next/server";
import { toSnapshotDocument } from "@/domain/sharing/snapshot";
import { isToken, sha256Hex } from "@/server/crypto";
import { errorJson, guarded, privateJson, readJson, relayJson } from "@/server/http";
import { canonicalSnapshot } from "@/server/snapshots";

/**
 * POST /api/shares/open {token} — reads a shared configuration snapshot (read-only). The token travels in
 * the body (not in a URL) so it does not end up in access logs; WordPress only receives its hash. No
 * session is needed or created, and the answer contains the snapshot only: never the author's session,
 * quotations, cart or contact data. 404: unknown link; 410: expired.
 */
export async function POST(request: NextRequest) {
  return guarded(request, { session: "optional" }, async (ctx) => {
    const body = await readJson(request, 2_000);
    if (!body || !isToken(body.token)) return errorJson("share_not_found", 404);
    const response = await ctx.wp({ method: "POST", route: "/multi3d/v1/shares/lookup", json: { token_hash: sha256Hex(body.token) } });
    if (!response.ok) return relayJson(response);
    const stored = (await response.json()) as { snapshot: string; created_at: string; expires_at: string };
    let data: unknown;
    try {
      data = JSON.parse(stored.snapshot);
    } catch {
      return errorJson("snapshot_invalid", 422);
    }
    // Validated and migrated to the current schema before it reaches the browser.
    const snapshot = canonicalSnapshot(data);
    if (!snapshot) return errorJson("snapshot_invalid", 422);
    return privateJson({ snapshot: toSnapshotDocument(snapshot.snapshot), createdAt: stored.created_at, expiresAt: stored.expires_at });
  });
}
