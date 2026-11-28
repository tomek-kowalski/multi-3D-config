import type { Arrangement } from "@/domain/arrangement/types";
import { buildOrder } from "@/domain/commerce/order";
import { buildQuote, quoteNumber, type PriceLookup, type QuoteDocument } from "@/domain/commerce/quote";
import { isValidEmail } from "@/domain/shared/email";
import { fail, ok, type Issue, type Result } from "@/domain/shared/issues";
import { arrangementKey, toSnapshotDocument } from "@/domain/sharing/snapshot";
import type { RenderingMetadata } from "@/components/three/photo/photoService";
import type { PhotoProgress } from "@/components/three/photo/photoEngine";
import { answerCode, bffRequest, type BffClient } from "./bff";
import { downloadBlob } from "./download";
import { buildQuotePdf, type PdfFonts, type PdfTranslate } from "./quotePdf";

export { isValidEmail };

export type RenderingCount = 1 | 2 | 3;

/**
 * One quotation rendering from the photorealistic pipeline: the PNG (stored with the quotation), a
 * JPEG copy of the same image for the PDF (keeps the PDF small enough to e-mail), and how it was made.
 */
export interface QuoteRendering {
  readonly png: Blob;
  readonly jpegDataUrl: string;
  readonly meta: RenderingMetadata;
}

export interface CaptureOptions {
  readonly signal?: AbortSignal;
  readonly onProgress?: (progress: PhotoProgress) => void;
}

/** The quotation as reserved on the server: internal id, and the link to its configuration snapshot. */
export interface RemoteQuotation {
  readonly id: string;
  readonly configurationUrl: string;
}

/**
 * One quotation pipeline for both actions (PDF download and e-mail): validate the arrangement → get
 * WooCommerce prices → render the photos → reserve the quotation on the server (number, configuration
 * link) → build the PDF. Everything comes from one snapshot of the configuration. The result is cached per
 * arrangement, rendering count and language, so the e-mail sends exactly the PDF the customer saw, and
 * the same quotation is never stored twice.
 */
export interface PreparedQuotation {
  readonly key: string;
  /** Canonical JSON of the quoted arrangement. */
  readonly arrangementKey: string;
  readonly quote: QuoteDocument;
  readonly images: readonly QuoteRendering[];
  readonly pdf: Uint8Array;
  readonly fileName: string;
  /** null: the server could not reserve it (the PDF is local only, without a configuration link). */
  readonly remote: RemoteQuotation | null;
  /** Why it is local only. */
  readonly remoteIssues: readonly Issue[];
}

export interface QuotationDeps {
  readonly arrangement: Arrangement;
  /** The live arrangement: the renderings must show exactly `arrangement`. */
  readonly current?: () => Arrangement;
  /** Store API prices (fetchShopPrices); null when no shop is configured. */
  readonly fetchPrices: ((productIds: number[], skus: string[]) => Promise<PriceLookup>) | null;
  readonly capture: ((count: RenderingCount, options?: CaptureOptions) => Promise<QuoteRendering[]>) | null;
  readonly captureOptions?: CaptureOptions;
  readonly loadFonts: () => Promise<PdfFonts>;
  readonly t: PdfTranslate;
  readonly locale: string;
  readonly now?: () => Date;
  /** The configurator's server; null: quotations are local only (no number reservation, no link). */
  readonly backend: BffClient | null;
}

let cached: PreparedQuotation | null = null;
/** Prices and renderings of the last quotation, reused when only its server reservation is retried. */
let rendered: { key: string; prices: PriceLookup; images: QuoteRendering[] } | null = null;

export function quotationKey(arrangement: Arrangement, count: RenderingCount, locale: string): string {
  return JSON.stringify({ a: arrangementKey(arrangement), count, locale });
}

export function clearQuotationCache(): void {
  cached = null;
  rendered = null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/**
 * Reserves the quotation: the server assigns the internal id and the unique number, and stores the
 * configuration snapshot that the PDF links to.
 */
export async function reserveQuotation(
  arrangement: Arrangement,
  backend: BffClient,
): Promise<Result<{ id: string; number: string; createdAt: Date; configurationUrl: string }>> {
  const answer = await bffRequest(backend, "/api/quotes", { method: "POST", json: { snapshot: toSnapshotDocument({ arrangement, presentation: {} }) } });
  const d = answer.data;
  if (answer.status !== 201 || !d || typeof d.id !== "string" || !UUID.test(d.id) || typeof d.number !== "string" || typeof d.configurationUrl !== "string") {
    if (answer.status === 429) return fail({ code: "quote_rate_limited" });
    return fail({ code: answer.status === 0 ? "quote_backend_unreachable" : "quote_reserve_failed", params: { status: answer.status, reason: answerCode(answer) } });
  }
  const createdAt = new Date(String(d.createdAt));
  return ok({ id: d.id, number: d.number, createdAt: Number.isNaN(createdAt.getTime()) ? new Date() : createdAt, configurationUrl: d.configurationUrl });
}

/** Steps 1–3: the arrangement is orderable, WooCommerce prices, renderings of exactly this arrangement. */
async function priceAndRender(count: RenderingCount, deps: QuotationDeps): Promise<Result<{ prices: PriceLookup; images: QuoteRendering[] }>> {
  // 1. The complete arrangement must be orderable.
  const order = buildOrder(deps.arrangement);
  if (!order.ok) return order;

  // 2. Prices from WooCommerce (or none when no shop is configured: the PDF says so).
  let prices: PriceLookup = { byId: new Map(), bySku: new Map() };
  if (deps.fetchPrices) {
    const ids = new Set<number>();
    const skus = new Set<string>();
    for (const m of order.value.modules)
      for (const item of m.items) {
        if (item.kind === "product-options") ids.add(item.productId);
        else skus.add(item.sku);
      }
    try {
      prices = await deps.fetchPrices([...ids], [...skus]);
    } catch {
      return fail({ code: "quote_prices_unavailable" });
    }
  }

  // 3. Photorealistic renderings of the configured scene.
  if (!deps.capture) return fail({ code: "quote_renderer_unavailable" });
  let images: QuoteRendering[];
  try {
    images = await deps.capture(count, deps.captureOptions);
  } catch (error) {
    const code = (error as { code?: string } | null)?.code;
    if (code === "cancelled") return fail({ code: "quote_rendering_cancelled" });
    return fail({ code: "quote_rendering_failed" });
  }
  if (images.length !== count) return fail({ code: "quote_rendering_failed" });
  // The renderings show the live scene: it must still be the quoted configuration.
  if (deps.current && arrangementKey(deps.current()) !== arrangementKey(deps.arrangement)) return fail({ code: "quote_configuration_changed" });
  return ok({ prices, images });
}

export async function prepareQuotation(count: RenderingCount, deps: QuotationDeps): Promise<Result<PreparedQuotation>> {
  const key = quotationKey(deps.arrangement, count, deps.locale);
  // A local-only quotation is retried on the server, without rendering again.
  if (cached?.key === key && (cached.remote || !deps.backend)) return ok(cached);
  if (rendered?.key !== key) {
    const steps = await priceAndRender(count, deps);
    if (!steps.ok) return steps;
    rendered = { key, ...steps.value };
  }
  const { prices, images } = rendered;

  // 4. Number and configuration link from the server (a local number when it cannot be reached).
  const reservation = deps.backend ? await reserveQuotation(deps.arrangement, deps.backend) : fail({ code: "quote_backend_not_configured" });
  const now = deps.now?.() ?? new Date();
  const number = reservation.ok ? reservation.value.number : quoteNumber(now);
  const createdAt = reservation.ok ? reservation.value.createdAt : now;
  const quote = buildQuote(deps.arrangement, prices, { number, createdAt });
  if (!quote.ok) return quote;

  // 5. The PDF.
  const fonts = await deps.loadFonts();
  const pdf = buildQuotePdf({
    quote: quote.value,
    images: images.map((i) => ({ dataUrl: i.jpegDataUrl, width: i.meta.width, height: i.meta.height, mode: i.meta.mode, samples: i.meta.samples })),
    fonts,
    t: deps.t,
    locale: deps.locale,
    configurationUrl: reservation.ok ? reservation.value.configurationUrl : null,
  });
  const prepared: PreparedQuotation = {
    key,
    arrangementKey: arrangementKey(deps.arrangement),
    quote: quote.value,
    images,
    pdf,
    fileName: `oferta-${quote.value.number}.pdf`,
    remote: reservation.ok ? { id: reservation.value.id, configurationUrl: reservation.value.configurationUrl } : null,
    remoteIssues: reservation.ok ? [] : reservation.issues,
  };
  cached = prepared;
  return ok(prepared);
}

/** Offers the PDF to the browser as a file to save. */
export function downloadPdf(prepared: PreparedQuotation): void {
  downloadBlob(new Blob([prepared.pdf as BlobPart], { type: "application/pdf" }), prepared.fileName);
}

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

/** Back-compat name of the client of the configurator's server. */
export type QuoteBackend = BffClient;

const saved = new Set<string>();
/** Arrangement (canonical JSON) → the quotation stored for exactly that arrangement. */
const savedQuotes = new Map<string, { id: string; number: string }>();

/**
 * The quotation stored for exactly this arrangement, if any. The cart hand-off then asks the server for
 * a claim, so the shop links the order to the quotation (and keeps it beyond 60 days).
 */
export function savedQuoteFor(arrangement: Arrangement): { id: string; number: string } | undefined {
  return savedQuotes.get(arrangementKey(arrangement));
}

export function savedQuoteNumberFor(arrangement: Arrangement): string | undefined {
  return savedQuoteFor(arrangement)?.number;
}

const saveFailed = (status: number): Result<never> =>
  fail(status === 0 ? { code: "quote_backend_unreachable" } : { code: "quote_save_failed", params: { status } });

/**
 * Stores the reserved quotation through the configurator's server: the quotation document
 * (configuration + pricing snapshot) and rendering metadata in the database; the PDF and the PNG
 * renderings as files, outside the database. Idempotent: each part is written once.
 */
export async function saveQuotation(prepared: PreparedQuotation, backend: BffClient): Promise<Result<{ number: string }>> {
  if (!prepared.remote) return fail(...(prepared.remoteIssues.length ? prepared.remoteIssues : [{ code: "quote_not_reserved" }]));
  if (saved.has(prepared.key)) return ok({ number: prepared.quote.number });
  const base = `/api/quotes/${prepared.remote.id}`;
  let answer = await bffRequest(backend, base, {
    method: "PUT",
    json: { quote: prepared.quote, renderings: prepared.images.map((i) => i.meta) },
  });
  // 409: stored by an earlier attempt (e.g. the response was lost).
  if (answer.status !== 201 && answer.status !== 409) return saveFailed(answer.status);
  answer = await bffRequest(backend, `${base}/pdf`, { method: "POST", body: prepared.pdf, contentType: "application/pdf" });
  if (answer.status !== 200 && answer.status !== 201) return saveFailed(answer.status);
  for (const [index, image] of prepared.images.entries()) {
    answer = await bffRequest(backend, `${base}/renderings/${index + 1}`, { method: "POST", body: image.png, contentType: "image/png" });
    if (answer.status !== 200 && answer.status !== 201) return saveFailed(answer.status);
  }
  saved.add(prepared.key);
  savedQuotes.set(prepared.arrangementKey, { id: prepared.remote.id, number: prepared.quote.number });
  return ok({ number: prepared.quote.number });
}

/**
 * Sends the stored quotation PDF to `email` through the shop's mail system (via the configurator's
 * server). The result reflects the shop's actual answer (wp_mail success or failure).
 */
export async function emailQuotation(prepared: PreparedQuotation, email: string, backend: BffClient): Promise<Result<true>> {
  if (!isValidEmail(email)) return fail({ code: "quote_invalid_email" });
  const stored = await saveQuotation(prepared, backend);
  if (!stored.ok) return stored;
  const answer = await bffRequest(backend, `/api/quotes/${prepared.remote!.id}/email`, { method: "POST", json: { email: email.trim() } });
  if (answer.status === 0) return fail({ code: "quote_backend_unreachable" });
  if (answer.status === 429) return fail({ code: "quote_email_rate_limited" });
  if (answer.status !== 200 || answer.data.sent !== true) return fail({ code: "quote_email_failed", params: { status: answer.status } });
  return ok(true);
}

/** A single-use claim linking the cart hand-off to this session's stored quotation, or null. */
export async function cartClaimFor(arrangement: Arrangement, backend: BffClient): Promise<string | null> {
  const quote = savedQuoteFor(arrangement);
  if (!quote) return null;
  const answer = await bffRequest(backend, `/api/quotes/${quote.id}/cart-claim`, { method: "POST" });
  return answer.status === 200 && typeof answer.data.claim === "string" ? answer.data.claim : null;
}

export interface StoredQuotation {
  readonly id: string;
  readonly number: string;
  readonly status: string;
  readonly hasPdf: boolean;
  readonly createdAt: string;
  readonly expiresAt: string | null;
}

/** The quotations of this browser session ("Twoje oferty"). */
export async function listQuotations(backend: BffClient): Promise<Result<StoredQuotation[]>> {
  const answer = await bffRequest(backend, "/api/quotes", { method: "GET" });
  if (answer.status !== 200 || !Array.isArray(answer.data.quotes)) return fail({ code: answer.status === 0 ? "quote_backend_unreachable" : "quote_list_failed" });
  return ok(
    (answer.data.quotes as Record<string, unknown>[])
      .filter((q) => typeof q.id === "string" && UUID.test(q.id) && typeof q.number === "string")
      .map((q) => ({
        id: q.id as string,
        number: q.number as string,
        status: String(q.status),
        hasPdf: q.has_pdf === true,
        createdAt: String(q.created_at),
        expiresAt: typeof q.expires_at === "string" ? q.expires_at : null,
      })),
  );
}

/** Address of a stored quotation's PDF (served to its owner only). */
export function quotationPdfUrl(id: string): string {
  return `/api/quotes/${encodeURIComponent(id)}/pdf`;
}

/** Forgets which quotations were stored (tests, "Nowa konfiguracja" keeps them on the server). */
export function resetSavedQuotations(): void {
  saved.clear();
  savedQuotes.clear();
}
