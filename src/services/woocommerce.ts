import type { OrderPayload } from "@/domain/commerce/order";

/**
 * Connection to the WooCommerce shop (WordPress). WooCommerce is the only source of product data and
 * prices: the configurator reads them through the public Store API and hands orders to the companion
 * plugin (wordpress/multi3d-configurator), which adds the lines to the customer's cart.
 *
 * Configure with NEXT_PUBLIC_WOOCOMMERCE_URL (e.g. https://clickbed.pl). Without it, the configurator
 * still works and can export the order configuration as JSON.
 */
export function shopUrl(): string | null {
  const url = process.env.NEXT_PUBLIC_WOOCOMMERCE_URL;
  return url ? url.replace(/\/+$/, "") : null;
}

/** A product's price as WooCommerce reports it (Store API, minor units). */
export interface ShopPrice {
  readonly name: string;
  readonly permalink: string;
  /** Formatted for display, e.g. "10 390,00 zł". */
  readonly display: string;
  readonly amount: number;
  readonly currency: string;
  readonly inStock: boolean;
}

interface StoreApiProduct {
  id: number;
  name: string;
  sku: string;
  permalink: string;
  is_in_stock: boolean;
  prices: { price: string; currency_code: string; currency_minor_unit: number; currency_prefix: string; currency_suffix: string };
}

function toShopPrice(p: StoreApiProduct, locale: string): ShopPrice {
  const amount = Number(p.prices.price) / 10 ** p.prices.currency_minor_unit;
  return {
    name: p.name,
    permalink: p.permalink,
    amount,
    currency: p.prices.currency_code,
    inStock: p.is_in_stock,
    display: new Intl.NumberFormat(locale, { style: "currency", currency: p.prices.currency_code }).format(amount),
  };
}

/**
 * Base prices of the given products (by WooCommerce id) and SKUs (cabinet components). Options of
 * configured products are priced by the shop when the configuration is added to the cart.
 */
export async function fetchShopPrices(
  productIds: readonly number[],
  skus: readonly string[],
  locale: string,
  signal?: AbortSignal,
): Promise<{ byId: Map<number, ShopPrice>; bySku: Map<string, ShopPrice> }> {
  const base = shopUrl();
  const byId = new Map<number, ShopPrice>();
  const bySku = new Map<string, ShopPrice>();
  if (!base) return { byId, bySku };
  const get = async (query: string) => {
    const response = await fetch(`${base}/wp-json/wc/store/v1/products?${query}`, { signal, credentials: "omit" });
    if (!response.ok) throw new Error(`Store API ${response.status}`);
    return (await response.json()) as StoreApiProduct[];
  };
  if (productIds.length > 0) {
    for (const p of await get(`include=${productIds.join(",")}&per_page=100`)) byId.set(p.id, toShopPrice(p, locale));
  }
  // Variations are only listed with type=variation; query both and match by SKU.
  for (let i = 0; i < skus.length; i += 50) {
    const chunk = skus.slice(i, i + 50).map(encodeURIComponent).join(",");
    for (const query of [`sku=${chunk}&per_page=100`, `sku=${chunk}&type=variation&per_page=100`]) {
      for (const p of await get(query)) if (p.sku) bySku.set(p.sku, toShopPrice(p, locale));
    }
  }
  return { byId, bySku };
}

/** Name of the form field the plugin reads. */
export const ORDER_FIELD = "multi3d_order";

/**
 * Sends the order to the shop as a regular form submission (top-level navigation), so the cart is
 * created in the customer's own shop session; the plugin then redirects to the cart. `accepted` holds
 * the shop's terms fields the customer ticked (field name → value).
 */
export function submitOrderToShop(payload: OrderPayload, accepted: Readonly<Record<string, string>>, quoteNumber?: string): boolean {
  const base = shopUrl();
  if (!base) return false;
  const form = document.createElement("form");
  form.method = "POST";
  form.action = `${base}/?multi3d-cart=1`;
  form.style.display = "none";
  const field = (name: string, value: string) => {
    const input = document.createElement("input");
    input.type = "hidden";
    input.name = name;
    input.value = value;
    form.appendChild(input);
  };
  field(ORDER_FIELD, JSON.stringify({ ...payload, acceptedTerms: accepted, ...(quoteNumber ? { quoteNumber } : {}) }));
  document.body.appendChild(form);
  form.submit();
  return true;
}

export function downloadJson(json: string, fileName: string) {
  const url = URL.createObjectURL(new Blob([json], { type: "application/json" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  link.click();
  URL.revokeObjectURL(url);
}
