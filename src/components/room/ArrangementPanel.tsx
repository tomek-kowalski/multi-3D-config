"use client";

import { useMemo, useRef, useState } from "react";
import { SectionHeading } from "@/components/configurator/SectionHeading";
import { detectCollisions, issuesForModule, type CollisionIssue } from "@/domain/arrangement/collisions";
import { moduleFootprint } from "@/domain/arrangement/spatial";
import { getFurnitureType, listFurnitureTypes } from "@/domain/modules/registry";
import type { ModuleInstance } from "@/domain/modules/types";
import { WALL_IDS } from "@/domain/room/types";
import type { Issue } from "@/domain/shared/issues";
import { isMessageKey, useT, type Translate } from "@/i18n";
import { downloadJson } from "@/services/woocommerce";
import { useArrangementStore, type ActionResult } from "@/store/useArrangementStore";
import { buttonClass, Card, dangerButtonClass, IssueList, MmField, Segmented, SelectField } from "@/components/ui/fields";

const issuesOf = (r: ActionResult): readonly Issue[] => (r.ok ? [] : r.issues);

export function typeName(t: Translate, typeId: string): string {
  const key = getFurnitureType(typeId).nameKey;
  return isMessageKey(key) ? t(key) : typeId;
}

export function stateName(t: Translate, state: string): string {
  const key = `state.${state}`;
  return isMessageKey(key) ? t(key) : state;
}

/** Human-readable collision line for a module. */
export function describeCollision(t: Translate, issue: CollisionIssue, modules: readonly ModuleInstance[], selfId?: string): string {
  const phase = issue.phase === "operation" ? ` ${t("collision.duringOperation")}` : "";
  switch (issue.kind) {
    case "outside-room":
      return t("collision.outsideRoom", { module: issue.moduleId }) + phase;
    case "opening":
      return t("collision.opening", { module: issue.moduleId, opening: issue.openingId }) + phase;
    case "module": {
      const other = issue.moduleId === selfId ? issue.otherId : issue.moduleId;
      const otherModule = modules.find((m) => m.id === other);
      return t("collision.module", { module: selfId ?? issue.moduleId, other: otherModule ? `${typeName(t, otherModule.typeId)} (${other})` : other }) + phase;
    }
  }
}

function Catalog() {
  const t = useT();
  const add = useArrangementStore((s) => s.addModule);
  const setMenu = useArrangementStore((s) => s.setActiveMenu);
  const [issues, setIssues] = useState<readonly Issue[]>([]);
  return (
    <section aria-labelledby="catalog" className="space-y-3">
      <SectionHeading id="catalog">{t("arrangement.catalog")}</SectionHeading>
      <ul className="space-y-2">
        {listFurnitureTypes().map((type) => (
          <li key={type.id} className="flex items-center justify-between gap-3 rounded-lg border border-stone-200 px-3 py-2">
            <div>
              <p className="text-sm font-medium text-stone-900">{typeName(t, type.id)}</p>
              <p className="text-xs text-stone-500">{t(type.geometrySource === "parametric" ? "arrangement.parametric" : "arrangement.importedModel")}</p>
            </div>
            <button
              type="button"
              className={buttonClass}
              onClick={() => {
                const result = add(type.id);
                setIssues(issuesOf(result));
                if (result.ok) setMenu("arrangement");
              }}
            >
              {t("arrangement.add")}
            </button>
          </li>
        ))}
      </ul>
      <IssueList issues={issues} />
    </section>
  );
}

function ModuleList({ collisions }: { collisions: readonly CollisionIssue[] }) {
  const t = useT();
  const modules = useArrangementStore((s) => s.arrangement.modules);
  const selectedId = useArrangementStore((s) => s.selectedModuleId);
  const select = useArrangementStore((s) => s.selectModule);
  return (
    <section aria-labelledby="module-list" className="space-y-3">
      <SectionHeading id="module-list">{t("arrangement.placed", { count: modules.length })}</SectionHeading>
      {modules.length === 0 ? (
        <p className="rounded-lg border border-dashed border-stone-300 px-3 py-4 text-center text-xs text-stone-500">{t("arrangement.empty")}</p>
      ) : (
        <ul className="space-y-1.5">
          {modules.map((m) => {
            const fp = moduleFootprint(m);
            const conflicts = issuesForModule(collisions, m.id).length;
            return (
              <li key={m.id}>
                <button
                  type="button"
                  aria-pressed={m.id === selectedId}
                  onClick={() => select(m.id === selectedId ? null : m.id)}
                  className={`flex w-full items-center justify-between gap-2 rounded-lg border px-3 py-2 text-left transition-colors ${
                    m.id === selectedId ? "border-blue-500 bg-blue-50" : "border-stone-200 hover:bg-stone-50"
                  }`}
                >
                  <span>
                    <span className="block text-sm font-medium text-stone-900">{typeName(t, m.typeId)}</span>
                    <span className="block text-xs tabular-nums text-stone-500">
                      {m.id} · {Math.round(fp.width)} × {Math.round(fp.height)} × {Math.round(fp.depth)} mm
                    </span>
                  </span>
                  {conflicts > 0 && (
                    <span className="rounded-full bg-red-100 px-2 py-0.5 text-xs font-medium text-red-700">{t("arrangement.conflicts", { count: conflicts })}</span>
                  )}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

function SelectedModuleControls({ module, collisions }: { module: ModuleInstance; collisions: readonly CollisionIssue[] }) {
  const t = useT();
  const modules = useArrangementStore((s) => s.arrangement.modules);
  const store = useArrangementStore.getState;
  const [issues, setIssues] = useState<readonly Issue[]>([]);
  const [nextType, setNextType] = useState(listFurnitureTypes()[0].id);
  const type = getFurnitureType(module.typeId);
  const states = type.states(module.configuration);
  const run = (r: ActionResult) => setIssues(issuesOf(r));
  const own = issuesForModule(collisions, module.id);
  const place = (key: "x" | "y" | "z" | "rotationDeg") => (v: number) => issuesOf(store().setPlacement(module.id, { [key]: v }));

  return (
    <section aria-labelledby="selected-module" className="space-y-4">
      <SectionHeading id="selected-module">
        {t("arrangement.selected")}: {typeName(t, module.typeId)} · {module.id}
      </SectionHeading>
      <Card selected>
        <p className="text-xs text-stone-500">{t("arrangement.positionHint")}</p>
        <div className="grid grid-cols-2 gap-2">
          <MmField label={t("arrangement.x")} value={module.placement.x} onCommit={place("x")} />
          <MmField label={t("arrangement.z")} value={module.placement.z} onCommit={place("z")} />
          <MmField label={t("arrangement.y")} value={module.placement.y} onCommit={place("y")} />
          <MmField label={t("arrangement.rotation")} unit="°" step={0.1} value={module.placement.rotationDeg} onCommit={place("rotationDeg")} />
        </div>
        <div className="grid grid-cols-2 gap-2">
          <button type="button" className={buttonClass} onClick={() => run(store().rotateModule(module.id, 90))}>
            ⟲ {t("arrangement.rotateLeft")}
          </button>
          <button type="button" className={buttonClass} onClick={() => run(store().rotateModule(module.id, -90))}>
            ⟳ {t("arrangement.rotateRight")}
          </button>
        </div>
        <div className="space-y-1.5">
          <p className="text-sm font-medium text-stone-800">{t("arrangement.snapToWall")}</p>
          <div className="grid grid-cols-4 gap-1.5">
            {WALL_IDS.map((wall) => (
              <button key={wall} type="button" className={`${buttonClass} px-2 text-xs`} onClick={() => run(store().snapToWall(module.id, wall))}>
                {t(`wall.${wall}`)}
              </button>
            ))}
          </div>
        </div>
        {states.length > 1 && (
          <Segmented
            label={t("arrangement.state")}
            value={module.state}
            options={states.map((s) => ({ value: s, label: stateName(t, s) }))}
            onChange={(s) => run(store().setModuleState(module.id, s))}
          />
        )}
      </Card>

      <Card>
        <p className="text-sm font-medium text-stone-800">{t("arrangement.duplicate")}</p>
        <p className="text-xs text-stone-500">{t("arrangement.duplicateHint")}</p>
        <div className="grid grid-cols-2 gap-2">
          <button type="button" className={buttonClass} onClick={() => run(store().duplicateSelected("left"))}>
            ← {t("arrangement.toLeft")}
          </button>
          <button type="button" className={buttonClass} onClick={() => run(store().duplicateSelected("right"))}>
            {t("arrangement.toRight")} →
          </button>
        </div>
        <SelectField
          label={t("arrangement.addNextTo")}
          value={nextType}
          options={listFurnitureTypes().map((ty) => ({ value: ty.id, label: typeName(t, ty.id) }))}
          onChange={setNextType}
        />
        <div className="grid grid-cols-2 gap-2">
          <button type="button" className={buttonClass} onClick={() => run(store().addModuleNextTo(nextType, "left"))}>
            ← {t("arrangement.toLeft")}
          </button>
          <button type="button" className={buttonClass} onClick={() => run(store().addModuleNextTo(nextType, "right"))}>
            {t("arrangement.toRight")} →
          </button>
        </div>
      </Card>
      <IssueList issues={issues} />

      {own.length > 0 && (
        <ul role="status" className="space-y-1 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900">
          {own.map((issue, i) => (
            <li key={i}>⚠ {describeCollision(t, issue, modules, module.id)}</li>
          ))}
        </ul>
      )}

      <div className="grid grid-cols-2 gap-2">
        <button type="button" className={buttonClass} onClick={() => store().setActiveMenu("module")}>
          {t("arrangement.configure")}
        </button>
        <button type="button" className={dangerButtonClass} onClick={() => run(store().removeModule(module.id))}>
          {t("arrangement.remove")}
        </button>
      </div>
    </section>
  );
}

function ArrangementFile() {
  const t = useT();
  const input = useRef<HTMLInputElement>(null);
  const [issues, setIssues] = useState<readonly Issue[]>([]);
  const [message, setMessage] = useState<string | null>(null);
  return (
    <section aria-labelledby="arrangement-file" className="space-y-3">
      <SectionHeading id="arrangement-file">{t("arrangement.file")}</SectionHeading>
      <div className="grid grid-cols-2 gap-2">
        <button type="button" className={buttonClass} onClick={() => downloadJson(useArrangementStore.getState().exportJson(), "uklad-mebli.json")}>
          {t("arrangement.export")}
        </button>
        <button type="button" className={buttonClass} onClick={() => input.current?.click()}>
          {t("arrangement.import")}
        </button>
      </div>
      <input
        ref={input}
        type="file"
        accept="application/json,.json"
        className="hidden"
        aria-label={t("arrangement.import")}
        onChange={async (e) => {
          const file = e.target.files?.[0];
          e.target.value = "";
          if (!file) return;
          const result = useArrangementStore.getState().importJson(await file.text());
          setIssues(issuesOf(result));
          setMessage(result.ok ? t("arrangement.imported", { file: file.name }) : null);
        }}
      />
      {message && <p className="rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs text-emerald-800">{message}</p>}
      <IssueList issues={issues} />
      <button
        type="button"
        className={`${dangerButtonClass} w-full`}
        onClick={() => {
          if (window.confirm(t("arrangement.resetConfirm"))) useArrangementStore.getState().reset();
        }}
      >
        {t("arrangement.reset")}
      </button>
    </section>
  );
}

/** Menu B — the complete furniture arrangement. */
export function ArrangementPanel() {
  const arrangement = useArrangementStore((s) => s.arrangement);
  const selectedId = useArrangementStore((s) => s.selectedModuleId);
  const collisions = useMemo(() => detectCollisions(arrangement), [arrangement]);
  const selected = arrangement.modules.find((m) => m.id === selectedId);
  return (
    <div className="space-y-8">
      {selected && <SelectedModuleControls module={selected} collisions={collisions} />}
      <ModuleList collisions={collisions} />
      <Catalog />
      <ArrangementFile />
    </div>
  );
}
