"use client";

import { useEffect, useRef } from "react";
import { useT } from "@/i18n";
import { useArrangementStore } from "@/store/useArrangementStore";
import { typeName } from "./ArrangementPanel";

const MENU_WIDTH = 200;
const MENU_HEIGHT = 80;

/**
 * Right-click menu of a furniture entry (opened from the 3D view, see ModuleObject). Removing deletes
 * exactly that instance; the arrangement, selection, collisions, docking and quotation data all derive
 * from the same store, so they update at once. Closes on Escape and on any pointer press outside.
 */
export function FurnitureContextMenu() {
  const t = useT();
  const menu = useArrangementStore((s) => s.contextMenu);
  const entry = useArrangementStore((s) => s.arrangement.modules.find((m) => m.id === s.contextMenu?.moduleId));
  const close = useArrangementStore((s) => s.closeContextMenu);
  const remove = useArrangementStore((s) => s.removeModule);
  const ref = useRef<HTMLDivElement>(null);
  const first = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!menu) return;
    const onPointerDown = (event: PointerEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) close();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    window.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("keydown", onKey);
    window.addEventListener("resize", close);
    first.current?.focus();
    return () => {
      window.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("resize", close);
    };
  }, [menu, close]);

  if (!menu || !entry) return null;
  // Keep the menu inside the window.
  const x = Math.max(4, Math.min(menu.x, (typeof window === "undefined" ? Infinity : window.innerWidth) - MENU_WIDTH - 4));
  const y = Math.max(4, Math.min(menu.y, (typeof window === "undefined" ? Infinity : window.innerHeight) - MENU_HEIGHT - 4));

  return (
    <div
      ref={ref}
      role="menu"
      aria-label={`${typeName(t, entry.typeId)} · ${entry.id}`}
      data-furniture-context-menu={entry.id}
      onContextMenu={(e) => e.preventDefault()}
      style={{ left: x, top: y, width: MENU_WIDTH }}
      className="fixed z-50 overflow-hidden rounded-xl border border-stone-200 bg-white py-1 text-sm shadow-xl"
    >
      <p className="truncate px-3 py-1.5 text-xs text-stone-500">
        {typeName(t, entry.typeId)} · {entry.id}
      </p>
      <button
        ref={first}
        type="button"
        role="menuitem"
        onClick={() => remove(entry.id)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left font-medium text-red-700 hover:bg-red-50 focus-visible:bg-red-50 focus-visible:outline-none"
      >
        {t("contextMenu.remove")}
      </button>
    </div>
  );
}
