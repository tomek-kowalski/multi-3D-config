"use client";

import { useEffect } from "react";
import { create } from "zustand";
import { ConfirmDialog } from "@/components/configurator/ConfirmDialog";
import { formatIssue, useLocaleStore, useT } from "@/i18n";
import { browserBff } from "@/services/bff";
import { applySnapshot, checkAvailability, openShareLink, startNewConfiguration, tokenFromPath, type AvailabilityCheck, type OpenedShare } from "@/services/sharing";
import { fetchShopPrices, shopUrl } from "@/services/woocommerce";
import { useArrangementStore } from "@/store/useArrangementStore";
import { buttonClass, primaryButtonClass } from "@/components/ui/fields";

type LoadState =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "confirm"; opened: OpenedShare }
  | { kind: "failed"; code: string }
  | { kind: "prices"; check: AvailabilityCheck | null };

/** Progress of opening a shared link (view state of this tab only). */
const useSharedLoad = create<{ state: LoadState; setState: (next: LoadState | ((s: LoadState) => LoadState)) => void }>()((set, get) => ({
  state: { kind: "idle" },
  setState: (next) => set({ state: typeof next === "function" ? next(get().state) : next }),
}));

/**
 * Opens a shared configuration (/c/{token}) in this tab:
 * 1. the token is removed from the address bar at once (not kept in history, bookmarks, analytics or
 *    referrers; a reload restores the loaded working copy from this tab's storage instead);
 * 2. the server validates the token and returns the immutable snapshot (404 unknown, 410 expired);
 * 3. unsaved changes in this tab's working configuration are only replaced after confirmation;
 * 4. the snapshot becomes a new, independent working configuration of this tab (copy-on-write);
 * 5. current WooCommerce prices and availability are checked; nothing is substituted.
 */
export function SharedLinkLoader() {
  const t = useT();
  const locale = useLocaleStore((s) => s.locale);
  const hydrated = useArrangementStore((s) => s.hydrated);
  const state = useSharedLoad((s) => s.state);
  const setState = useSharedLoad((s) => s.setState);

  const apply = (opened: OpenedShare) => {
    applySnapshot(opened.snapshot);
    useArrangementStore.getState().setNotice([{ code: "shared_loaded" }]);
    if (!shopUrl()) {
      setState({ kind: "idle" });
      return;
    }
    setState({ kind: "prices", check: null });
    const bcp47 = useLocaleStore.getState().locale === "pl" ? "pl-PL" : "en-GB";
    void checkAvailability(opened.snapshot.arrangement, (ids, skus) => fetchShopPrices(ids, skus, bcp47)).then((check) =>
      setState((s) => (s.kind === "prices" ? { kind: "prices", check } : s)),
    );
  };

  useEffect(() => {
    if (!hydrated) return;
    const token = tokenFromPath(window.location.pathname);
    if (!token && window.location.pathname.startsWith("/c/")) {
      window.history.replaceState(null, "", "/");
      setState({ kind: "failed", code: "share_not_found" });
      return;
    }
    if (!token) return;
    window.history.replaceState(null, "", "/");
    setState({ kind: "loading" });
    void openShareLink(token, browserBff).then((result) => {
      if (!result.ok) {
        setState({ kind: "failed", code: result.issues[0]?.code ?? "backend_error" });
        return;
      }
      if (useArrangementStore.getState().isDirty()) setState({ kind: "confirm", opened: result.value });
      else apply(result.value);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once, after this tab's workspace was restored
  }, [hydrated]);


  const money = (amount: number, currency: string) =>
    new Intl.NumberFormat(locale === "pl" ? "pl-PL" : "en-GB", { style: "currency", currency }).format(amount);

  return (
    <>
      {state.kind === "loading" && (
        <p role="status" data-shared-status="loading" className="absolute left-1/2 top-3 z-20 -translate-x-1/2 rounded-full bg-white/95 px-4 py-2 text-sm text-stone-700 shadow-lg">
          {t("shared.loading")}
        </p>
      )}

      {state.kind === "prices" && (
        <div role="status" data-shared-status="prices" className="absolute bottom-12 left-3 z-20 flex max-w-[min(30rem,calc(100%-1.5rem))] items-start gap-3 rounded-xl border border-stone-200 bg-white/95 px-4 py-2.5 text-xs text-stone-700 shadow-lg backdrop-blur">
          <div className="flex-1 space-y-1">
            {state.check === null && <p>{t("shared.checkingPrices")}</p>}
            {state.check?.status === "error" && <p className="text-amber-800">{t("shared.pricesUnavailable")}</p>}
            {state.check?.status === "ok" && state.check.unavailable.length > 0 && (
              <p className="font-medium text-red-700" data-shared-unavailable>
                {t("shared.unavailable", { items: state.check.unavailable.join(", ") })}
              </p>
            )}
            {state.check?.status === "ok" && state.check.total !== null && state.check.currency && (
              <p data-shared-total>{t("shared.pricesCurrent", { total: money(state.check.total, state.check.currency) })}</p>
            )}
            {state.check?.status === "ok" && state.check.total === null && state.check.unavailable.length === 0 && <p>{t("shared.pricesPartial")}</p>}
          </div>
          <button type="button" className="text-stone-500 hover:text-stone-800" onClick={() => setState({ kind: "idle" })} aria-label={t("shared.dismiss")}>
            ✕
          </button>
        </div>
      )}

      {state.kind === "failed" && (
        <div role="alertdialog" aria-labelledby="shared-failed-title" data-shared-status={state.code} className="fixed inset-0 z-50 flex items-center justify-center bg-stone-900/40 p-4">
          <div className="w-[min(26rem,100%)] space-y-3 rounded-xl border border-stone-200 bg-white p-5 shadow-xl">
            <h2 id="shared-failed-title" className="text-base font-semibold text-stone-900">
              {state.code === "share_expired" ? t("shared.expiredTitle") : state.code === "share_not_found" ? t("shared.invalidTitle") : t("shared.errorTitle")}
            </h2>
            <p className="text-sm text-stone-600">
              {state.code === "share_expired"
                ? t("shared.expired")
                : state.code === "share_not_found"
                  ? t("shared.invalid")
                  : formatIssue(t, { code: state.code })}
            </p>
            <div className="flex justify-end gap-2 pt-2">
              <button type="button" className={buttonClass} onClick={() => setState({ kind: "idle" })}>
                {t("common.close")}
              </button>
              <button
                type="button"
                className={primaryButtonClass}
                onClick={() => {
                  startNewConfiguration();
                  setState({ kind: "idle" });
                }}
              >
                {t("shared.newConfiguration")}
              </button>
            </div>
          </div>
        </div>
      )}

      <ConfirmDialog
        open={state.kind === "confirm"}
        title={t("shared.replaceTitle")}
        confirmLabel={t("shared.replaceConfirm")}
        cancelLabel={t("shared.keepCurrent")}
        onConfirm={() => state.kind === "confirm" && apply(state.opened)}
        onCancel={() => setState({ kind: "idle" })}
      >
        {t("shared.replaceBody")}
      </ConfirmDialog>
    </>
  );
}
