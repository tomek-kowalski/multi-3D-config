"use client";

import { isBranch } from "@/domain/compartments/types";
import { getMaterial, MATERIAL_CATALOG, type MaterialSlot } from "@/domain/furniture/materials";
import type { CabinetConfiguration } from "@/domain/furniture/types";
import { useConfiguratorStore } from "@/store/useConfiguratorStore";
import { CheckIcon } from "./SectionHeading";
import { useT, type Translate } from "@/i18n";

interface SlotDefinition {
  slot: MaterialSlot;
  /** Whether any generated part uses this slot. */
  isAvailable: (configuration: CabinetConfiguration) => boolean;
}

/** Label and the hint shown while the selector is disabled. */
function slotTexts(t: Translate, slot: MaterialSlot) {
  return { label: t(`materialSlot.${slot}`), unavailableReason: slot === "body" ? "" : t(`materialSlot.${slot}.unavailable`) };
}

// A selector is enabled only while parts using its slot exist.
const SLOTS: readonly SlotDefinition[] = [
  { slot: "body", isAvailable: () => true },
  // Also used by the drawer boxes.
  { slot: "interior", isAvailable: (c) => isBranch(c.compartments) || c.attachments.some((a) => a.type === "drawer") },
  { slot: "backPanel", isAvailable: (c) => c.backPanel.enabled },
  { slot: "plinth", isAvailable: (c) => c.plinth.enabled },
  { slot: "doorFront", isAvailable: (c) => c.attachments.some((a) => a.type === "door") },
  { slot: "drawerFront", isAvailable: (c) => c.attachments.some((a) => a.type === "drawer") },
];

function MaterialSelector({ slot, isAvailable }: SlotDefinition) {
  const t = useT();
  const { label, unavailableReason } = slotTexts(t, slot);
  const selectedId = useConfiguratorStore((state) => state.configuration.materials[slot]);
  const available = useConfiguratorStore((state) => isAvailable(state.configuration));
  const setMaterial = useConfiguratorStore((state) => state.setMaterial);
  const disabled = !available;
  const hintId = `material-${slot}-hint`;

  return (
    <fieldset disabled={disabled} aria-describedby={disabled ? hintId : undefined} className="group space-y-2.5">
      <legend className="flex w-full items-baseline justify-between gap-3">
        <span className="text-sm font-medium text-stone-800 group-disabled:text-stone-400">{label}</span>
        <span className="text-xs text-stone-500 group-disabled:text-stone-400">{t(`material.${getMaterial(selectedId).id}`)}</span>
      </legend>

      <div className="grid grid-cols-4 gap-2">
        {MATERIAL_CATALOG.map((material) => (
          <label
            key={material.id}
            title={t(`material.${material.id}`)}
            // `relative` keeps the absolutely positioned sr-only radio inside the scrolling sidebar.
            className="relative flex cursor-pointer flex-col items-center gap-1.5 rounded-lg border-2 border-transparent p-1.5 text-center transition-colors hover:bg-stone-100 has-[:checked]:border-blue-600 has-[:checked]:bg-blue-50 has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-stone-900 group-disabled:cursor-not-allowed group-disabled:opacity-50 group-disabled:hover:bg-transparent group-disabled:has-[:checked]:border-stone-300 group-disabled:has-[:checked]:bg-stone-50"
          >
            <input
              type="radio"
              name={`material-${slot}`}
              value={material.id}
              checked={selectedId === material.id}
              onChange={() => setMaterial(slot, material.id)}
              className="peer sr-only"
            />
            {/* The swatch always keeps the real finish colour; selection is a ring plus a check badge. */}
            <span
              className="relative size-8 rounded-full border border-black/15 shadow-inner peer-checked:ring-2 peer-checked:ring-blue-600 peer-checked:ring-offset-2 group-disabled:peer-checked:ring-stone-400"
              style={{ backgroundColor: material.color }}
              aria-hidden="true"
            >
              {selectedId === material.id && (
                <span className="absolute -right-1.5 -top-1.5 flex size-4 items-center justify-center rounded-full bg-blue-600 text-white ring-2 ring-white group-disabled:bg-stone-400">
                  <CheckIcon className="size-3" />
                </span>
              )}
            </span>
            <span className="text-[11px] leading-tight text-stone-700 peer-checked:font-semibold peer-checked:text-blue-900 group-disabled:peer-checked:text-stone-600">
              {t(`material.${material.id}`)}
            </span>
          </label>
        ))}
      </div>

      {disabled && (
        <p id={hintId} className="text-xs text-stone-400">
          {unavailableReason}
        </p>
      )}
    </fieldset>
  );
}

export function MaterialsPanel() {
  const t = useT();
  return (
    <section aria-labelledby="materials-heading" className="space-y-6">
      <h2 id="materials-heading" className="text-xs font-semibold uppercase tracking-[0.12em] text-stone-500">
        {t("cab.materials")}
      </h2>
      {SLOTS.map((definition) => (
        <MaterialSelector key={definition.slot} {...definition} />
      ))}
      <p className="text-xs text-stone-400">{t("cab.colorsApproximate")}</p>
    </section>
  );
}
