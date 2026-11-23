"use client";

import { useState } from "react";
import { CheckIcon, SectionHeading } from "@/components/configurator/SectionHeading";
import { NO_SWATCH_COLOR } from "@/components/three/modules/BedModel";
import type { BedConfiguration } from "@/domain/beds/bedType";
import { BED_PRODUCTS, findDecor, getBedOptions, offersMattress, type BedDecor, type BedDecorCategory } from "@/domain/beds/catalog";
import { BED_SPECS, displaySpec, type BedSizeSpec } from "@/domain/beds/specs";
import type { ModuleInstance } from "@/domain/modules/types";
import type { Issue } from "@/domain/shared/issues";
import { isMessageKey, useT } from "@/i18n";
import { useArrangementStore } from "@/store/useArrangementStore";
import { IssueList, Segmented, SelectField } from "@/components/ui/fields";
import { stateName } from "./ArrangementPanel";

function DecorGrid({
  label,
  category,
  selectedId,
  onSelect,
}: {
  label: string;
  category: BedDecorCategory;
  selectedId: string;
  onSelect: (decor: BedDecor) => void;
}) {
  const t = useT();
  const selected = category.decors.find((d) => d.id === selectedId);
  return (
    <fieldset className="space-y-2">
      <legend className="flex w-full items-baseline justify-between gap-2">
        <span className="text-sm font-medium text-stone-800">{label}</span>
        <span className="text-right text-xs text-stone-500">{selected ? `${selected.code} ${selected.structure} ${selected.name}` : "—"}</span>
      </legend>
      <div className="grid max-h-56 grid-cols-6 gap-1.5 overflow-y-auto rounded-lg border border-stone-200 p-1.5">
        {category.decors.map((decor) => {
          const isSelected = decor.id === selectedId;
          const title = `${decor.code} ${decor.structure} ${decor.name}${decor.swatch ? ` (${decor.swatch.namePl})` : ` — ${t("bed.noSwatch")}`}`;
          return (
            <button
              key={decor.id}
              type="button"
              title={title}
              aria-label={title}
              aria-pressed={isSelected}
              onClick={() => onSelect(decor)}
              className={`relative aspect-square rounded-md border border-black/10 bg-cover bg-center focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-stone-900 ${
                isSelected ? "ring-2 ring-blue-600 ring-offset-1" : ""
              }`}
              style={
                decor.swatch
                  ? { backgroundImage: `url(/textures/decors/${decor.swatch.texture})`, backgroundColor: decor.swatch.hex }
                  : { backgroundColor: NO_SWATCH_COLOR, backgroundImage: "repeating-linear-gradient(45deg, transparent 0 4px, rgba(255,255,255,.45) 4px 6px)" }
              }
            >
              {isSelected && (
                <span className="absolute -right-1 -top-1 flex size-3.5 items-center justify-center rounded-full bg-blue-600 text-white ring-2 ring-white">
                  <CheckIcon className="size-2.5" />
                </span>
              )}
            </button>
          );
        })}
      </div>
      {selected && !selected.swatch && <p className="text-xs text-amber-700">{t("bed.noSwatchSelected")}</p>}
      {selected?.swatch?.match === "code" && <p className="text-xs text-stone-500">{t("bed.swatchByCode", { code: selected.swatch.catalogCode })}</p>}
    </fieldset>
  );
}

function SpecTable({ spec }: { spec: BedSizeSpec }) {
  const t = useT();
  const rows = (["W", "H", "D", "DU", "HU", "HM", "HD", "DD", "WD"] as const).filter((k) => spec[k]);
  return (
    <table className="w-full text-xs">
      <tbody className="divide-y divide-stone-200">
        {rows.map((key) => {
          const value = spec[key]!;
          const shown = displaySpec(value);
          const differs = value.page !== undefined && value.pdf !== undefined && value.page !== value.pdf;
          return (
            <tr key={key}>
              <td className="py-1 pr-2 font-mono text-stone-500">{key}</td>
              <td className="py-1 pr-2 text-stone-700">{t(`bedSpec.${key}`)}</td>
              <td className="py-1 text-right tabular-nums text-stone-900">
                {shown} mm
                {differs && <span className="ml-1 text-amber-700">({t("bed.specSheet")}: {value.pdf})</span>}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

/** Configuration menu of a ClickBed: only the options the product's shop page offers. */
export function BedPanel({ module }: { module: ModuleInstance }) {
  const t = useT();
  const product = BED_PRODUCTS.find((p) => p.typeId === module.typeId)!;
  const options = getBedOptions(product.productId);
  const config = module.configuration as BedConfiguration;
  const updateConfiguration = useArrangementStore((s) => s.updateModuleConfiguration);
  const setState = useArrangementStore((s) => s.setModuleState);
  const [issues, setIssues] = useState<readonly Issue[]>([]);
  const update = (patch: Partial<BedConfiguration>) => {
    const result = updateConfiguration(module.id, { ...config, ...patch });
    setIssues(result.ok ? [] : result.issues);
  };
  const category = options.categories.find((c) => c.id === config.decorCategory)!;
  const spec = BED_SPECS[module.typeId][config.size];

  const changeCategory = (id: string) => {
    const next = options.categories.find((c) => c.id === id)!;
    // Keep the decors when the new category offers them, otherwise take its first decor.
    const keep = (decorId: string) => (findDecor(options, id, decorId) ? decorId : next.decors[0].id);
    update({ decorCategory: id, frontDecor: keep(config.frontDecor), bodyDecor: keep(config.bodyDecor) });
  };

  return (
    <div className="space-y-7">
      <section aria-labelledby="bed-size" className="space-y-3">
        <SectionHeading id="bed-size">{t("bed.size")}</SectionHeading>
        <Segmented label={t("bed.mattressSize")} value={config.size} options={options.sizes.map((s) => ({ value: s.key, label: s.label }))} onChange={(size) => update({ size })} />
        <Segmented
          label={t("bed.state")}
          value={module.state}
          options={["folded", "unfolded"].map((s) => ({ value: s, label: stateName(t, s) }))}
          onChange={(s) => setState(module.id, s)}
        />
        <p className="text-xs text-stone-500">{t("bed.stateHint")}</p>
        {spec && <SpecTable spec={spec} />}
      </section>

      <section aria-labelledby="bed-decor" className="space-y-4">
        <SectionHeading id="bed-decor">{t("bed.decors")}</SectionHeading>
        <SelectField label={t("bed.decorCategory")} value={config.decorCategory} options={options.categories.map((c) => ({ value: c.id, label: c.label }))} onChange={changeCategory} />
        <DecorGrid label={t("bed.frontDecor")} category={category} selectedId={config.frontDecor} onSelect={(d) => update({ frontDecor: d.id })} />
        <DecorGrid label={t("bed.bodyDecor")} category={category} selectedId={config.bodyDecor} onSelect={(d) => update({ bodyDecor: d.id })} />
        <p className="text-xs text-stone-400">{t("bed.decorHint")}</p>
      </section>

      <section aria-labelledby="bed-options" className="space-y-4">
        <SectionHeading id="bed-options">{t("bed.options")}</SectionHeading>
        {/* Only for products whose shop form offers a mattress; never selected by default. */}
        {options.firmness && offersMattress(options) && (
          <div className="space-y-4" data-mattress-control>
            <Segmented
              label={t("bed.mattress")}
              value={config.mattress ? "yes" : "no"}
              options={[
                { value: "no", label: t("common.no") },
                { value: "yes", label: t("common.yes") },
              ]}
              onChange={(v) =>
                update(v === "yes" ? { mattress: true, firmness: config.firmness ?? options.firmness!.values[0].label } : { mattress: false, firmness: null })
              }
            />
            {config.mattress && (
              <Segmented
                label={t("bed.firmness")}
                value={config.firmness ?? ""}
                options={options.firmness.values.map((v) => ({ value: v.label, label: v.label }))}
                onChange={(firmness) => update({ firmness })}
              />
            )}
          </div>
        )}
        {options.addons.map((addon) => {
          const key = `addon.${addon.id}`;
          return (
            <Segmented
              key={addon.id}
              label={isMessageKey(key) ? t(key) : addon.label}
              value={config.addons[addon.id] ? "yes" : "no"}
              options={[
                { value: "no", label: t("common.no") },
                { value: "yes", label: t("common.yes") },
              ]}
              onChange={(v) => update({ addons: { ...config.addons, [addon.id]: v === "yes" } })}
            />
          );
        })}
        <IssueList issues={issues} />
        <p className="text-xs text-stone-500">
          {t("bed.shopOptionsHint")}{" "}
          <a href={options.url} target="_blank" rel="noopener noreferrer" className="font-medium text-stone-800 underline">
            {t("bed.productPage")}
          </a>
        </p>
      </section>
    </div>
  );
}
