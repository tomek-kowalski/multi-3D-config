import type { NextRequest } from "next/server";
import { errorJson, guarded, privateJson, publicBase, readJson, relayJson } from "@/server/http";
import { canonicalSnapshot, newShareToken, shareUrl } from "@/server/snapshots";

/**
 * POST /api/quotes {snapshot} — reserves a quotation for the customer's session: WordPress assigns the
 * internal id (UUID v4) and a unique quotation number (unique index, retried on collision inside a
 * transaction), and stores the configuration snapshot of the quotation as an immutable shared
 * configuration, whose link is printed in the PDF. The number is for people only: every later call uses
 * the id, and access is decided by the session that owns the quotation.
 */
export async function POST(request: NextRequest) {
  return guarded(request, { session: "create" }, async (ctx) => {
    const body = await readJson(request, 600_000);
    const snapshot = body ? canonicalSnapshot(body.snapshot) : null;
    if (!snapshot) return errorJson("snapshot_invalid", 422);
    const { token, tokenHash } = newShareToken();
    const response = await ctx.wp({
      method: "POST",
      route: "/multi3d/v1/quotes",
      json: {
        arrangement_sha256: snapshot.arrangementSha256,
        share: { token_hash: tokenHash, snapshot: snapshot.json, schema_version: snapshot.schemaVersion },
      },
    });
    if (!response.ok) return relayJson(response);
    const stored = (await response.json()) as { id: string; number: string; created_at: string; expires_at: string };
    return privateJson(
      {
        id: stored.id,
        number: stored.number,
        createdAt: stored.created_at,
        expiresAt: stored.expires_at,
        configurationUrl: shareUrl(publicBase(ctx), token),
      },
      201,
    );
  });
}

/** GET /api/quotes — the quotations of this session ("Twoje oferty"); empty without a session. */
export async function GET(request: NextRequest) {
  return guarded(request, { session: "optional" }, async (ctx) => {
    if (!ctx.session) return privateJson({ quotes: [] });
    const response = await ctx.wp({ method: "GET", route: "/multi3d/v1/quotes" });
    return relayJson(response, (b) => ({ quotes: Array.isArray(b.quotes) ? b.quotes : [] }));
  });
}
