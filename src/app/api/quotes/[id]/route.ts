import type { NextRequest } from "next/server";
import { QUOTE_FORMAT } from "@/domain/commerce/quote";
import { errorJson, guarded, readJson, relayJson } from "@/server/http";
import { quoteRoute } from "@/server/quotes";
import { canonicalSnapshot } from "@/server/snapshots";

type Params = { params: Promise<{ id: string }> };

/**
 * PUT /api/quotes/{id} {quote, renderings} — stores the quotation document (configuration + pricing
 * snapshot) and the rendering metadata of a reserved quotation of this session. WordPress accepts it only
 * once, only from the owner, only with the reserved number, and only for exactly the configuration the
 * quotation was reserved with (SHA-256 of the canonical arrangement).
 */
export async function PUT(request: NextRequest, { params }: Params) {
  const { id } = await params;
  return guarded(request, { session: "require" }, async (ctx) => {
    const route = quoteRoute(id);
    if (!route) return errorJson("quote_not_found", 404);
    const body = await readJson(request, 300_000);
    const quote = body?.quote as Record<string, unknown> | undefined;
    const order = quote?.order as Record<string, unknown> | undefined;
    if (!quote || quote.format !== QUOTE_FORMAT || typeof quote.number !== "string" || !order) return errorJson("invalid_quote", 422);
    const snapshot = canonicalSnapshot(order.arrangement);
    if (!snapshot) return errorJson("invalid_quote", 422);
    const renderings = Array.isArray(body?.renderings) ? body.renderings : null;
    if (!renderings || renderings.length < 1 || renderings.length > 3) return errorJson("invalid_renderings", 422);
    const response = await ctx.wp({
      method: "PUT",
      route,
      json: { number: quote.number, quote: JSON.stringify(quote), renderings: JSON.stringify(renderings), arrangement_sha256: snapshot.arrangementSha256 },
    });
    return relayJson(response, (b) => ({ stored: b.stored === true }));
  });
}
