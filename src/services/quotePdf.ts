import { jsPDF } from "jspdf";
import { QUOTE_RETENTION_DAYS, type QuoteDocument } from "@/domain/commerce/quote";
import { summaryValue } from "@/i18n";

/**
 * The quotation PDF (A4). One builder for both the download and the e-mail attachment. Text uses an
 * embedded DejaVu Sans (public/fonts), because the PDF standard fonts cannot encode Polish letters.
 */
export interface PdfFonts {
  /** Base64 TTF data. */
  readonly regular: string;
  readonly bold: string;
}

/** Translation function for the PDF texts (keys of the i18n catalogs; unknown keys returned as is). */
export type PdfTranslate = (key: string, params?: Readonly<Record<string, string | number>>) => string;

/** One rendering in the PDF. */
export interface QuotePdfImage {
  /** JPEG or PNG data URL. */
  readonly dataUrl: string;
  readonly width: number;
  readonly height: number;
  /** How it was made: the caption says it (a raster image is never called photorealistic). */
  readonly mode: "pathtraced" | "raster";
  readonly samples: number;
}

export interface QuotePdfInput {
  readonly quote: QuoteDocument;
  /** The 3D renderings, in order. */
  readonly images: readonly QuotePdfImage[];
  readonly fonts: PdfFonts;
  readonly t: PdfTranslate;
  /** BCP 47 locale for dates and money, e.g. "pl-PL". */
  readonly locale: string;
}

const PAGE = { width: 210, height: 297, margin: 16 };
const CONTENT_WIDTH = PAGE.width - 2 * PAGE.margin;

export function buildQuotePdf({ quote, images, fonts, t, locale }: QuotePdfInput): Uint8Array {
  const doc = new jsPDF({ unit: "mm", format: "a4", compress: true });
  doc.addFileToVFS("DejaVuSans.ttf", fonts.regular);
  doc.addFont("DejaVuSans.ttf", "DejaVu", "normal");
  doc.addFileToVFS("DejaVuSans-Bold.ttf", fonts.bold);
  doc.addFont("DejaVuSans-Bold.ttf", "DejaVu", "bold");
  doc.setProperties({ title: `${t("quote.pdfTitle")} ${quote.number}`, creator: "multi-3D-config" });

  const money = (amount: number | null) =>
    amount === null || !quote.currency
      ? t("quote.priceMissing")
      : new Intl.NumberFormat(locale, { style: "currency", currency: quote.currency }).format(amount);
  const date = new Intl.DateTimeFormat(locale, { dateStyle: "long" }).format(new Date(quote.createdAt));

  let y = PAGE.margin;
  const ensure = (height: number) => {
    if (y + height > PAGE.height - PAGE.margin) {
      doc.addPage();
      y = PAGE.margin;
    }
  };
  const text = (value: string, size: number, bold = false, x = PAGE.margin, width = CONTENT_WIDTH) => {
    doc.setFont("DejaVu", bold ? "bold" : "normal");
    doc.setFontSize(size);
    const lines = doc.splitTextToSize(value, width) as string[];
    const lineHeight = size * 0.45;
    ensure(lines.length * lineHeight);
    doc.text(lines, x, y + lineHeight * 0.8);
    y += lines.length * lineHeight;
  };

  // Header
  text(t("quote.pdfTitle"), 20, true);
  y += 1;
  text(`${t("quote.number")}: ${quote.number}`, 11);
  text(`${t("quote.date")}: ${date}`, 11);
  text(t("quote.validity", { days: QUOTE_RETENTION_DAYS }), 9);
  y += 4;

  // 3D renderings
  for (const [i, image] of images.entries()) {
    const height = CONTENT_WIDTH * (image.height / image.width);
    ensure(height + 8);
    doc.addImage(image.dataUrl, image.dataUrl.startsWith("data:image/png") ? "PNG" : "JPEG", PAGE.margin, y, CONTENT_WIDTH, height);
    y += height + 1;
    const params = { n: i + 1, count: images.length, samples: image.samples };
    text(t(image.mode === "pathtraced" ? "quote.renderingCaptionPhoto" : "quote.renderingCaptionRaster", params), 8);
    y += 3;
  }

  // Modules
  ensure(14);
  text(t("quote.modulesHeading", { count: quote.modules.length }), 14, true);
  y += 2;
  for (const entry of quote.modules) {
    ensure(24);
    doc.setDrawColor(210);
    doc.line(PAGE.margin, y, PAGE.margin + CONTENT_WIDTH, y);
    y += 3;
    const priceText = money(entry.price);
    doc.setFont("DejaVu", "bold");
    doc.setFontSize(12);
    const priceWidth = doc.getTextWidth(priceText);
    doc.text(priceText, PAGE.margin + CONTENT_WIDTH - priceWidth, y + 4.3);
    text(`${t(entry.nameKey)} · ${entry.moduleId}`, 12, true, PAGE.margin, CONTENT_WIDTH - priceWidth - 4);
    text(
      `${t("quote.dimensions")}: ${Math.round(entry.dimensions.width)} × ${Math.round(entry.dimensions.height)} × ${Math.round(entry.dimensions.depth)} mm`,
      9,
    );
    for (const row of entry.summary) text(`${t(row.labelKey)}: ${summaryValue(t, row)}`, 9);
    if (entry.optionsPricedInCart) text(t("quote.optionsInCart"), 8);
    y += 3;
  }

  // Total
  ensure(16);
  doc.setDrawColor(60);
  doc.line(PAGE.margin, y, PAGE.margin + CONTENT_WIDTH, y);
  y += 3;
  const totalText = money(quote.total);
  doc.setFont("DejaVu", "bold");
  doc.setFontSize(14);
  doc.text(totalText, PAGE.margin + CONTENT_WIDTH - doc.getTextWidth(totalText), y + 5);
  text(t("quote.total"), 14, true);
  y += 3;
  text(t("quote.pricesFromShop"), 8);
  if (quote.optionsPricedInCart) text(t("quote.optionsInCartTotal"), 8);
  if (quote.total === null) text(t("quote.totalIncomplete"), 8);

  return new Uint8Array(doc.output("arraybuffer"));
}

/** Loads the embedded fonts in the browser (served from public/fonts). */
export async function loadPdfFonts(): Promise<PdfFonts> {
  const load = async (file: string) => {
    const response = await fetch(`/fonts/${file}`);
    if (!response.ok) throw new Error(`Font ${file}: ${response.status}`);
    return arrayBufferToBase64(await response.arrayBuffer());
  };
  const [regular, bold] = await Promise.all([load("DejaVuSans.ttf"), load("DejaVuSans-Bold.ttf")]);
  return { regular, bold };
}

export function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}
