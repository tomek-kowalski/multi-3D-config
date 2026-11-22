"use client";

import type { ReactNode } from "react";
import { useConfiguratorStore, type RejectionSource } from "@/store/useConfiguratorStore";
import { NumericFieldControl } from "./DimensionField";
import { useT } from "@/i18n";
import { ErrorList, SectionHeading } from "./SectionHeading";

interface ComponentToggleProps {
  id: string;
  label: string;
  description: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  source: RejectionSource;
  children: ReactNode;
}

function ComponentToggle({ id, label, description, checked, onChange, source, children }: ComponentToggleProps) {
  const rejection = useConfiguratorStore((state) => (state.rejection?.source === source ? state.rejection : null));

  return (
    <div
      className={`space-y-4 rounded-lg border-2 p-3 transition-colors ${checked ? "border-blue-600 bg-blue-50/40" : "border-stone-200"}`}
    >
      <label htmlFor={id} className="flex cursor-pointer items-start justify-between gap-4">
        <span>
          <span className="block text-sm font-medium text-stone-800">{label}</span>
          <span className="block text-xs text-stone-500">{description}</span>
        </span>
        <input
          id={id}
          type="checkbox"
          role="switch"
          checked={checked}
          onChange={(event) => onChange(event.target.checked)}
          className="mt-0.5 size-5 shrink-0 cursor-pointer accent-blue-600 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-stone-900"
        />
      </label>
      {checked && children}
      {rejection && <ErrorList errors={rejection.errors} />}
    </div>
  );
}

export function ConstructionPanel() {
  const t = useT();
  const backPanelEnabled = useConfiguratorStore((state) => state.configuration.backPanel.enabled);
  const plinthEnabled = useConfiguratorStore((state) => state.configuration.plinth.enabled);
  const setBackPanelEnabled = useConfiguratorStore((state) => state.setBackPanelEnabled);
  const setPlinthEnabled = useConfiguratorStore((state) => state.setPlinthEnabled);

  return (
    <section aria-labelledby="construction-heading" className="space-y-4">
      <SectionHeading id="construction-heading">{t("cab.construction")}</SectionHeading>

      <ComponentToggle
        id="toggle-back-panel"
        label={t("cab.backPanel")}
        description={t("cab.backPanelDescription")}
        checked={backPanelEnabled}
        onChange={setBackPanelEnabled}
        source="backPanel"
      >
        <NumericFieldControl field="backPanel.thickness" label={t("cabinetField.backPanel.thickness")} sliderStep={1} />
      </ComponentToggle>

      <ComponentToggle
        id="toggle-plinth"
        label={t("cab.plinth")}
        description={t("cab.plinthDescription")}
        checked={plinthEnabled}
        onChange={setPlinthEnabled}
        source="plinth"
      >
        <NumericFieldControl field="plinth.height" label={t("cabinetField.plinth.height")} sliderStep={5} />
        <NumericFieldControl field="plinth.setback" label={t("cabinetField.plinth.setback")} sliderStep={5} />
      </ComponentToggle>
    </section>
  );
}
