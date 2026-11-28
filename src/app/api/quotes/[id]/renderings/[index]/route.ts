import type { NextRequest } from "next/server";
import { errorJson, guarded, relayJson } from "@/server/http";
import { MAX_RENDER_BYTES, PNG_SIGNATURE, quoteRoute, readBinary, startsWith } from "@/server/quotes";

type Params = { params: Promise<{ id: string; index: string }> };

/** POST /api/quotes/{id}/renderings/{1-3} (image/png) — stores rendering n of this session's quotation once. */
export async function POST(request: NextRequest, { params }: Params) {
  const { id, index } = await params;
  return guarded(request, { session: "require" }, async (ctx) => {
    const route = /^[1-3]$/.test(index) ? quoteRoute(id, `/renderings/${index}`) : null;
    if (!route) return errorJson("quote_not_found", 404);
    const bytes = await readBinary(request, MAX_RENDER_BYTES);
    if (!bytes || !startsWith(bytes, PNG_SIGNATURE)) return errorJson("invalid_image", 422);
    const response = await ctx.wp({ method: "POST", route, binary: { bytes, contentType: "image/png" } });
    return relayJson(response, (b) => ({ stored: b.stored === true }));
  });
}
