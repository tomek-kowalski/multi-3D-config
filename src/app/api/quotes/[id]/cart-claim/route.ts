import type { NextRequest } from "next/server";
import { errorJson, guarded, relayJson } from "@/server/http";
import { quoteRoute } from "@/server/quotes";

type Params = { params: Promise<{ id: string }> };

/**
 * POST /api/quotes/{id}/cart-claim — a single-use claim (random, valid for one hour) that links the cart
 * hand-off to one of this session's quotations. The cart form posts the claim instead of the quotation
 * number, so nobody can attach another customer's quotation to their order by guessing a number.
 */
export async function POST(request: NextRequest, { params }: Params) {
  const { id } = await params;
  return guarded(request, { session: "require" }, async (ctx) => {
    const route = quoteRoute(id, "/cart-claim");
    if (!route) return errorJson("quote_not_found", 404);
    const response = await ctx.wp({ method: "POST", route });
    return relayJson(response, (b) => ({ claim: typeof b.claim === "string" ? b.claim : null }));
  });
}
