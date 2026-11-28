import type { NextRequest } from "next/server";
import { errorJson, guarded, privateJson, publicBase, readJson, relayJson } from "@/server/http";
import { canonicalSnapshot, newShareToken, shareUrl } from "@/server/snapshots";

/**
 * POST /api/shares — "Udostępnij konfigurację": stores an immutable snapshot of the posted configuration
 * and returns its link. The token (256 random bits) is returned once and only its SHA-256 is stored.
 * Rate-limited by WordPress (per client address and per session).
 */
export async function POST(request: NextRequest) {
  return guarded(request, { session: "create" }, async (ctx) => {
    const body = await readJson(request, 600_000);
    const snapshot = body ? canonicalSnapshot(body.snapshot) : null;
    if (!snapshot) return errorJson("snapshot_invalid", 422);
    const { token, tokenHash } = newShareToken();
    const response = await ctx.wp({
      method: "POST",
      route: "/multi3d/v1/shares",
      json: { token_hash: tokenHash, snapshot: snapshot.json, schema_version: snapshot.schemaVersion },
    });
    if (!response.ok) return relayJson(response);
    const stored = (await response.json()) as { id: string; created_at: string; expires_at: string };
    return privateJson(
      { id: stored.id, token, url: shareUrl(publicBase(ctx), token), createdAt: stored.created_at, expiresAt: stored.expires_at },
      201,
    );
  });
}
