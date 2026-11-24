"use client";

import { useEffect, useRef, type ReactNode } from "react";
import { useT, type Translate } from "@/i18n";
import { movableFronts } from "@/domain/arrangement/frontMotion";
import { getFurnitureType } from "@/domain/modules/registry";
import type { ModuleInstance } from "@/domain/modules/types";
import type { RoomOpening } from "@/domain/room/types";
import { useArrangementStore, type ActionResult } from "@/store/useArrangementStore";
import { usePreviewStore } from "@/store/usePreviewStore";
import { stateName, typeName } from "./ArrangementPanel";

const MENU_WIDTH = 220;
const ITEM_HEIGHT = 36;

export interface ContextMenuItem {
  readonly label: string;
  readonly onSelect: () => void;
  readonly danger?: boolean;
}

/**
 * The shared right-click menu (furniture, windows, doors): placed at the pointer and kept inside the
 * window, focused on its first item, closed on Escape, on any pointer press outside and on resize.
 */
export function ContextMenu({
  x,
  y,
  title,
  items,
  onClose,
  dataAttributes,
}: {
  x: number;
  y: number;
  title: ReactNode;
  items: readonly ContextMenuItem[];
  onClose: () => void;
  dataAttributes?: Record<string, string>;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const first = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const onPointerDown = (event: PointerEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) onClose();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("keydown", onKey);
    window.addEventListener("resize", onClose);
    first.current?.focus();
    return () => {
      window.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("resize", onClose);
    };
  }, [onClose, x, y]);

  const height = 32 + items.length * ITEM_HEIGHT;
  const left = Math.max(4, Math.min(x, (typeof window === "undefined" ? Infinity : window.innerWidth) - MENU_WIDTH - 4));
  const top = Math.max(4, Math.min(y, (typeof window === "undefined" ? Infinity : window.innerHeight) - height - 4));

  return (
    <div
      ref={ref}
      role="menu"
      aria-label={typeof title === "string" ? title : undefined}
      {...dataAttributes}
      onContextMenu={(e) => e.preventDefault()}
      style={{ left, top, width: MENU_WIDTH }}
      className="fixed z-50 overflow-hidden rounded-xl border border-stone-200 bg-white py-1 text-sm shadow-xl"
    >
      <p className="truncate px-3 py-1.5 text-xs text-stone-500">{title}</p>
      {items.map((item, index) => (
        <button
          key={item.label}
          ref={index === 0 ? first : undefined}
          type="button"
          role="menuitem"
          onClick={item.onSelect}
          className={
            item.danger
              ? "flex w-full items-center gap-2 px-3 py-2 text-left font-medium text-red-700 hover:bg-red-50 focus-visible:bg-red-50 focus-visible:outline-none"
              : "flex w-full items-center gap-2 px-3 py-2 text-left font-medium text-stone-800 hover:bg-stone-100 focus-visible:bg-stone-100 focus-visible:outline-none"
          }
        >
          {item.label}
        </button>
      ))}
    </div>
  );
}

/** Menu label of a state change: beds read "Rozłóż/Złóż łóżko", other furniture "Ustaw: <state>". */
function stateItemLabel(t: Translate, state: string): string {
  if (state === "unfolded") return t("contextMenu.unfoldBed");
  if (state === "folded") return t("contextMenu.foldBed");
  return t("contextMenu.setState", { state: stateName(t, state) });
}

/**
 * Right-click menu of the 3D view, by what was clicked. Furniture: its state changes (validated — a bed
 * that would hit something stays folded), "Otwórz/Zamknij wszystkie" for cabinets with fronts, and
 * removal. Windows/doors (active wall only): open/close (validated against what the leaves would hit)
 * and removal. A refused action is explained in the 3D view's notice.
 */
export function FurnitureContextMenu() {
  const t = useT();
  const menu = useArrangementStore((s) => s.contextMenu);
  const entry = useArrangementStore((s) => {
    const m = s.contextMenu;
    return m?.kind === "module" ? s.arrangement.modules.find((x) => x.id === m.moduleId) : undefined;
  });
  const opening = useArrangementStore((s) => {
    const m = s.contextMenu;
    return m?.kind === "opening" ? s.arrangement.room.openings.find((o) => o.id === m.openingId) : undefined;
  });
  const close = useArrangementStore((s) => s.closeContextMenu);
  const openIds = usePreviewStore((s) => s.openAttachmentIds);

  if (!menu) return null;
  const store = useArrangementStore.getState;
  // Every action closes the menu; a refusal is shown as a notice in the 3D view.
  const run = (action: () => ActionResult | void) => () => {
    const result = action();
    close();
    store().setNotice(result && !result.ok ? result.issues : null);
  };

  if (entry) {
    const items = moduleItems(t, entry, openIds, run);
    return (
      <ContextMenu
        x={menu.x}
        y={menu.y}
        title={`${typeName(t, entry.typeId)} · ${entry.id}`}
        items={items}
        onClose={close}
        dataAttributes={{ "data-furniture-context-menu": entry.id }}
      />
    );
  }
  if (opening) {
    return (
      <ContextMenu
        x={menu.x}
        y={menu.y}
        title={`${t(opening.kind === "door" ? "opening.door" : "opening.window")} · ${opening.id}`}
        items={openingItems(t, opening, run)}
        onClose={close}
        dataAttributes={{ "data-opening-context-menu": opening.id }}
      />
    );
  }
  return null;
}

type Run = (action: () => ActionResult | void) => () => void;

function moduleItems(t: Translate, entry: ModuleInstance, openIds: ReadonlySet<string>, run: Run): ContextMenuItem[] {
  const store = useArrangementStore.getState;
  const items: ContextMenuItem[] = [];
  const states = getFurnitureType(entry.typeId).states(entry.configuration);
  if (states.length > 1) {
    for (const state of states) {
      if (state === entry.state) continue;
      items.push({ label: stateItemLabel(t, state), onSelect: run(() => store().setModuleState(entry.id, state)) });
    }
  }
  const fronts = movableFronts(entry);
  if (fronts.length > 0) {
    // The open state belongs to the selected cabinet's editing session.
    const anyOpen = store().selectedModuleId === entry.id && fronts.some((id) => openIds.has(id));
    const allOpen = anyOpen && fronts.every((id) => openIds.has(id));
    if (!allOpen) items.push({ label: t("contextMenu.openAll"), onSelect: run(() => store().setFrontsOpen(entry.id, true)) });
    if (anyOpen) items.push({ label: t("contextMenu.closeAll"), onSelect: run(() => store().setFrontsOpen(entry.id, false)) });
  }
  items.push({ label: t("contextMenu.remove"), danger: true, onSelect: run(() => store().removeModule(entry.id)) });
  return items;
}

function openingItems(t: Translate, opening: RoomOpening, run: Run): ContextMenuItem[] {
  const store = useArrangementStore.getState;
  const door = opening.kind === "door";
  return [
    opening.open
      ? { label: t(door ? "contextMenu.closeDoor" : "contextMenu.closeWindow"), onSelect: run(() => store().setOpeningOpen(opening.id, false)) }
      : { label: t(door ? "contextMenu.openDoor" : "contextMenu.openWindow"), onSelect: run(() => store().setOpeningOpen(opening.id, true)) },
    { label: t(door ? "contextMenu.removeDoor" : "contextMenu.removeWindow"), danger: true, onSelect: run(() => store().removeOpening(opening.id)) },
  ];
}
