import type { NextRequest } from "next/server";
import { isValidEmail } from "@/domain/shared/email";
import { errorJson, guarded, readJson, relayJson } from "@/server/http";
import { quoteRoute } from "@/server/quotes";

type Params = { params: Promise<{ id: string }> };

/** POST /api/quotes/{id}/email {email} — e-mails the stored PDF of this session's quotation (rate-limited). */
export async function POST(request: NextRequest, { params }: Params) {
  const { id } = await params;
  return guarded(request, { session: "require" }, async (ctx) => {
    const route = quoteRoute(id, "/email");
    if (!route) return errorJson("quote_not_found", 404);
    const body = await readJson(request, 2_000);
    const email = typeof body?.email === "string" ? body.email.trim() : "";
    if (!isValidEmail(email)) return errorJson("invalid_email", 422);
    const response = await ctx.wp({ method: "POST", route, json: { email } });
    return relayJson(response, (b) => ({ sent: b.sent === true }));
  });
}
