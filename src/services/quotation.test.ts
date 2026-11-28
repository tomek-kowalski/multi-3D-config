import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { addModule } from "@/domain/arrangement/operations";
import type { Arrangement } from "@/domain/arrangement/types";
import type { PriceLookup } from "@/domain/commerce/quote";
import { DEFAULT_ROOM } from "@/domain/room/defaults";
import { isMessageKey, translate } from "@/i18n";
import {
  cartClaimFor,
  clearQuotationCache,
  emailQuotation,
  isValidEmail,
  prepareQuotation,
  resetSavedQuotations,
  saveQuotation,
  savedQuoteFor,
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
    backend: null,
  };
  return { deps: { ...base, ...overrides }, capture, fetchPrices };
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

const QUOTE_ID = "3f2b8a4e-1c2d-4e5f-9a6b-7c8d9e0f1a2b";
const CONFIG_URL = "https://configurator.example.pl/c/AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-abcde";

type Call = { method: string; path: string; headers: Record<string, string>; json?: Record<string, unknown>; body?: unknown };

/** The configurator's server (BFF) as the browser sees it: answers by "METHOD path". */
function server(answers: Record<string, (Response | Error)[]>) {
  const calls: Call[] = [];
  const fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const path = String(url).replace("https://cfg.test", "");
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const call: Call = { method: init?.method ?? "GET", path, headers };
    if (headers["Content-Type"] === "application/json") call.json = JSON.parse(String(init?.body));
    else call.body = init?.body;
    calls.push(call);
    const queue = answers[`${call.method} ${path}`];
    const next = queue?.shift();
    if (!next || next instanceof Error) throw next ?? new Error(`unexpected ${call.method} ${path}`);
    return next;
  });
  return { backend: { baseUrl: "https://cfg.test", fetch: fetch as unknown as typeof globalThis.fetch }, calls };
}

const reserved = () => json(201, { id: QUOTE_ID, number: "OF-20261124-7K3QZD", createdAt: "2026-11-24T10:00:00+00:00", expiresAt: "2027-01-23T10:00:00+00:00", configurationUrl: CONFIG_URL });
const Q = `/api/quotes/${QUOTE_ID}`;

describe("quotation reservation (number and configuration link from the server)", () => {
  it("uses the server's number and prints the configuration link of the quoted snapshot in the PDF", async () => {
    const { backend: b, calls } = server({ "POST /api/quotes": [reserved()] });
    const result = await prepareQuotation(1, deps({ backend: b }).deps);
    if (!result.ok) throw new Error(JSON.stringify(result.issues));
    expect(result.value.quote.number).toBe("OF-20261124-7K3QZD");
    expect(result.value.remote).toEqual({ id: QUOTE_ID, configurationUrl: CONFIG_URL });
    expect(result.value.fileName).toBe("oferta-OF-20261124-7K3QZD.pdf");
    const pdfText = new TextDecoder("latin1").decode(result.value.pdf);
    expect(pdfText).toContain(`/URI (${CONFIG_URL})`);
    // The reservation carries the configuration snapshot (no prices, no session data) and the CSRF header.
    expect(calls).toHaveLength(1);
    expect(calls[0].headers["X-Multi3D-Request"]).toBe("1");
    const snapshot = calls[0].json!.snapshot as Record<string, unknown>;
    expect(snapshot.format).toBe("multi3d-configuration-snapshot");
    expect((snapshot.arrangement as { modules: unknown[] }).modules).toHaveLength(3);
    expect(JSON.stringify(snapshot)).not.toMatch(/price|email|session|cart/i);
  });

  it("falls back to a local, unstored quotation without a link when the server cannot reserve it", async () => {
    const { backend: b } = server({ "POST /api/quotes": [json(503, { code: "backend_not_configured" })] });
    const result = await prepareQuotation(1, deps({ backend: b }).deps);
    if (!result.ok) throw new Error();
    expect(result.value.remote).toBeNull();
    expect(result.value.quote.number).toMatch(/^OF-20261124-[A-Z2-9]{4}$/);
    expect(new TextDecoder("latin1").decode(result.value.pdf)).not.toContain("/URI");
    expect(await saveQuotation(result.value, b)).toMatchObject({ ok: false, issues: [{ code: "quote_reserve_failed" }] });
  });

  it("refuses renderings of a configuration that changed while rendering", async () => {
    const other = { room: DEFAULT_ROOM, modules: [] };
    expect(await prepareQuotation(1, deps({ current: () => other }).deps)).toMatchObject({ ok: false, issues: [{ code: "quote_configuration_changed" }] });
  });
});

describe("quotation storage and e-mail (through the configurator's server)", () => {
  async function prepared(b: ReturnType<typeof server>["backend"]) {
    const r = await prepareQuotation(1, deps({ backend: b }).deps);
    if (!r.ok || !r.value.remote) throw new Error(JSON.stringify(r));
    return r.value;
  }

  it("validates the address before contacting the server", async () => {
    expect(isValidEmail("klient@example.pl")).toBe(true);
    for (const bad of ["", "klient", "a@b", "a@b.c", "a b@c.pl", "a@b.pl,c@d.pl", "x@y.pl\r\nBcc: z@w.pl"]) expect(isValidEmail(bad)).toBe(false);
    const { backend: b, calls } = server({ "POST /api/quotes": [reserved()] });
    expect(await emailQuotation(await prepared(b), "nope", b)).toMatchObject({ ok: false, issues: [{ code: "quote_invalid_email" }] });
    expect(calls).toHaveLength(1); // the reservation only
  });

  it("stores the document, the PDF and the PNGs by quotation id, then sends exactly that PDF", async () => {
    const { backend: b, calls } = server({
      "POST /api/quotes": [reserved()],
      [`PUT ${Q}`]: [json(201, { stored: true })],
      [`POST ${Q}/pdf`]: [json(201, { stored: true })],
      [`POST ${Q}/renderings/1`]: [json(201, { stored: true })],
      [`POST ${Q}/email`]: [json(200, { sent: true })],
    });
    const q = await prepared(b);
    expect(await emailQuotation(q, " klient@example.pl ", b)).toEqual({ ok: true, value: true });
    const [, put, pdf, png, mail] = calls;
    expect(put.json!.quote).toEqual(JSON.parse(JSON.stringify(q.quote)));
    expect(put.json!.renderings).toEqual(q.images.map((i) => JSON.parse(JSON.stringify(i.meta))));
    expect(put.json).not.toHaveProperty("pdf"); // no binaries in the database record
    expect(pdf.headers["Content-Type"]).toBe("application/pdf");
    expect(pdf.body).toBe(q.pdf);
    expect(png.headers["Content-Type"]).toBe("image/png");
    expect(png.body).toBe(q.images[0].png);
    expect(mail.json).toEqual({ email: "klient@example.pl" });
    // The quotation number is never used to address anything.
    expect(calls.every((c) => !c.path.includes("OF-"))).toBe(true);
    expect(savedQuoteFor(arrangement())).toEqual({ id: QUOTE_ID, number: "OF-20261124-7K3QZD" });
  });

  it("stores each quotation once (download, then e-mail), and accepts an earlier store (409)", async () => {
    const { backend: b, calls } = server({
      "POST /api/quotes": [reserved()],
      [`PUT ${Q}`]: [json(409, { code: "quote_already_stored" })],
      [`POST ${Q}/pdf`]: [json(200, { stored: true })],
      [`POST ${Q}/renderings/1`]: [json(200, { stored: true })],
      [`POST ${Q}/email`]: [json(200, { sent: true })],
    });
    const q = await prepared(b);
    expect(await saveQuotation(q, b)).toEqual({ ok: true, value: { number: q.quote.number } });
    expect(await emailQuotation(q, "klient@example.pl", b)).toEqual({ ok: true, value: true });
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual(["POST /api/quotes", `PUT ${Q}`, `POST ${Q}/pdf`, `POST ${Q}/renderings/1`, `POST ${Q}/email`]);
  });

  it("reports the server's actual failure", async () => {
    const { backend: b } = server({
      "POST /api/quotes": [reserved()],
      [`PUT ${Q}`]: [json(201, {}), json(500, {})],
      [`POST ${Q}/pdf`]: [json(201, {})],
      [`POST ${Q}/renderings/1`]: [json(201, {})],
      [`POST ${Q}/email`]: [json(502, { code: "email_failed" }), json(429, { code: "rate_limited" })],
    });
    const q = await prepared(b);
    expect(await emailQuotation(q, "klient@example.pl", b)).toMatchObject({ ok: false, issues: [{ code: "quote_email_failed" }] });
    expect(await emailQuotation(q, "klient@example.pl", b)).toMatchObject({ ok: false, issues: [{ code: "quote_email_rate_limited" }] });
    resetSavedQuotations();
    expect(await saveQuotation(q, b)).toMatchObject({ ok: false, issues: [{ code: "quote_save_failed", params: { status: 500 } }] });
    resetSavedQuotations();
    expect(await saveQuotation(q, server({ [`PUT ${Q}`]: [new Error("offline")] }).backend)).toMatchObject({ ok: false, issues: [{ code: "quote_backend_unreachable" }] });
    // A rejected image upload is a failed save (never reported as stored).
    const rejected = server({ [`PUT ${Q}`]: [json(201, {})], [`POST ${Q}/pdf`]: [json(201, {})], [`POST ${Q}/renderings/1`]: [json(422, { code: "invalid_image" })] });
    expect(await saveQuotation(q, rejected.backend)).toMatchObject({ ok: false, issues: [{ code: "quote_save_failed" }] });
  });

  it("links the cart hand-off with a single-use claim of the stored quotation, never with its number", async () => {
    const { backend: b } = server({
      "POST /api/quotes": [reserved()],
      [`PUT ${Q}`]: [json(201, {})],
      [`POST ${Q}/pdf`]: [json(201, {})],
      [`POST ${Q}/renderings/1`]: [json(201, {})],
      [`POST ${Q}/cart-claim`]: [json(200, { claim: "c".repeat(43) })],
    });
    expect(await cartClaimFor(arrangement(), b)).toBeNull(); // nothing stored yet
    await saveQuotation(await prepared(b), b);
    expect(await cartClaimFor(arrangement(), b)).toBe("c".repeat(43));
    expect(await cartClaimFor({ room: DEFAULT_ROOM, modules: [] }, b)).toBeNull(); // another arrangement
  });
});
