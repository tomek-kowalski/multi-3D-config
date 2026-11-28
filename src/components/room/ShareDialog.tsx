"use client";

import { useEffect, useId, useRef, useState } from "react";
import type { Issue } from "@/domain/shared/issues";
import { useLocaleStore, useT } from "@/i18n";
import { browserBff } from "@/services/bff";
import { captureSnapshot, createShareLink, emailShareLink, SHARE_RETENTION_DAYS, type ShareLink } from "@/services/sharing";
import { useArrangementStore } from "@/store/useArrangementStore";
import { buttonClass, IssueList, primaryButtonClass } from "@/components/ui/fields";

type LinkState = { kind: "creating" } | { kind: "ready"; link: ShareLink } | { kind: "error"; issues: readonly Issue[] };
type Notice = { kind: "ok" | "error"; text: string } | null;

/**
 * "Udostępnij konfigurację": saves an immutable snapshot of the current configuration and shows its link
 * with "Kopiuj link", "Wyślij link e-mailem" and "Zamknij". The same unchanged arrangement keeps its link,
 * and e-mail retries reuse it (never a new snapshot per e-mail).
 */
export function ShareDialog({ onClose }: { onClose: () => void }) {
  const t = useT();
  const locale = useLocaleStore((s) => s.locale);
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const urlId = useId();
  const emailId = useId();
  const [state, setState] = useState<LinkState>({ kind: "creating" });
  const [notice, setNotice] = useState<Notice>(null);
  const [emailOpen, setEmailOpen] = useState(false);
  const [email, setEmail] = useState("");
  const [sending, setSending] = useState(false);
  const [emailIssues, setEmailIssues] = useState<readonly Issue[]>([]);

  /** The server's answer to storing the snapshot (or the reused link of an unchanged arrangement). */
  const answered = (result: Awaited<ReturnType<typeof createShareLink>>) => {
    if (!result.ok) {
      setState({ kind: "error", issues: result.issues });
      return;
    }
    useArrangementStore.getState().markClean();
    setState({ kind: "ready", link: result.value });
  };

  const retry = () => {
    setState({ kind: "creating" });
    setNotice(null);
    void createShareLink(captureSnapshot(), browserBff).then(answered);
  };

  useEffect(() => {
    const dialog = ref.current;
    if (dialog && !dialog.open) dialog.showModal();
    void createShareLink(captureSnapshot(), browserBff).then(answered);
  }, []);

  const copy = async (link: ShareLink) => {
    try {
      await navigator.clipboard.writeText(link.url);
      setNotice({ kind: "ok", text: t("share.copied") });
    } catch {
      setNotice({ kind: "error", text: t("share.copyFailed") });
    }
  };

  const send = async (link: ShareLink) => {
    setSending(true);
    setEmailIssues([]);
    setNotice(null);
    const result = await emailShareLink(link, email, locale, browserBff);
    setSending(false);
    if (result.ok) setNotice({ kind: "ok", text: t("share.sent", { email: email.trim() }) });
    else setEmailIssues(result.issues);
  };

  const until = state.kind === "ready" ? new Intl.DateTimeFormat(locale === "pl" ? "pl-PL" : "en-GB", { dateStyle: "long" }).format(new Date(state.link.expiresAt)) : "";

  return (
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      data-share-dialog
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      className="m-auto w-[min(32rem,calc(100vw-2rem))] rounded-xl border border-stone-200 bg-white p-0 text-stone-900 shadow-xl backdrop:bg-stone-900/40"
    >
      <div className="space-y-4 p-5">
        <h2 id={titleId} className="text-base font-semibold">
          {t("share.title")}
        </h2>

        {state.kind === "creating" && (
          <p role="status" className="text-sm text-stone-600">
            {t("share.creating")}
          </p>
        )}
        {state.kind === "error" && (
          <div className="space-y-2">
            <IssueList issues={state.issues} />
            <button type="button" className={buttonClass} onClick={retry}>
              {t("share.retry")}
            </button>
          </div>
        )}
        {state.kind === "ready" && (
          <>
            <p role="status" className="text-sm text-emerald-800">
              {t("share.saved")}
            </p>
            <div className="space-y-1">
              <label htmlFor={urlId} className="text-sm font-medium text-stone-800">
                {t("share.urlLabel")}
              </label>
              <input
                id={urlId}
                readOnly
                value={state.link.url}
                data-share-url
                onFocus={(e) => e.currentTarget.select()}
                className="w-full rounded-lg border border-stone-300 bg-stone-50 px-3 py-2 font-mono text-xs"
              />
            </div>
            <div className="grid gap-2 sm:grid-cols-2">
              <button type="button" className={primaryButtonClass} onClick={() => void copy(state.link)}>
                {t("share.copy")}
              </button>
              <button type="button" className={buttonClass} aria-expanded={emailOpen} onClick={() => setEmailOpen((o) => !o)}>
                {t("share.email")}
              </button>
            </div>
            {emailOpen && (
              <form
                className="space-y-2 rounded-xl border border-stone-200 p-3"
                noValidate
                onSubmit={(e) => {
                  e.preventDefault();
                  void send(state.link);
                }}
              >
                <label htmlFor={emailId} className="text-sm font-medium text-stone-800">
                  {t("share.emailLabel")}
                </label>
                <div className="flex gap-2">
                  <input
                    id={emailId}
                    type="email"
                    autoComplete="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    aria-invalid={emailIssues.some((i) => i.code === "invalid_email")}
                    className="w-full rounded-lg border border-stone-300 px-3 py-2 text-sm"
                  />
                  <button type="submit" className={primaryButtonClass} disabled={sending}>
                    {sending ? t("share.sending") : t("share.send")}
                  </button>
                </div>
                <IssueList issues={emailIssues} />
              </form>
            )}
            {notice && (
              <p
                role={notice.kind === "ok" ? "status" : "alert"}
                className={`rounded-lg px-3 py-2 text-sm ${notice.kind === "ok" ? "border border-emerald-200 bg-emerald-50 text-emerald-800" : "border border-red-200 bg-red-50 text-red-700"}`}
              >
                {notice.text}
              </p>
            )}
            <ul className="list-disc space-y-1 pl-4 text-xs text-stone-600">
              <li>{t("share.availability", { days: SHARE_RETENTION_DAYS, date: until })}</li>
              <li>{t("share.copyOnWrite")}</li>
              <li>{t("share.notPrice")}</li>
            </ul>
          </>
        )}
      </div>
      <div className="flex justify-end border-t border-stone-200 px-5 py-3">
        <button type="button" className={buttonClass} onClick={onClose} autoFocus>
          {t("common.close")}
        </button>
      </div>
    </dialog>
  );
}
