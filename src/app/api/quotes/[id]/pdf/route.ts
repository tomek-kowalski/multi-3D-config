import { NextResponse, type NextRequest } from "next/server";
import { errorJson, guarded, relayJson } from "@/server/http";
import { MAX_PDF_BYTES, PDF_SIGNATURE, quoteRoute, readBinary, startsWith } from "@/server/quotes";

type Params = { params: Promise<{ id: string }> };

/** POST /api/quotes/{id}/pdf (application/pdf) — stores the quotation PDF once (owner only). */
export async function POST(request: NextRequest, { params }: Params) {
  const { id } = await params;
  return guarded(request, { session: "require" }, async (ctx) => {
    const route = quoteRoute(id, "/pdf");
    if (!route) return errorJson("quote_not_found", 404);
    const bytes = await readBinary(request, MAX_PDF_BYTES);
    if (!bytes || !startsWith(bytes, PDF_SIGNATURE)) return errorJson("invalid_pdf", 422);
    const response = await ctx.wp({ method: "POST", route, binary: { bytes, contentType: "application/pdf" } });
    return relayJson(response, (b) => ({ stored: b.stored === true }));
  });
}

/** GET /api/quotes/{id}/pdf — the stored PDF of one of this session's quotations (private, not cached). */
export async function GET(request: NextRequest, { params }: Params) {
  const { id } = await params;
  return guarded(request, { session: "require" }, async (ctx) => {
    const route = quoteRoute(id, "/pdf");
    if (!route) return errorJson("quote_not_found", 404);
    const response = await ctx.wp({ method: "GET", route });
    if (!response.ok || !(response.headers.get("content-type") ?? "").startsWith("application/pdf")) return relayJson(response);
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (!startsWith(bytes, PDF_SIGNATURE)) return errorJson("backend_error", 502);
    const number = (response.headers.get("x-multi3d-quote-number") ?? "").replace(/[^A-Z0-9-]/g, "");
    return new NextResponse(bytes as BodyInit, {
      status: 200,
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `attachment; filename="oferta-${number || "konfigurator"}.pdf"`,
      },
    });
  });
}
