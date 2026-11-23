import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { addModule } from "@/domain/arrangement/operations";
import type { Arrangement } from "@/domain/arrangement/types";
import type { PriceLookup } from "@/domain/commerce/quote";
import { DEFAULT_ROOM } from "@/domain/room/defaults";
import { isMessageKey, translate } from "@/i18n";
import {
  bytesToBase64,
  clearQuotationCache,
  emailQuotation,
  isValidEmail,
  prepareQuotation,
  resetSavedQuotations,
  saveQuotation,
  savedQuoteNumberFor,
  type QuotationDeps,
  type QuoteRendering,
} from "./quotation";

const FONT_DIR = join(__dirname, "../../public/fonts");
const fonts = {
  regular: readFileSync(join(FONT_DIR, "DejaVuSans.ttf")).toString("base64"),
  bold: readFileSync(join(FONT_DIR, "DejaVuSans-Bold.ttf")).toString("base64"),
};
// 1 × 1 JPEG.
const JPEG =
  "data:image/jpeg;base64,/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=";

/** A finished rendering as the photo pipeline delivers it (PNG + JPEG for the PDF + metadata). */
function rendering(index: number, mode: "pathtraced" | "raster" = "pathtraced"): QuoteRendering {
  return {
    png: new Blob([`PNG-${index}`], { type: "image/png" }),
    jpegDataUrl: JPEG,
    meta: {
      view: (["front-right", "front-left", "front"] as const)[index],
      mode,
      samples: mode === "pathtraced" ? 192 : 1,
      targetSamples: 192,
      width: 1920,
      height: 1080,
      durationMs: 1000,
      camera: { position: [4.5, 1.8, 3.3], target: [2, 0.9, 0.4], fov: 40 },
      hiddenWalls: [],
      settings: { width: 1920, height: 1080, quality: "standard", toneMapping: "neutral", exposure: 1, denoise: true, allowRasterFallback: true, frameMargin: 0.1 },
      fallbackReason: null,
    },
  };
}

function arrangement(): Arrangement {
  let a: Arrangement = { room: { ...DEFAULT_ROOM, width: 6000 }, modules: [] };
  for (const type of ["cabinet", "clickbed-o", "cabinet"]) {
    const r = addModule(a, type);
    if (!r.ok) throw new Error();
    a = r.value.arrangement;
  }
  return a;
}

function deps(overrides: Partial<QuotationDeps> = {}) {
  const capture = vi.fn(async (count: number) => Array.from({ length: count }, (_, i) => rendering(i)));
  const fetchPrices = vi.fn(async (): Promise<PriceLookup> => ({ byId: new Map([[4000, { amount: 10390, currency: "PLN" }]]), bySku: new Map() }));
  const base: QuotationDeps = {
    arrangement: arrangement(),
    fetchPrices,
    capture,
    loadFonts: async () => fonts,
    t: (key, params) => (isMessageKey(key) ? translate("pl", key, params) : key),
    locale: "pl-PL",
    now: () => new Date("2026-11-24T10:00:00Z"),
  };
  return { deps: { ...base, ...overrides }, capture, fetchPrices };
}

function backend(responses: (Response | Error)[]) {
  const calls: { url: string; body: Record<string, unknown>; blob?: Blob; type?: string }[] = [];
  const fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const type = (init?.headers as Record<string, string> | undefined)?.["Content-Type"];
    if (init?.body instanceof Blob) calls.push({ url: String(url), body: {}, blob: init.body, type });
    else calls.push({ url: String(url), body: JSON.parse(String(init?.body ?? "{}")), type });
    const next = responses.shift();
    if (!next || next instanceof Error) throw next ?? new Error("no response");
    return next;
  });
  return { backend: { baseUrl: "https://shop.example", fetch: fetch as unknown as typeof globalThis.fetch }, calls };
}

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

beforeEach(() => {
  clearQuotationCache();
  resetSavedQuotations();
});

describe("quotation pipeline", () => {
  it("prices and renders the complete arrangement into one PDF", async () => {
    const { deps: d, capture, fetchPrices } = deps();
    const result = await prepareQuotation(2, d);
    if (!result.ok) throw new Error(JSON.stringify(result.issues));
    expect(result.value.quote.modules).toHaveLength(3);
    expect(fetchPrices).toHaveBeenCalledWith([4000], expect.arrayContaining(["KC-SIDE-T16-18-H1201-2000-W300-800"]));
    expect(capture).toHaveBeenCalledWith(2, undefined);
    expect(result.value.images).toHaveLength(2);
    expect(result.value.images.map((i) => i.meta.view)).toEqual(["front-right", "front-left"]);
    expect(new TextDecoder().decode(result.value.pdf.slice(0, 5))).toBe("%PDF-");
    expect(result.value.fileName).toMatch(/^oferta-OF-20261124-[A-Z2-9]{4}\.pdf$/);
  });

  it("reuses the same quotation (renderings and PDF) for download and e-mail", async () => {
    const { deps: d, capture } = deps();
    const first = await prepareQuotation(1, d);
    const second = await prepareQuotation(1, d);
    expect(capture).toHaveBeenCalledTimes(1);
    expect(first.ok && second.ok && first.value.pdf === second.value.pdf).toBe(true);
    await prepareQuotation(3, d); // a different rendering count is a new quotation
    expect(capture).toHaveBeenCalledTimes(2);
  });

  it("stops when prices cannot be validated or the renderer is missing", async () => {
    expect(await prepareQuotation(1, deps({ fetchPrices: async () => Promise.reject(new Error("503")) }).deps)).toMatchObject({
      ok: false,
      issues: [{ code: "quote_prices_unavailable" }],
    });
    expect(await prepareQuotation(1, deps({ capture: null }).deps)).toMatchObject({ ok: false, issues: [{ code: "quote_renderer_unavailable" }] });
    expect(await prepareQuotation(1, deps({ capture: async () => Promise.reject(Object.assign(new Error(), { code: "cancelled" })) }).deps)).toMatchObject({
      ok: false,
      issues: [{ code: "quote_rendering_cancelled" }],
    });
    // A failed or incomplete rendering never becomes a quotation.
    expect(await prepareQuotation(2, deps({ capture: async () => [rendering(0)] }).deps)).toMatchObject({ ok: false, issues: [{ code: "quote_rendering_failed" }] });
    expect(await prepareQuotation(1, deps({ arrangement: { room: DEFAULT_ROOM, modules: [] } }).deps)).toMatchObject({ ok: false });
  });
});

describe("quotation e-mail", () => {
  async function prepared() {
    const r = await prepareQuotation(1, deps().deps);
    if (!r.ok) throw new Error();
    return r.value;
  }

  it("validates the address before contacting the shop", async () => {
    expect(isValidEmail("klient@example.pl")).toBe(true);
    for (const bad of ["", "klient", "a@b", "a@b.c", "a b@c.pl", "a@b.pl,c@d.pl"]) expect(isValidEmail(bad)).toBe(false);
    const { backend: b, calls } = backend([]);
    expect(await emailQuotation(await prepared(), "nope", b)).toMatchObject({ ok: false, issues: [{ code: "quote_invalid_email" }] });
    expect(calls).toHaveLength(0);
  });

  it("stores the quotation (metadata in the record, PNGs as files), then sends exactly that PDF", async () => {
    const q = await prepared();
    const { backend: b, calls } = backend([json(201, { number: q.quote.number }), json(201, { stored: true }), json(200, { sent: true })]);
    expect(await emailQuotation(q, " klient@example.pl ", b)).toEqual({ ok: true, value: true });
    expect(calls[0].url).toBe("https://shop.example/wp-json/multi3d/v1/quotes");
    expect(calls[0].body.pdf).toBe(bytesToBase64(q.pdf));
    expect(calls[0].body.quote).toEqual(JSON.parse(JSON.stringify(q.quote)));
    expect(calls[0].body.renderings).toEqual(q.images.map((i) => JSON.parse(JSON.stringify(i.meta))));
    expect(calls[0].body).not.toHaveProperty("images"); // no image data in the database record
    expect(calls[1]).toMatchObject({ url: `https://shop.example/wp-json/multi3d/v1/quotes/${q.quote.number}/renderings/1`, type: "image/png" });
    expect(calls[1].blob).toBe(q.images[0].png);
    expect(calls[2].url).toBe(`https://shop.example/wp-json/multi3d/v1/quotes/${q.quote.number}/email`);
    expect(calls[2].body).toEqual({ email: "klient@example.pl" });
    expect(savedQuoteNumberFor(arrangement())).toBe(q.quote.number);
  });

  it("stores each quotation once (download, then e-mail: one record, one upload)", async () => {
    const q = await prepared();
    const { backend: b, calls } = backend([json(201, {}), json(201, {}), json(200, { sent: true })]);
    expect(await saveQuotation(q, b)).toEqual({ ok: true, value: { number: q.quote.number } });
    expect(await emailQuotation(q, "klient@example.pl", b)).toEqual({ ok: true, value: true });
    expect(calls.map((c) => c.url.replace(/.*\/v1/, ""))).toEqual(["/quotes", `/quotes/${q.quote.number}/renderings/1`, `/quotes/${q.quote.number}/email`]);
  });

  it("reports the shop's actual failure", async () => {
    const q = await prepared();
    expect(await emailQuotation(q, "klient@example.pl", backend([json(201, {}), json(201, {}), json(502, { sent: false })]).backend)).toMatchObject({
      ok: false,
      issues: [{ code: "quote_email_failed" }],
    });
    expect(await emailQuotation(q, "klient@example.pl", backend([json(429, {})]).backend)).toMatchObject({
      ok: false,
      issues: [{ code: "quote_email_rate_limited" }],
    });
    resetSavedQuotations();
    expect(await emailQuotation(q, "klient@example.pl", backend([new Error("offline")]).backend)).toMatchObject({
      ok: false,
      issues: [{ code: "quote_backend_unreachable" }],
    });
    expect(await saveQuotation(q, backend([json(500, {})]).backend)).toMatchObject({ ok: false, issues: [{ code: "quote_save_failed" }] });
    // A rejected image upload is a failed save (never reported as stored).
    expect(await saveQuotation(q, backend([json(201, {}), json(400, { code: "invalid_image" })]).backend)).toMatchObject({
      ok: false,
      issues: [{ code: "quote_save_failed" }],
    });
  });
});
