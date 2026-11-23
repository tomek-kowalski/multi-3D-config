"use client";

import { useId, useRef, useState } from "react";
import type { PhotoProgress } from "@/components/three/photo/photoEngine";
import { getPhotoRenderer } from "@/components/three/photo/photoService";
import { quoteCapture } from "@/components/three/photo/quoteCapture";
import type { Issue } from "@/domain/shared/issues";
import { isMessageKey, useLocaleStore, useT } from "@/i18n";
import { loadPdfFonts } from "@/services/quotePdf";
import {
  downloadPdf,
  emailQuotation,
  isValidEmail,
  prepareQuotation,
  saveQuotation,
  type PreparedQuotation,
  type QuotationDeps,
  type QuoteBackend,
  type RenderingCount,
} from "@/services/quotation";
import { fetchShopPrices, shopUrl } from "@/services/woocommerce";
import { useArrangementStore } from "@/store/useArrangementStore";
import { buttonClass, IssueList, primaryButtonClass, Segmented } from "@/components/ui/fields";

type Status =
  | { kind: "idle" }
  | { kind: "busy"; message: string; progress?: PhotoProgress; cancel?: () => void }
  | { kind: "done"; message: string } | { kind: "error"; issues: readonly Issue[] };

/** Builds the pipeline dependencies from the live app (store, shop, 3D view, fonts). */
export function useQuotationDeps(): () => QuotationDeps {
  const t = useT();
  const locale = useLocaleStore((s) => s.locale);
  return () => {
    const shop = shopUrl();
    const bcp47 = locale === "pl" ? "pl-PL" : "en-GB";
    return {
      arrangement: useArrangementStore.getState().arrangement,
      fetchPrices: shop ? (ids, skus) => fetchShopPrices(ids, skus, bcp47) : null,
      capture: (() => {
        const renderer = getPhotoRenderer();
        return renderer ? quoteCapture(renderer) : null;
      })(),
      loadFonts: loadPdfFonts,
      t: (key, params) => (isMessageKey(key) ? t(key, params) : key),
      locale: bcp47,
    };
  };
}

function backend(): QuoteBackend | null {
  const base = shopUrl();
  return base ? { baseUrl: base, fetch: (...args) => fetch(...args) } : null;
}

/**
 * "Drukuj ofertę": a quotation of the complete arrangement as PDF — saved on the computer or sent by
 * e-mail through the shop. Both use the same prepared quotation (same renderings, same PDF).
 */
export function QuotePanel() {
  const t = useT();
  const deps = useQuotationDeps();
  const moduleCount = useArrangementStore((s) => s.arrangement.modules.length);
  const [count, setCount] = useState<RenderingCount>(1);
  const [status, setStatus] = useState<Status>({ kind: "idle" });
  const [emailOpen, setEmailOpen] = useState(false);
  const [email, setEmail] = useState("");
  const [emailError, setEmailError] = useState(false);
  const emailId = useId();
  const shop = backend();
  const busy = status.kind === "busy";

  const controller = useRef<AbortController | null>(null);

  const prepare = async (): Promise<PreparedQuotation | null> => {
    const abort = new AbortController();
    controller.current = abort;
    const cancel = () => abort.abort();
    setStatus({ kind: "busy", message: t("quote.preparing", { count }), cancel });
    const result = await prepareQuotation(count, {
      ...deps(),
      captureOptions: {
        signal: abort.signal,
        onProgress: (progress) => setStatus({ kind: "busy", message: t("quote.rendering", { n: progress.view + 1, count: progress.views }), progress, cancel }),
      },
    });
    controller.current = null;
    if (!result.ok) {
      setStatus({ kind: "error", issues: result.issues });
      return null;
    }
    return result.value;
  };

  const download = async () => {
    const prepared = await prepare();
    if (!prepared) return;
    downloadPdf(prepared);
    // Storing the quotation (60-day retention) must not block the download.
    const stored = shop ? await saveQuotation(prepared, shop) : null;
    setStatus({
      kind: "done",
      message:
        stored && !stored.ok
          ? t("quote.savedLocallyOnly", { number: prepared.quote.number })
          : t("quote.downloaded", { number: prepared.quote.number }),
    });
  };

  const send = async () => {
    if (!isValidEmail(email)) {
      setEmailError(true);
      return;
    }
    setEmailError(false);
    if (!shop) return;
    const prepared = await prepare();
    if (!prepared) return;
    setStatus({ kind: "busy", message: t("quote.sending") });
    const result = await emailQuotation(prepared, email, shop);
    setStatus(result.ok ? { kind: "done", message: t("quote.sent", { email: email.trim(), number: prepared.quote.number }) } : { kind: "error", issues: result.issues });
  };

  return (
    <div className="space-y-5" data-quote-panel>
      <p className="text-sm text-stone-600">{t("quote.intro", { count: moduleCount })}</p>
      <Segmented
        label={t("quote.renderings")}
        value={String(count)}
        options={[1, 2, 3].map((n) => ({ value: String(n), label: t("quote.renderingsN", { count: n }) }))}
        onChange={(v) => setCount(Number(v) as RenderingCount)}
      />
      <div className="grid gap-2 sm:grid-cols-2">
        <button type="button" className={primaryButtonClass} disabled={busy || moduleCount === 0} onClick={() => void download()}>
          {t("quote.downloadPdf")}
        </button>
        <button
          type="button"
          className={buttonClass}
          disabled={busy || moduleCount === 0}
          aria-expanded={emailOpen}
          onClick={() => setEmailOpen((open) => !open)}
        >
          {t("quote.sendEmail")}
        </button>
      </div>

      {emailOpen && (
        <form
          className="space-y-2 rounded-xl border border-stone-200 p-3"
          onSubmit={(e) => {
            e.preventDefault();
            void send();
          }}
          noValidate
        >
          {!shop && <p className="text-xs text-amber-800">{t("quote.emailNoShop")}</p>}
          <label htmlFor={emailId} className="text-sm font-medium text-stone-800">
            {t("quote.emailLabel")}
          </label>
          <div className="flex gap-2">
            <input
              id={emailId}
              type="email"
              autoComplete="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              aria-invalid={emailError}
              className={`w-full rounded-lg border px-3 py-2 text-sm ${emailError ? "border-red-400" : "border-stone-300"}`}
            />
            <button type="submit" className={primaryButtonClass} disabled={busy || !shop}>
              {t("quote.send")}
            </button>
          </div>
          {emailError && (
            <p role="alert" className="text-xs text-red-700">
              {t("issue.quote_invalid_email")}
            </p>
          )}
        </form>
      )}

      {status.kind === "busy" && (
        <div className="space-y-2">
          <p role="status" className="text-sm text-stone-600">
            {status.message}
            {status.progress && ` ${Math.round(status.progress.fraction * 100)}%`}
          </p>
          {status.progress && (
            <progress className="h-2 w-full" max={1} value={status.progress.fraction} aria-label={t("photo.progress")} />
          )}
          {status.cancel && status.progress && (
            <button type="button" className={buttonClass} onClick={status.cancel}>
              {t("photo.cancel")}
            </button>
          )}
        </div>
      )}
      {status.kind === "done" && (
        <p role="status" className="rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800">
          {status.message}
        </p>
      )}
      {status.kind === "error" && <IssueList issues={status.issues} />}
      <p className="text-xs text-stone-500">{t("quote.note")}</p>
    </div>
  );
}
