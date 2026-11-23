"use client";

import { useEffect } from "react";
import { create } from "zustand";
import type { Issue } from "@/domain/shared/issues";
import { en } from "./messages/en";
import { pl, type MessageKey } from "./messages/pl";

/**
 * Localization. Polish is the default; English is selectable. Every user-facing string of the
 * configurator comes from the message catalogs in ./messages (pl.ts is the reference catalog and
 * defines the keys; en.ts must provide every key — the type checker enforces it). A new language is
 * one more catalog plus an entry in LOCALES.
 */
export const LOCALES = ["pl", "en"] as const;
export type Locale = (typeof LOCALES)[number];
export const DEFAULT_LOCALE: Locale = "pl";

const CATALOGS: Readonly<Record<Locale, Readonly<Record<MessageKey, string>>>> = { pl, en };

export type MessageParams = Readonly<Record<string, string | number>>;

const STORAGE_KEY = "multi3d.locale";

export function isMessageKey(key: string): key is MessageKey {
  return key in pl;
}

/** `{name}` placeholders are replaced by params; numbers are formatted for the locale. */
export function translate(locale: Locale, key: MessageKey, params?: MessageParams): string {
  const template = CATALOGS[locale][key] ?? pl[key] ?? key;
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (match, name: string) => {
    const value = params[name];
    if (value === undefined) return match;
    return typeof value === "number" ? new Intl.NumberFormat(locale === "pl" ? "pl-PL" : "en-GB", { useGrouping: false, maximumFractionDigits: 1 }).format(value) : value;
  });
}

interface LocaleState {
  readonly locale: Locale;
  setLocale: (locale: Locale) => void;
}

export const useLocaleStore = create<LocaleState>()((set) => ({
  locale: DEFAULT_LOCALE,
  setLocale: (locale) => {
    set({ locale });
    try {
      window.localStorage.setItem(STORAGE_KEY, locale);
    } catch {
      // Storage may be unavailable (private mode); the choice then lasts for the session only.
    }
  },
}));

/** Restores the saved language after hydration and keeps <html lang> in sync. */
export function useLocaleSync() {
  const locale = useLocaleStore((s) => s.locale);
  useEffect(() => {
    try {
      const saved = window.localStorage.getItem(STORAGE_KEY);
      if (saved && (LOCALES as readonly string[]).includes(saved)) useLocaleStore.setState({ locale: saved as Locale });
    } catch {
      // ignore
    }
  }, []);
  useEffect(() => {
    document.documentElement.lang = locale;
  }, [locale]);
}

export type Translate = (key: MessageKey, params?: MessageParams) => string;

export function useT(): Translate {
  const locale = useLocaleStore((s) => s.locale);
  return (key, params) => translate(locale, key, params);
}

/** Localized text for a domain issue: `issue.<code>` from the catalog, falling back to a generic message. */
export function formatIssue(t: Translate, issue: Issue): string {
  const key = `issue.${issue.code}`;
  const params = { ...issue.params } as Record<string, string | number>;
  if (isMessageKey(key)) return t(key, params);
  // Cabinet validation codes come with the cabinet's own detailed Polish message.
  if (issue.code.startsWith("cabinet.") && typeof params.message === "string") {
    const cabinetKey = `cabinetIssue.${issue.code.slice("cabinet.".length)}`;
    if (useLocaleStore.getState().locale === "pl") return params.message;
    if (isMessageKey(cabinetKey)) return t(cabinetKey, params);
  }
  return t("issue.generic", { code: issue.code });
}

/**
 * Display value of a configuration summary row: material ids (cabinet finishes) are shown with their
 * localized names; everything else is product data shown as is.
 */
export function summaryValue(t: (key: string, params?: MessageParams) => string, row: { labelKey: string; value: string }): string {
  if (row.labelKey === "summary.bodyMaterial") {
    const key = `material.${row.value}`;
    if (isMessageKey(key)) return t(key);
  }
  return row.value;
}
