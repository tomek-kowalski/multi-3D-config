import type { Arrangement } from "../arrangement/types";
import { getFurnitureType } from "../modules/registry";
import type { ConfigurationSummaryRow, ModuleFootprint, ModuleId } from "../modules/types";
import { fail, ok, type Issue, type Result } from "../shared/issues";
import { buildOrder, type OrderPayload } from "./order";
import type { WooLineItem } from "./types";

/**
 * A customer quotation: always the complete arrangement, priced only with prices WooCommerce reported
 * (Store API). There is no pricing logic here — a line WooCommerce did not price stays unpriced and
 * the quotation says so. Configured product options (decor categories, mattress, add-ons) are priced
 * by the shop's product-options plugin in the cart; the quotation shows the product's base price for
 * them and flags it (`optionsPricedInCart`).
 */
export const QUOTE_FORMAT = "multi3d-quote";
export const QUOTE_SCHEMA_VERSION = 1;
/** Temporary quotations are kept this long by the shop (orders are kept independently). */
export const QUOTE_RETENTION_DAYS = 60;

export interface ShopPriceInfo {
  readonly amount: number;
  readonly currency: string;
  readonly name?: string;
}

export interface PriceLookup {
  readonly byId: ReadonlyMap<number, ShopPriceInfo>;
  readonly bySku: ReadonlyMap<string, ShopPriceInfo>;
}

export interface QuoteLine {
  /** WooCommerce product id or SKU. */
  readonly reference: string;
  readonly name: string | null;
  readonly quantity: number;
  readonly unitPrice: number | null;
  readonly note?: string;
}

export interface QuoteModule {
  readonly moduleId: ModuleId;
  readonly typeId: string;
  /** i18n key of the product name. */
  readonly nameKey: string;
  readonly dimensions: ModuleFootprint;
  readonly summary: readonly ConfigurationSummaryRow[];
  readonly lines: readonly QuoteLine[];
  /** Sum of the line prices, or null when WooCommerce did not price every line. */
  readonly price: number | null;
  readonly optionsPricedInCart: boolean;
}

export interface QuoteDocument {
  readonly format: typeof QUOTE_FORMAT;
  readonly schemaVersion: typeof QUOTE_SCHEMA_VERSION;
  readonly number: string;
  /** ISO 8601. */
  readonly createdAt: string;
  readonly currency: string | null;
  readonly modules: readonly QuoteModule[];
  /** Sum of all module prices, or null when any price is missing. */
  readonly total: number | null;
  readonly optionsPricedInCart: boolean;
  /** The complete arrangement and order lines (same payload as the cart hand-off). */
  readonly order: OrderPayload;
}

/** "OF-20261124-7K3Q": date plus a random suffix (no personal data). */
export function quoteNumber(date: Date, random: () => number = Math.random): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const pad = (n: number) => String(n).padStart(2, "0");
  let suffix = "";
  for (let i = 0; i < 4; i++) suffix += alphabet[Math.floor(random() * alphabet.length)];
  return `OF-${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${suffix}`;
}

function priceOf(item: WooLineItem, prices: PriceLookup): ShopPriceInfo | undefined {
  return item.kind === "product-options" ? prices.byId.get(item.productId) : prices.bySku.get(item.sku);
}

const round2 = (v: number) => Math.round(v * 100) / 100;

/** Builds the quotation for the whole arrangement (the arrangement must be orderable). */
export function buildQuote(
  arrangement: Arrangement,
  prices: PriceLookup,
  { number, createdAt }: { number: string; createdAt: Date },
): Result<QuoteDocument> {
  const order = buildOrder(arrangement);
  if (!order.ok) return order;
  const issues: Issue[] = [];
  const currencies = new Set<string>();
  const modules: QuoteModule[] = order.value.modules.map((m) => {
    let price: number | null = 0;
    const lines: QuoteLine[] = m.items.map((item) => {
      const info = priceOf(item, prices);
      if (info && (!Number.isFinite(info.amount) || info.amount < 0)) {
        issues.push({ code: "quote_invalid_price", params: { reference: item.kind === "sku" ? item.sku : String(item.productId) } });
      }
      const unitPrice = info && Number.isFinite(info.amount) && info.amount >= 0 ? info.amount : null;
      if (info && unitPrice !== null) currencies.add(info.currency);
      price = price === null || unitPrice === null ? null : round2(price + unitPrice * item.quantity);
      return {
        reference: item.kind === "sku" ? item.sku : `#${item.productId}`,
        name: info?.name ?? null,
        quantity: item.quantity,
        unitPrice,
        ...(item.kind === "sku" && item.note ? { note: item.note } : {}),
      };
    });
    return {
      moduleId: m.moduleId,
      typeId: m.typeId,
      nameKey: getFurnitureType(m.typeId).nameKey,
      dimensions: m.dimensions,
      summary: m.summary,
      lines,
      price,
      optionsPricedInCart: m.items.some((i) => i.kind === "product-options"),
    };
  });
  if (currencies.size > 1) issues.push({ code: "quote_mixed_currency", params: { currencies: [...currencies].join(", ") } });
  if (issues.length > 0) return fail(...issues);
  const total = modules.every((m) => m.price !== null) ? round2(modules.reduce((sum, m) => sum + (m.price ?? 0), 0)) : null;
  return ok({
    format: QUOTE_FORMAT,
    schemaVersion: QUOTE_SCHEMA_VERSION,
    number,
    createdAt: createdAt.toISOString(),
    currency: currencies.size === 1 ? [...currencies][0] : null,
    modules,
    total,
    optionsPricedInCart: modules.some((m) => m.optionsPricedInCart),
    order: order.value,
  });
}
