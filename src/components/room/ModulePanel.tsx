"use client";

import type { ReactNode } from "react";
import { AttachmentsPanel } from "@/components/configurator/AttachmentsPanel";
import { ConfigurationFilePanel } from "@/components/configurator/ConfigurationFilePanel";
import { CabinetSummary } from "@/components/configurator/ConfiguratorSidebar";
import { ConstructionPanel } from "@/components/configurator/ConstructionPanel";
import { DimensionsPanel } from "@/components/configurator/DimensionsPanel";
import { MaterialsPanel } from "@/components/configurator/MaterialsPanel";
import { StructurePanel } from "@/components/configurator/StructurePanel";
import { BED_PRODUCTS } from "@/domain/beds/catalog";
import { CABINET_TYPE_ID } from "@/domain/modules/cabinetType";
import type { FurnitureTypeId, ModuleInstance } from "@/domain/modules/types";
import { useT } from "@/i18n";
import { useArrangementStore } from "@/store/useArrangementStore";
import { buttonClass } from "@/components/ui/fields";
import { typeName } from "./ArrangementPanel";
import { BedPanel } from "./BedPanel";

/**
 * Configuration menu per furniture type. The cabinet reuses the original configurator panels
 * unchanged (they edit the selected cabinet through the cabinet editing session, see
 * src/store/cabinetSession.ts).
 */
const EDITORS = new Map<FurnitureTypeId, (instance: ModuleInstance) => ReactNode>([
  [
    CABINET_TYPE_ID,
    () => (
      <div className="space-y-8">
        <DimensionsPanel />
        <StructurePanel />
        <AttachmentsPanel />
        <ConstructionPanel />
        <MaterialsPanel />
        <CabinetSummary />
        <ConfigurationFilePanel />
      </div>
    ),
  ],
  ...BED_PRODUCTS.map((p) => [p.typeId, (instance: ModuleInstance) => <BedPanel module={instance} />] as const),
]);

/** Menu C — the currently selected furniture instance. */
export function ModulePanel() {
  const t = useT();
  const instance = useArrangementStore((s) => s.arrangement.modules.find((m) => m.id === s.selectedModuleId));
  const setMenu = useArrangementStore((s) => s.setActiveMenu);
  if (!instance) {
    return (
      <div className="space-y-3 rounded-xl border border-dashed border-stone-300 p-5 text-center">
        <p className="text-sm text-stone-600">{t("module.none")}</p>
        <button type="button" className={buttonClass} onClick={() => setMenu("arrangement")}>
          {t("module.goToArrangement")}
        </button>
      </div>
    );
  }
  const editor = EDITORS.get(instance.typeId);
  return (
    <div className="space-y-6">
      <div className="rounded-xl bg-stone-900 px-4 py-3 text-white">
        <p className="text-[11px] uppercase tracking-[0.14em] text-stone-400">{t("module.editing")}</p>
        <p className="text-base font-semibold">
          {typeName(t, instance.typeId)} <span className="font-normal text-stone-400">· {instance.id}</span>
        </p>
      </div>
      {editor ? editor(instance) : <p className="text-sm text-stone-500">{t("module.noEditor")}</p>}
    </div>
  );
}
