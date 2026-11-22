"use client";

import { useEffect, useMemo, useState } from "react";
import { detectCollisions } from "@/domain/arrangement/collisions";
import { buildOrder, type OrderPayload } from "@/domain/commerce/order";
import { isMessageKey, useLocaleStore, useT } from "@/i18n";
import { downloadJson, fetchShopPrices, shopUrl, submitOrderToShop, type ShopPrice } from "@/services/woocommerce";
import { useArrangementStore } from "@/store/useArrangementStore";
import { buttonClass, IssueList, primaryButtonClass, Segmented } from "@/components/ui/fields";
import { describeCollision, typeName } from "./ArrangementPanel";

type PriceState =
  | { status: "idle" | "loading" }
  | { status: "ready"; byId: Map<number, ShopPrice>; bySku: Map<string, ShopPrice> }
  | { status: "error" };

function usePrices(order: OrderPayload | null): PriceState {
  const locale = useLocaleStore((s) => s.locale);
  // The request key: the ordered product ids and SKUs, plus the display locale.
  const { ids, skus } = useMemo(() => {
    const productIds = new Set<number>();
    const skuSet = new Set<string>();
    for (const m of order?.modules ?? [])
      for (const i of m.items) {
        if (i.kind === "product-options") productIds.add(i.productId);
        else skuSet.add(i.sku);
      }
    return { ids: [...productIds].sort((a, b) => a - b), skus: [...skuSet].sort() };
  }, [order]);
  const key = `${locale}|${ids.join(",")}|${skus.join(",")}`;
  const [result, setResult] = useState<{ key: string; state: PriceState } | null>(null);
  const active = order !== null && shopUrl() !== null;
  useEffect(() => {
    if (!active) return;
    const controller = new AbortController();
    fetchShopPrices(ids, skus, locale === "pl" ? "pl-PL" : "en-GB", controller.signal)
      .then((r) => setResult({ key, state: { status: "ready", ...r } }))
      .catch(() => {
        if (!controller.signal.aborted) setResult({ key, state: { status: "error" } });
      });
    return () => controller.abort();
  }, [active, key, ids, skus, locale]);
  if (!active) return { status: "idle" };
  return result?.key === key ? result.state : { status: "loading" };
}

/**
 * Order review: the whole arrangement or chosen modules, their WooCommerce lines and shop prices, the
 * shop's own terms acceptance, then the hand-off to the WooCommerce cart (or a JSON export).
 */
export function OrderDialog({ onClose }: { onClose: () => void }) {
  const t = useT();
  const arrangement = useArrangementStore((s) => s.arrangement);
  const selectedId = useArrangementStore((s) => s.selectedModuleId);
  const [scope, setScope] = useState<"all" | "selected">(selectedId ? "selected" : "all");
  const [accepted, setAccepted] = useState<Record<string, string>>({});
  const ids = useMemo(() => (scope === "selected" && selectedId ? [selectedId] : undefined), [scope, selectedId]);
  const result = useMemo(() => buildOrder(arrangement, ids), [arrangement, ids]);
  const order = result.ok ? result.value : null;
  const prices = usePrices(order);
  const collisions = useMemo(
    () => detectCollisions(arrangement).filter((c) => !ids || ids.includes(c.moduleId) || (c.kind === "module" && ids.includes(c.otherId))),
    [arrangement, ids],
  );
  const termsRequired = useMemo(() => {
    const map = new Map<string, { field: string; value: string; label: string }>();
    for (const m of order?.modules ?? [])
      for (const i of m.items)
        if (i.kind === "product-options" && i.termsField && i.termsValue)
          map.set(`${i.productId}`, { field: `${i.productId}:${i.termsField}`, value: i.termsValue, label: i.termsValue.replace(/_\d+$/, "") });
    return [...map.values()];
  }, [order]);
  const allAccepted = termsRequired.every((r) => accepted[r.field] === r.value);
  const shop = shopUrl();

  const price = (moduleItems: OrderPayload["modules"][number]["items"]) => {
    if (prices.status !== "ready") return null;
    let total = 0;
    let currency = "";
    for (const item of moduleItems) {
      const p = item.kind === "product-options" ? prices.byId.get(item.productId) : prices.bySku.get(item.sku);
      if (!p) return null;
      total += p.amount * item.quantity;
      currency = p.currency;
    }
    return new Intl.NumberFormat(useLocaleStore.getState().locale === "pl" ? "pl-PL" : "en-GB", { style: "currency", currency }).format(total);
  };

  return (
    <div role="dialog" aria-modal="true" aria-labelledby="order-title" className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 p-0 sm:items-center sm:p-6" onClick={onClose}>
      <div className="flex max-h-[92dvh] w-full max-w-2xl flex-col rounded-t-2xl bg-white shadow-xl sm:rounded-2xl" onClick={(e) => e.stopPropagation()}>
        <header className="flex items-center justify-between border-b border-stone-200 px-6 py-4">
          <h2 id="order-title" className="text-lg font-semibold text-stone-900">
            {t("order.title")}
          </h2>
          <button type="button" onClick={onClose} className="rounded-lg px-2 py-1 text-stone-500 hover:bg-stone-100" aria-label={t("common.close")}>
            ✕
          </button>
        </header>

        <div className="flex-1 space-y-5 overflow-y-auto px-6 py-5">
          <Segmented
            label={t("order.scope")}
            value={scope}
            options={[
              { value: "all", label: t("order.scopeAll", { count: arrangement.modules.length }) },
              ...(selectedId ? [{ value: "selected" as const, label: t("order.scopeSelected", { id: selectedId }) }] : []),
            ]}
            onChange={setScope}
          />

          {!result.ok && <IssueList issues={result.issues} />}

          {collisions.length > 0 && (
            <div role="status" className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900">
              <p className="font-semibold">{t("order.collisionsWarning")}</p>
              <ul className="mt-1 list-disc pl-4">
                {collisions.map((c, i) => (
                  <li key={i}>{describeCollision(t, c, arrangement.modules)}</li>
                ))}
              </ul>
            </div>
          )}

          {order?.modules.map((m) => (
            <article key={m.moduleId} className="rounded-xl border border-stone-200 p-4">
              <div className="flex items-baseline justify-between gap-3">
                <h3 className="text-sm font-semibold text-stone-900">
                  {typeName(t, m.typeId)} <span className="font-normal text-stone-500">· {m.moduleId}</span>
                </h3>
                <span className="text-sm font-semibold tabular-nums text-stone-900">
                  {price(m.items) ?? (shop ? (prices.status === "loading" ? t("order.priceLoading") : t("order.priceInCart")) : "")}
                </span>
              </div>
              <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-4 gap-y-0.5 text-xs">
                {m.summary.map((row) => (
                  <div key={row.labelKey} className="contents">
                    <dt className="text-stone-500">{isMessageKey(row.labelKey) ? t(row.labelKey) : row.labelKey}</dt>
                    <dd className="text-stone-800">{row.value}</dd>
                  </div>
                ))}
              </dl>
              <details className="mt-2 text-xs text-stone-600">
                <summary className="cursor-pointer text-stone-500">{t("order.lines", { count: m.items.length })}</summary>
                <ul className="mt-1 space-y-0.5 font-mono text-[11px]">
                  {m.items.map((item, i) => (
                    <li key={i}>
                      {item.kind === "sku" ? `${item.quantity} × ${item.sku}${item.note ? `  (${item.note})` : ""}` : `${item.quantity} × #${item.productId} (${Object.keys(item.fields).length} ${t("order.options")})`}
                    </li>
                  ))}
                </ul>
              </details>
            </article>
          ))}

          {order && termsRequired.length > 0 && (
            <fieldset className="space-y-2">
              <legend className="text-sm font-medium text-stone-800">{t("order.terms")}</legend>
              {termsRequired.map((r) => (
                <label key={r.field} className="flex items-start gap-2 text-sm text-stone-700">
                  <input
                    type="checkbox"
                    className="mt-0.5 size-4 accent-stone-900"
                    checked={accepted[r.field] === r.value}
                    onChange={(e) => setAccepted((a) => ({ ...a, [r.field]: e.target.checked ? r.value : "" }))}
                  />
                  <span>{r.label}</span>
                </label>
              ))}
            </fieldset>
          )}

          <p className="text-xs text-stone-500">{shop ? t("order.priceNote") : t("order.noShop")}</p>
          {prices.status === "error" && <p className="text-xs text-red-700">{t("order.priceError")}</p>}
        </div>

        <footer className="flex flex-wrap justify-end gap-2 border-t border-stone-200 px-6 py-4">
          <button type="button" className={buttonClass} disabled={!order} onClick={() => order && downloadJson(JSON.stringify(order, null, 2), "zamowienie-konfiguracja.json")}>
            {t("order.downloadJson")}
          </button>
          <button
            type="button"
            className={primaryButtonClass}
            disabled={!order || !shop || !allAccepted}
            onClick={() => order && submitOrderToShop(order, accepted)}
          >
            {t("order.toCart")}
          </button>
        </footer>
      </div>
    </div>
  );
}
