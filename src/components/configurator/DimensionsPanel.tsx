"use client";

import type { CabinetDimensionKey } from "@/domain/furniture/types";
import { useConfiguratorStore } from "@/store/useConfiguratorStore";
import { useT } from "@/i18n";
import { NumericFieldControl } from "./DimensionField";
import { SectionHeading } from "./SectionHeading";

const FIELDS: readonly { key: CabinetDimensionKey; sliderStep: number }[] = [
  { key: "width", sliderStep: 10 },
  { key: "height", sliderStep: 10 },
  { key: "depth", sliderStep: 10 },
  { key: "panelThickness", sliderStep: 1 },
];

export function DimensionsPanel() {
  const t = useT();
  const hasPendingInputs = useConfiguratorStore((state) => Object.keys(state.pendingInputs).length > 0);

  return (
    <section aria-labelledby="dimensions-heading" className="space-y-5">
      <SectionHeading id="dimensions-heading">{t("cab.dimensions")}</SectionHeading>

      {hasPendingInputs && (
        <p role="status" className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
          {t("cab.pendingNotice")}
        </p>
      )}

      {FIELDS.map(({ key, sliderStep }) => (
        <NumericFieldControl key={key} field={key} label={t(`cabinetField.${key}`)} sliderStep={sliderStep} />
      ))}
    </section>
  );
}
