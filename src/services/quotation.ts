import type { Arrangement } from "@/domain/arrangement/types";
import { buildOrder } from "@/domain/commerce/order";
import { buildQuote, quoteNumber, type PriceLookup, type QuoteDocument } from "@/domain/commerce/quote";
import { toArrangementDocument } from "@/domain/serialization/arrangementJson";
import { fail, ok, type Result } from "@/domain/shared/issues";
import type { RenderingMetadata } from "@/components/three/photo/photoService";
import type { PhotoProgress } from "@/components/three/photo/photoEngine";
import { downloadBlob } from "./download";
import { buildQuotePdf, type PdfFonts, type PdfTranslate } from "./quotePdf";

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

/**
 * One quotation pipeline for both actions (PDF download and e-mail): validate the arrangement → get
 * WooCommerce prices → render the photos (all from one snapshot of the configuration) → build the PDF.
 * The result is cached per arrangement, rendering count and language, so the e-mail sends exactly the
 * PDF the customer saw/downloaded, and the same quotation is never stored twice.
 */
export interface PreparedQuotation {
  readonly key: string;
  readonly quote: QuoteDocument;
  readonly images: readonly QuoteRendering[];
  readonly pdf: Uint8Array;
  readonly fileName: string;
}

export interface QuotationDeps {
  readonly arrangement: Arrangement;
  /** Store API prices (fetchShopPrices); null when no shop is configured. */
  readonly fetchPrices: ((productIds: number[], skus: string[]) => Promise<PriceLookup>) | null;
  readonly capture: ((count: RenderingCount, options?: CaptureOptions) => Promise<QuoteRendering[]>) | null;
  readonly captureOptions?: CaptureOptions;
  readonly loadFonts: () => Promise<PdfFonts>;
  readonly t: PdfTranslate;
  readonly locale: string;
  readonly now?: () => Date;
}

let cached: PreparedQuotation | null = null;

export function quotationKey(arrangement: Arrangement, count: RenderingCount, locale: string): string {
  return JSON.stringify({ a: toArrangementDocument(arrangement), count, locale });
}

export function clearQuotationCache(): void {
  cached = null;
}

export async function prepareQuotation(count: RenderingCount, deps: QuotationDeps): Promise<Result<PreparedQuotation>> {
  const key = quotationKey(deps.arrangement, count, deps.locale);
  if (cached?.key === key) return ok(cached);

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
  const now = deps.now?.() ?? new Date();
  const quote = buildQuote(deps.arrangement, prices, { number: quoteNumber(now), createdAt: now });
  if (!quote.ok) return quote;

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

  // 4. The PDF.
  const fonts = await deps.loadFonts();
  const pdf = buildQuotePdf({
    quote: quote.value,
    images: images.map((i) => ({ dataUrl: i.jpegDataUrl, width: i.meta.width, height: i.meta.height, mode: i.meta.mode, samples: i.meta.samples })),
    fonts,
    t: deps.t,
    locale: deps.locale,
  });
  cached = { key, quote: quote.value, images, pdf, fileName: `oferta-${quote.value.number}.pdf` };
  return ok(cached);
}

/** Offers the PDF to the browser as a file to save. */
export function downloadPdf(prepared: PreparedQuotation): void {
  downloadBlob(new Blob([prepared.pdf as BlobPart], { type: "application/pdf" }), prepared.fileName);
}

const EMAIL = /^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]{2,}$/;

export function isValidEmail(value: string): boolean {
  const email = value.trim();
  return email.length <= 254 && EMAIL.test(email);
}

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

/** Shop backend (wordpress/multi3d-configurator): stores quotations and sends them by e-mail. */
export interface QuoteBackend {
  readonly baseUrl: string;
  readonly fetch: typeof fetch;
}

const saved = new Set<string>();
/** Arrangement (JSON) → number of the quotation stored for exactly that arrangement. */
const savedNumbers = new Map<string, string>();

/**
 * The number of a quotation stored in the shop for exactly this arrangement, if any. Passed with the
 * cart hand-off so the shop links the order to the quotation (and keeps it beyond 60 days).
 */
export function savedQuoteNumberFor(arrangement: Arrangement): string | undefined {
  return savedNumbers.get(JSON.stringify(toArrangementDocument(arrangement)));
}

/**
 * Stores the quotation in the shop: configuration, pricing snapshot, rendering settings and camera
 * metadata in the database; the PDF and the PNG renderings as files (uploaded one by one, outside the
 * database). Temporary quotations expire after 60 days. Idempotent per prepared quotation, and the shop
 * answers a repeated number with the stored quotation instead of creating a second one.
 */
export async function saveQuotation(prepared: PreparedQuotation, backend: QuoteBackend): Promise<Result<{ number: string }>> {
  if (saved.has(prepared.key)) return ok({ number: prepared.quote.number });
  const base = `${backend.baseUrl}/wp-json/multi3d/v1/quotes`;
  let response: Response;
  try {
    response = await backend.fetch(base, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        number: prepared.quote.number,
        quote: prepared.quote,
        renderings: prepared.images.map((i) => i.meta),
        pdf: bytesToBase64(prepared.pdf),
      }),
    });
  } catch {
    return fail({ code: "quote_backend_unreachable" });
  }
  if (!response.ok) return fail({ code: "quote_save_failed", params: { status: response.status } });
  for (const [index, image] of prepared.images.entries()) {
    try {
      response = await backend.fetch(`${base}/${encodeURIComponent(prepared.quote.number)}/renderings/${index + 1}`, {
        method: "POST",
        headers: { "Content-Type": "image/png" },
        body: image.png,
      });
    } catch {
      return fail({ code: "quote_backend_unreachable" });
    }
    if (!response.ok) return fail({ code: "quote_save_failed", params: { status: response.status } });
  }
  saved.add(prepared.key);
  savedNumbers.set(JSON.stringify(prepared.quote.order.arrangement), prepared.quote.number);
  return ok({ number: prepared.quote.number });
}

/**
 * Sends the stored quotation PDF to `email` through the shop's mail system. The result reflects the
 * shop's actual answer (wp_mail success or failure).
 */
export async function emailQuotation(prepared: PreparedQuotation, email: string, backend: QuoteBackend): Promise<Result<true>> {
  if (!isValidEmail(email)) return fail({ code: "quote_invalid_email" });
  const stored = await saveQuotation(prepared, backend);
  if (!stored.ok) return stored;
  let response: Response;
  try {
    response = await backend.fetch(`${backend.baseUrl}/wp-json/multi3d/v1/quotes/${encodeURIComponent(prepared.quote.number)}/email`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: email.trim() }),
    });
  } catch {
    return fail({ code: "quote_backend_unreachable" });
  }
  if (response.status === 429) return fail({ code: "quote_email_rate_limited" });
  if (!response.ok) return fail({ code: "quote_email_failed", params: { status: response.status } });
  const body = (await response.json().catch(() => null)) as { sent?: boolean } | null;
  return body?.sent === true ? ok(true) : fail({ code: "quote_email_failed", params: { status: response.status } });
}

/** Forgets which quotations were stored (tests). */
export function resetSavedQuotations(): void {
  saved.clear();
  savedNumbers.clear();
}
