"use client";

import { useId, useMemo, useState } from "react";
import type { MotionLimit } from "@/domain/attachments/collisions";
import { findCoveringDoor } from "@/domain/attachments/coverage";
import { getAvailableDrawerDepth, layoutDoor, layoutDrawers } from "@/domain/attachments/layout";
import {
  addDoor,
  addDrawers,
  getAttachmentForCompartment,
  getCoveringAttachment,
  getInteriorDrawers,
} from "@/domain/attachments/operations";
import { DOOR_RULES, DRAWER_RULES } from "@/domain/attachments/rules";
import type {
  DoorAttachment,
  DrawerAttachment,
  FrontMounting,
  FurnitureAttachment,
  HandleAlign,
  HandleConfiguration,
} from "@/domain/attachments/types";
import { calculateCompartmentBounds } from "@/domain/compartments/layout";
import type { CompartmentLayout } from "@/domain/compartments/types";
import { validateCabinet, type CabinetValidationError } from "@/domain/constraints/validateCabinet";
import { formatMm } from "@/domain/furniture/format";
import type { CabinetConfiguration, DimensionRange } from "@/domain/furniture/types";
import { buildFurniture, type FurnitureModel } from "@/domain/geometry/buildFurniture";
import { HANDLE_RULES, HANDLE_TYPES, HARDWARE_FINISHES, type HandleType } from "@/domain/hardware/catalog";
import { useT, type Translate } from "@/i18n";
import { useCabinetText, type CabinetMessage } from "@/i18n/cabinet";
import { useConfiguratorStore, type CommitResult } from "@/store/useConfiguratorStore";
import { usePreviewStore } from "@/store/usePreviewStore";
import { DimensionField } from "./DimensionField";
import { CheckIcon, ErrorList, SectionHeading } from "./SectionHeading";
import { compartmentLabel } from "./StructurePanel";

const mountingOptions = (t: Translate): readonly { value: FrontMounting; label: string }[] => [
  { value: "overlay", label: t("cab.overlay") },
  { value: "inset", label: t("cab.inset") },
];

const alignOptions = (t: Translate): readonly { value: HandleAlign; label: string }[] => [
  { value: "top", label: t("cab.top") },
  { value: "center", label: t("cab.center") },
  { value: "bottom", label: t("cab.bottom") },
];

const handleOptions = (t: Translate) => HANDLE_TYPES.map((type) => ({ value: type, label: t(`handle.${type}`) }));

const NO_ERRORS: readonly CabinetValidationError[] = [];

/** First validation message an action would produce, or null when it is allowed. */
function actionBlocker(
  configuration: CabinetConfiguration,
  run: (configuration: CabinetConfiguration) => { ok: true; configuration: CabinetConfiguration } | { ok: false; error: CabinetMessage },
): CabinetMessage | null {
  const result = run(configuration);
  if (!result.ok) return result.error;
  const validation = validateCabinet(result.configuration);
  return validation.isValid ? null : validation.errors[0];
}

interface SegmentedControlProps<T extends string> {
  label: string;
  value: T;
  options: readonly { value: T; label: string }[];
  onChange: (value: T) => void;
}

/** A labelled group of native radio buttons styled as segments: arrow keys move the selection. */
function SegmentedControl<T extends string>({ label, value, options, onChange }: SegmentedControlProps<T>) {
  const name = useId();
  return (
    <fieldset className="space-y-1.5">
      <legend className="text-sm font-medium text-stone-800">{label}</legend>
      <div className="grid grid-flow-col auto-cols-fr gap-1.5">
        {options.map((option) => (
          <label
            key={option.value}
            className="relative flex cursor-pointer items-center justify-center gap-1 rounded-lg border-2 border-stone-200 bg-white px-2 py-1.5 text-center text-sm text-stone-700 transition-colors hover:border-stone-300 hover:bg-stone-50 has-[:checked]:border-blue-600 has-[:checked]:bg-blue-50 has-[:checked]:font-medium has-[:checked]:text-blue-900 has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-stone-900"
          >
            <input
              type="radio"
              name={name}
              value={option.value}
              checked={value === option.value}
              onChange={() => onChange(option.value)}
              className="sr-only"
            />
            {value === option.value && <CheckIcon className="size-3.5 shrink-0 text-blue-600" />}
            {option.label}
          </label>
        ))}
      </div>
    </fieldset>
  );
}

interface ConfigNumberFieldProps {
  field: string;
  label: string;
  value: number;
  range: DimensionRange;
  step: number;
  unit?: string;
  onCommit: (value: number) => CommitResult;
}

/** Number input (plus slider) for an attachment setting; a rejected value stays visible with its errors. */
function ConfigNumberField({ field, label, value, range, step, unit, onCommit }: ConfigNumberFieldProps) {
  const [pending, setPending] = useState<{ value: number; errors: readonly CabinetValidationError[] } | null>(null);
  return (
    <DimensionField
      field={field}
      label={label}
      value={pending ? pending.value : value}
      range={range}
      sliderStep={step}
      unit={unit}
      errors={pending?.errors ?? NO_ERRORS}
      onChange={(_, next) => {
        const result = onCommit(next);
        setPending(result.ok ? null : { value: next, errors: result.errors });
      }}
    />
  );
}

function limitsOf(model: FurnitureModel, attachmentId: string): MotionLimit[] {
  return [...model.motion.values()].filter((limit) => limit.attachmentId === attachmentId);
}

/** Explains collision limits of an attachment's moving parts, if any. */
function RestrictionNote({ limits }: { limits: readonly MotionLimit[] }) {
  const t = useT();
  const restricted = limits.filter((l) => l.allowed < l.requested - 1e-6);
  if (restricted.length === 0) return null;
  const blockers = [...new Set(restricted.flatMap((l) => l.blockedBy))].map((id) => `„${id}”`).join(", ");
  const smallest = Math.min(...restricted.map((l) => l.allowed));
  const text =
    restricted[0].kind === "hinge"
      ? t("cab.angleLimited", { allowed: formatMm(smallest), requested: formatMm(restricted[0].requested), blockers })
      : t("cab.slideLimited", { allowed: formatMm(smallest), requested: formatMm(restricted[0].requested), blockers });
  return (
    <p role="status" className="rounded-md border border-amber-200 bg-amber-50 px-2 py-1.5 text-xs text-amber-800">
      {text}
    </p>
  );
}

function PreviewToggle({ attachment, model }: { attachment: FurnitureAttachment; model: FurnitureModel }) {
  const t = useT();
  const open = usePreviewStore((state) => state.openAttachmentIds.has(attachment.id));
  const setOpen = usePreviewStore((state) => state.setOpen);
  const limits = limitsOf(model, attachment.id);
  const requiresOpen = limits.find((l) => l.requiresOpen)?.requiresOpen ?? null;
  const doorOpen = usePreviewStore((state) => (requiresOpen ? state.openAttachmentIds.has(requiresOpen) : true));
  // Interior drawers behind this door close together with it (the door waits until they are in).
  const dependents = [...model.motion.values()].filter((l) => l.requiresOpen === attachment.id).map((l) => l.attachmentId);
  const blocked = !open && !doorOpen;
  const verb =
    attachment.type === "door" ? (open ? t("cab.closeDoor") : t("cab.openDoor")) : open ? t("cab.closeDrawers") : t("cab.openDrawers");

  return (
    <div className="space-y-1.5">
      <button
        type="button"
        aria-pressed={open}
        disabled={blocked}
        aria-describedby={blocked ? `blocked-${attachment.id}` : undefined}
        onClick={() => {
          if (open) setOpen([attachment.id, ...dependents], false);
          else setOpen([attachment.id], true);
        }}
        className="flex w-full items-center justify-center gap-1.5 rounded-lg border-2 border-stone-900 bg-stone-900 px-3 py-2 text-sm font-medium text-white transition-colors hover:bg-stone-700 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-stone-900 disabled:cursor-not-allowed disabled:border-stone-300 disabled:bg-stone-300 aria-pressed:border-blue-600 aria-pressed:bg-blue-50 aria-pressed:text-blue-900 aria-pressed:hover:bg-blue-100"
      >
        {open && <CheckIcon className="size-3.5 text-blue-600" />}
        {verb} {t("cab.previewSuffix")}
      </button>
      {blocked && requiresOpen && (
        <p id={`blocked-${attachment.id}`} className="text-xs text-stone-500">
          {t("cab.openDoorFirst", { id: requiresOpen })}
        </p>
      )}
      {attachment.type === "door" && dependents.length > 0 && open && (
        <p className="text-xs text-stone-500">{t("cab.closingRetractsDrawers")}</p>
      )}
      <RestrictionNote limits={limits} />
    </div>
  );
}

function RemoveButton({ attachment }: { attachment: FurnitureAttachment }) {
  const t = useT();
  const remove = useConfiguratorStore((state) => state.removeAttachment);
  const setOpen = usePreviewStore((state) => state.setOpen);
  return (
    <button
      type="button"
      onClick={() => {
        setOpen([attachment.id], false);
        remove(attachment.id);
      }}
      className="w-full rounded-lg border border-stone-300 bg-white px-3 py-2 text-sm font-medium text-stone-800 transition-colors hover:bg-stone-100 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-stone-800"
    >
      {attachment.type === "door" ? t("cab.removeDoor") : t("cab.removeDrawers")}
    </button>
  );
}

function HandleEditor({
  idPrefix,
  handle,
  isDoor,
  onChange,
}: {
  idPrefix: string;
  handle: HandleConfiguration;
  isDoor: boolean;
  onChange: (patch: Partial<HandleConfiguration>) => CommitResult;
}) {
  const t = useT();
  const [errors, setErrors] = useState<readonly CabinetValidationError[]>(NO_ERRORS);
  const finishName = useId();
  const apply = (patch: Partial<HandleConfiguration>) => {
    const result = onChange(patch);
    setErrors(result.ok ? NO_ERRORS : result.errors);
    return result;
  };

  return (
    <div className="space-y-3 rounded-md border border-stone-200 p-2.5">
      <SegmentedControl<HandleType> label={t("cab.handle")} value={handle.type} options={handleOptions(t)} onChange={(type) => apply({ type })} />
      {handle.type !== "none" && (
        <>
          <fieldset className="space-y-1.5">
            <legend className="text-sm font-medium text-stone-800">{t("cab.handleFinish")}</legend>
            <div className="grid grid-cols-5 gap-1.5">
              {HARDWARE_FINISHES.map((finish) => (
                <label
                  key={finish.id}
                  title={t(`hardware.${finish.id}`)}
                  className="relative flex cursor-pointer flex-col items-center gap-1 rounded-lg border-2 border-transparent p-1 text-center hover:bg-stone-100 has-[:checked]:border-blue-600 has-[:checked]:bg-blue-50 has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-stone-900"
                >
                  <input
                    type="radio"
                    name={finishName}
                    value={finish.id}
                    checked={handle.finish === finish.id}
                    onChange={() => apply({ finish: finish.id })}
                    className="peer sr-only"
                  />
                  <span
                    className="relative size-6 rounded-full border border-black/15 shadow-inner peer-checked:ring-2 peer-checked:ring-blue-600 peer-checked:ring-offset-1"
                    style={{ backgroundColor: finish.color }}
                    aria-hidden="true"
                  >
                    {handle.finish === finish.id && (
                      <span className="absolute -right-1.5 -top-1.5 flex size-3.5 items-center justify-center rounded-full bg-blue-600 text-white ring-2 ring-white">
                        <CheckIcon className="size-2.5" />
                      </span>
                    )}
                  </span>
                  <span className="text-[10px] leading-tight text-stone-700 peer-checked:font-semibold peer-checked:text-blue-900">
                    {t(`hardware.${finish.id}`)}
                  </span>
                </label>
              ))}
            </div>
          </fieldset>
          <SegmentedControl<HandleAlign> label={t("cab.verticalPosition")} value={handle.align} options={alignOptions(t)} onChange={(align) => apply({ align })} />
          {isDoor && (
            <ConfigNumberField
              field={`${idPrefix}-handle-edge`}
              label={t("cab.edgeOffset")}
              value={handle.edgeOffset}
              range={HANDLE_RULES.edgeOffset}
              step={5}
              onCommit={(edgeOffset) => apply({ edgeOffset })}
            />
          )}
          {handle.align !== "center" && (
            <ConfigNumberField
              field={`${idPrefix}-handle-align`}
              label={handle.align === "top" ? t("cab.fromTop") : t("cab.fromBottom")}
              value={handle.alignOffset}
              range={HANDLE_RULES.alignOffset}
              step={5}
              onCommit={(alignOffset) => apply({ alignOffset })}
            />
          )}
        </>
      )}
      <ErrorList errors={errors} />
    </div>
  );
}

function DoorEditor({
  door,
  layout,
  configuration,
  model,
}: {
  door: DoorAttachment;
  layout: CompartmentLayout;
  configuration: CabinetConfiguration;
  model: FurnitureModel;
}) {
  const t = useT();
  const update = useConfiguratorStore((state) => state.updateDoor);
  const [errors, setErrors] = useState<readonly CabinetValidationError[]>(NO_ERRORS);
  const apply = (patch: Partial<DoorAttachment["configuration"]>) => {
    const result = update(door.id, patch);
    setErrors(result.ok ? NO_ERRORS : result.errors);
    return result;
  };
  const c = door.configuration;
  const leaves = layoutDoor(configuration, layout.bounds, door);

  return (
    <div className="space-y-4">
      <SegmentedControl
        label={t("cab.doorType")}
        value={c.layout}
        options={[
          { value: "single", label: t("cab.single") },
          { value: "double", label: t("cab.double") },
        ]}
        onChange={(value) => apply({ layout: value })}
      />
      <SegmentedControl label={t("cab.mounting")} value={c.mounting} options={mountingOptions(t)} onChange={(value) => apply({ mounting: value })} />
      {c.layout === "single" ? (
        <SegmentedControl
          label={t("cab.hinges")}
          value={c.hinge}
          options={[
            { value: "left", label: t("cab.hingeLeft") },
            { value: "right", label: t("cab.hingeRight") },
          ]}
          onChange={(value) => apply({ hinge: value })}
        />
      ) : (
        <p className="text-xs text-stone-500">{t("cab.doubleHinges")}</p>
      )}
      <ErrorList errors={errors} />
      <ConfigNumberField
        field={`door-${door.id}-gap`}
        label={t("cab.gap")}
        value={c.gap}
        range={DOOR_RULES.gap}
        step={1}
        onCommit={(gap) => apply({ gap })}
      />
      {c.layout === "double" && (
        <ConfigNumberField
          field={`door-${door.id}-center-gap`}
          label={t("cab.centerGap")}
          value={c.centerGap}
          range={DOOR_RULES.centerGap}
          step={1}
          onCommit={(centerGap) => apply({ centerGap })}
        />
      )}
      <ConfigNumberField
        field={`door-${door.id}-angle`}
        label={t("cab.maxAngle")}
        value={c.maxOpenAngle}
        range={DOOR_RULES.openAngle}
        step={5}
        unit="°"
        onCommit={(maxOpenAngle) => apply({ maxOpenAngle })}
      />
      <p className="text-xs tabular-nums text-stone-600">
        {c.layout === "double" ? t("cab.leaf") : t("cab.door")}: {formatMm(leaves[0].box.dimensions.width)} ×{" "}
        {formatMm(leaves[0].box.dimensions.height)} mm
        {c.layout === "double" && " (×2)"}
      </p>
      <HandleEditor
        idPrefix={`door-${door.id}`}
        handle={c.handle}
        isDoor
        onChange={(patch) => update(door.id, { handle: { ...c.handle, ...patch } })}
      />
      <PreviewToggle attachment={door} model={model} />
      <RemoveButton attachment={door} />
    </div>
  );
}

function DrawerHeights({ drawer, frontHeights }: { drawer: DrawerAttachment; frontHeights: readonly number[] }) {
  const t = useT();
  const update = useConfiguratorStore((state) => state.updateDrawers);
  const setHeight = useConfiguratorStore((state) => state.setDrawerFrontHeight);
  const custom = drawer.configuration.heightRatios !== null;
  const total = frontHeights.reduce((a, b) => a + b, 0);
  const maxHeight = Math.max(DRAWER_RULES.minFrontHeight, Math.floor(total - (frontHeights.length - 1) * DRAWER_RULES.minFrontHeight));

  return (
    <div className="space-y-3">
      <SegmentedControl
        label={t("cab.frontHeights")}
        value={custom ? "custom" : "equal"}
        options={[
          { value: "equal", label: t("cab.equal") },
          { value: "custom", label: t("cab.custom") },
        ]}
        onChange={(mode) =>
          update(drawer.id, {
            // Custom mode starts from the current (equal) heights as weights.
            heightRatios: mode === "equal" ? null : frontHeights.map((h) => Math.round(h * 100) / 100),
          })
        }
      />
      {custom && (
        <div className="space-y-3">
          <p className="text-xs text-stone-500">
            {t("cab.heightsHint", { total: formatMm(total) })}
          </p>
          {[...frontHeights.keys()].reverse().map((index) => (
            <ConfigNumberField
              key={index}
              field={`drawer-${drawer.id}-height-${index}`}
              label={
                index === 0
                  ? t("cab.drawerBottom", { n: index + 1 })
                  : index === frontHeights.length - 1
                    ? t("cab.drawerTop", { n: index + 1 })
                    : t("cab.drawerN", { n: index + 1 })
              }
              value={Math.round(frontHeights[index] * 10) / 10}
              range={{ min: DRAWER_RULES.minFrontHeight, max: maxHeight }}
              step={1}
              onCommit={(height) => setHeight(drawer.id, index, height)}
            />
          ))}
          <button
            type="button"
            onClick={() => update(drawer.id, { heightRatios: null })}
            className="w-full rounded-lg border border-stone-300 bg-white px-3 py-1.5 text-sm font-medium text-stone-800 hover:bg-stone-100 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-stone-800"
          >
            {t("cab.equalize")}
          </button>
        </div>
      )}
    </div>
  );
}

function DrawerEditor({
  drawer,
  layout,
  configuration,
  model,
}: {
  drawer: DrawerAttachment;
  layout: CompartmentLayout;
  configuration: CabinetConfiguration;
  model: FurnitureModel;
}) {
  const t = useT();
  const update = useConfiguratorStore((state) => state.updateDrawers);
  const [errors, setErrors] = useState<readonly CabinetValidationError[]>(NO_ERRORS);
  const c = drawer.configuration;
  const context = { coveringDoor: findCoveringDoor(configuration, drawer.compartmentId) };
  const available = Math.floor(getAvailableDrawerDepth(configuration, layout.bounds, c, context));
  const drawers = layoutDrawers(configuration, layout.bounds, drawer, context);
  const interior = c.placement === "interior";

  return (
    <div className="space-y-4">
      {interior ? (
        <p className="text-xs text-stone-500">
          {t("cab.interiorDrawersNote", { id: context.coveringDoor?.id ?? "" })}
        </p>
      ) : (
        <SegmentedControl
          label={t("cab.frontMounting")}
          value={c.mounting}
          options={mountingOptions(t)}
          onChange={(mounting) => {
            const result = update(drawer.id, { mounting });
            setErrors(result.ok ? NO_ERRORS : result.errors);
          }}
        />
      )}
      <ErrorList errors={errors} />
      <ConfigNumberField
        field={`drawer-${drawer.id}-count`}
        label={t("cab.drawerCount")}
        value={c.count}
        range={{ min: DRAWER_RULES.minCount, max: DRAWER_RULES.maxCount }}
        step={1}
        unit={t("cab.pcs")}
        onCommit={(count) => update(drawer.id, { count })}
      />
      <DrawerHeights drawer={drawer} frontHeights={drawers.map((d) => d.front.dimensions.height)} />
      <ConfigNumberField
        field={`drawer-${drawer.id}-gap`}
        label={t("cab.frontGap")}
        value={c.frontGap}
        range={DRAWER_RULES.frontGap}
        step={1}
        onCommit={(frontGap) => update(drawer.id, { frontGap })}
      />
      <ConfigNumberField
        field={`drawer-${drawer.id}-depth`}
        label={t("cab.drawerDepth")}
        value={c.depth}
        range={{ min: DRAWER_RULES.minDepth, max: Math.max(DRAWER_RULES.minDepth, available) }}
        step={10}
        onCommit={(depth) => update(drawer.id, { depth })}
      />
      <ul className="space-y-0.5 text-xs tabular-nums text-stone-600">
        {[...drawers].reverse().map((d) => (
          <li key={d.index}>
            {t("cab.drawerLine", {
              n: d.index,
              front: `${formatMm(d.front.dimensions.width)} × ${formatMm(d.front.dimensions.height)}`,
              box: `${formatMm(d.box.dimensions.width)} × ${formatMm(d.box.dimensions.height)} × ${formatMm(d.box.dimensions.depth)}`,
            })}
          </li>
        ))}
      </ul>
      <HandleEditor
        idPrefix={`drawer-${drawer.id}`}
        handle={c.handle}
        isDoor={false}
        onChange={(patch) => update(drawer.id, { handle: { ...c.handle, ...patch } })}
      />
      <PreviewToggle attachment={drawer} model={model} />
      <RemoveButton attachment={drawer} />
    </div>
  );
}

function ActionButton({ label, blocker, onClick }: { label: string; blocker: CabinetMessage | null; onClick: () => void }) {
  const text = useCabinetText();
  return (
    <div>
      <button
        type="button"
        disabled={blocker !== null}
        onClick={onClick}
        className="w-full rounded-lg bg-stone-900 px-3 py-2 text-sm font-medium text-white transition-colors hover:bg-stone-700 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-stone-900 disabled:cursor-not-allowed disabled:bg-stone-300"
      >
        {label}
      </button>
      {blocker && <p className="mt-1 text-xs text-stone-500">{text(blocker)}</p>}
    </div>
  );
}

function AddExteriorButtons({ configuration, compartmentId }: { configuration: CabinetConfiguration; compartmentId: string }) {
  const t = useT();
  const addDoorAction = useConfiguratorStore((state) => state.addDoor);
  const addDrawersAction = useConfiguratorStore((state) => state.addDrawers);
  const blockers = useMemo(
    () => ({
      single: actionBlocker(configuration, (c) => addDoor(c, compartmentId, "single")),
      double: actionBlocker(configuration, (c) => addDoor(c, compartmentId, "double")),
      drawers: actionBlocker(configuration, (c) => addDrawers(c, compartmentId, "exterior")),
    }),
    [configuration, compartmentId],
  );
  return (
    <div className="space-y-2">
      <ActionButton label={t("cab.addSingleDoor")} blocker={blockers.single} onClick={() => addDoorAction(compartmentId, "single")} />
      <ActionButton label={t("cab.addDoubleDoor")} blocker={blockers.double} onClick={() => addDoorAction(compartmentId, "double")} />
      <ActionButton label={t("cab.addDrawers")} blocker={blockers.drawers} onClick={() => addDrawersAction(compartmentId, "exterior")} />
    </div>
  );
}

function InteriorDrawersSection({
  configuration,
  layout,
  model,
}: {
  configuration: CabinetConfiguration;
  layout: CompartmentLayout;
  model: FurnitureModel;
}) {
  const t = useT();
  const addDrawersAction = useConfiguratorStore((state) => state.addDrawers);
  const interior = getInteriorDrawers(configuration, layout.id);
  const blocker = useMemo(
    () => (interior ? null : actionBlocker(configuration, (c) => addDrawers(c, layout.id, "interior"))),
    [configuration, layout.id, interior],
  );
  return (
    <div className="space-y-3 border-t border-stone-200 pt-3">
      <p className="text-sm font-medium text-stone-900">{t("cab.interiorDrawers")}</p>
      {interior ? (
        <DrawerEditor key={interior.id} drawer={interior} layout={layout} configuration={configuration} model={model} />
      ) : (
        <ActionButton label={t("cab.addInteriorDrawers")} blocker={blocker} onClick={() => addDrawersAction(layout.id, "interior")} />
      )}
    </div>
  );
}

export function AttachmentsPanel() {
  const t = useT();
  const configuration = useConfiguratorStore((state) => state.configuration);
  const selectedId = useConfiguratorStore((state) => state.selectedCompartmentId);
  const rejection = useConfiguratorStore((state) => (state.rejection?.source === "attachments" ? state.rejection : null));
  const openCount = usePreviewStore((state) => state.openAttachmentIds.size);
  const setOpen = usePreviewStore((state) => state.setOpen);
  const closeAll = usePreviewStore((state) => state.closeAll);
  const select = useConfiguratorStore((state) => state.selectCompartment);
  const model = useMemo(() => buildFurniture(configuration), [configuration]);

  const layout = useMemo(
    () => (selectedId ? calculateCompartmentBounds(configuration).find((l) => l.id === selectedId) : undefined),
    [configuration, selectedId],
  );
  const attachment = selectedId ? getAttachmentForCompartment(configuration, selectedId) : null;
  // An exterior front on an enclosing compartment covers this one (and everything inside it).
  const covering = selectedId && !attachment ? getCoveringAttachment(configuration, selectedId) : null;
  const coveringDoor = selectedId ? findCoveringDoor(configuration, selectedId) : null;
  const rootId = configuration.compartments.id;
  // Interior drawers are possible in an undivided compartment behind a door (not behind exterior drawers).
  const interiorPossible = layout?.isLeaf && coveringDoor !== null && attachment?.type !== "drawer";
  const allIds = configuration.attachments.map((a) => a.id);

  return (
    <section aria-labelledby="attachments-heading" className="space-y-4">
      <div className="flex items-baseline justify-between gap-2">
        <SectionHeading id="attachments-heading">{t("cab.doorsAndDrawers")}</SectionHeading>
        {allIds.length > 0 && (
          <button
            type="button"
            onClick={() => (openCount > 0 ? closeAll() : setOpen(allIds, true))}
            className="text-xs font-medium text-stone-600 underline underline-offset-2 hover:text-stone-900"
          >
            {openCount > 0 ? t("cab.closeAll") : t("cab.openAll")}
          </button>
        )}
      </div>

      {!layout ? (
        <p className="text-xs text-stone-500">{t("cab.selectToAddFronts")}</p>
      ) : (
        <div className="space-y-4 rounded-lg border border-stone-200 p-3">
          <div>
            <p className="text-sm font-medium text-stone-900">{compartmentLabel(t, layout.id, rootId)}</p>
            <p className="text-xs tabular-nums text-stone-600">
              {t("cab.opening", {
                size: `${formatMm(layout.bounds.dimensions.width)} × ${formatMm(layout.bounds.dimensions.height)} × ${formatMm(layout.bounds.dimensions.depth)}`,
              })}
              {!layout.isLeaf && ` · ${t("cab.withShelvesOrDividers")}`}
            </p>
          </div>
          {covering && (
            <div className="space-y-2 rounded-md bg-stone-50 p-2 text-xs text-stone-600">
              <p>
                {t(covering.type === "door" ? "cab.coveredByDoor" : "cab.coveredByFront", {
                  id: covering.id,
                  compartment: compartmentLabel(t, covering.compartmentId, rootId).toLowerCase(),
                })}
              </p>
              <button
                type="button"
                onClick={() => select(covering.compartmentId)}
                className="font-medium text-stone-800 underline underline-offset-2 hover:text-stone-950"
              >
                {t("cab.editDoor", { id: covering.id })}
              </button>
            </div>
          )}
          {!attachment && !covering && <AddExteriorButtons configuration={configuration} compartmentId={layout.id} />}
          {attachment?.type === "door" && (
            <DoorEditor key={attachment.id} door={attachment} layout={layout} configuration={configuration} model={model} />
          )}
          {attachment?.type === "drawer" && (
            <DrawerEditor key={attachment.id} drawer={attachment} layout={layout} configuration={configuration} model={model} />
          )}
          {interiorPossible && <InteriorDrawersSection configuration={configuration} layout={layout} model={model} />}
        </div>
      )}

      {rejection && <ErrorList errors={rejection.errors} />}
    </section>
  );
}
