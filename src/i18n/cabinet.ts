"use client";

import { getNumericFieldRange } from "@/domain/furniture/fields";
import type { NumericField } from "@/domain/furniture/types";
import { isMessageKey, useLocaleStore, useT } from "./index";

/** An error as produced by the existing cabinet domain: a stable code plus a detailed Polish message. */
export interface CabinetMessage {
  readonly code?: string;
  readonly message: string;
  readonly field?: string;
}

const NUMERIC_FIELDS = new Set(["width", "height", "depth", "panelThickness", "backPanel.thickness", "plinth.height", "plinth.setback"]);

/**
 * Localizes cabinet domain errors. The cabinet domain (reused unchanged from kitchen-config) writes
 * detailed Polish messages; in Polish they are shown as they are, in other languages the stable
 * error code is translated (`cabinetIssue.<code>`), with the field name and its range when known.
 */
export function useCabinetText(): (error: CabinetMessage) => string {
  const t = useT();
  const locale = useLocaleStore((s) => s.locale);
  return (error) => {
    if (locale === "pl" || !error.code) return locale === "pl" ? error.message : t("cabinetIssue.generic");
    const key = `cabinetIssue.${error.code}`;
    const params: Record<string, string | number> = {};
    if (error.field && NUMERIC_FIELDS.has(error.field)) {
      const fieldKey = `cabinetField.${error.field}`;
      params.field = isMessageKey(fieldKey) ? t(fieldKey) : error.field;
      const range = getNumericFieldRange(error.field as NumericField);
      params.min = range.min;
      params.max = range.max;
    } else {
      params.field = error.field ?? "";
    }
    return isMessageKey(key) ? t(key, params) : t("cabinetIssue.generic");
  };
}
