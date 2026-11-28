import type { NextRequest } from "next/server";
import { isValidEmail } from "@/domain/shared/email";
import { isToken, sha256Hex } from "@/server/crypto";
import { errorJson, guarded, publicBase, readJson, relayJson } from "@/server/http";
import { shareUrl } from "@/server/snapshots";

/**
 * POST /api/shares/email {token, email, locale} — "Wyślij link e-mailem": sends an existing link (no new
 * snapshot is created, so retries never duplicate it). Only the session that created the link may send
 * it. The recipient address is used for this e-mail only: it is not stored with the configuration and
 * never returned by any shared-configuration API. Rate-limited by WordPress.
 */
export async function POST(request: NextRequest) {
  return guarded(request, { session: "require" }, async (ctx) => {
    const body = await readJson(request, 4_000);
    if (!body || !isToken(body.token)) return errorJson("share_not_found", 404);
    const email = typeof body.email === "string" ? body.email.trim() : "";
    if (!isValidEmail(email)) return errorJson("invalid_email", 422);
    const response = await ctx.wp({
      method: "POST",
      route: "/multi3d/v1/shares/email",
      json: {
        token_hash: sha256Hex(body.token),
        link: shareUrl(publicBase(ctx), body.token),
        email,
        locale: body.locale === "en" ? "en" : "pl",
      },
    });
    return relayJson(response, (b) => ({ sent: b.sent === true }));
  });
}
