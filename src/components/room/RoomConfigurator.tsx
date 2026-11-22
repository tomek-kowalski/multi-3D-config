"use client";

import dynamic from "next/dynamic";
import { useEffect, useMemo, useState } from "react";
import { detectCollisions } from "@/domain/arrangement/collisions";
import { LOCALES, useLocaleStore, useLocaleSync, useT } from "@/i18n";
import { bindCabinetSession } from "@/store/cabinetSession";
import { persistArrangement, useArrangementStore, type MenuId } from "@/store/useArrangementStore";
import { primaryButtonClass } from "@/components/ui/fields";
import { WallLabelOverlay } from "@/components/three/room/WallLabels";
import { ArrangementPanel, typeName } from "./ArrangementPanel";
import { ModulePanel } from "./ModulePanel";
import { OrderDialog } from "./OrderDialog";
import { SpacePanel } from "./SpacePanel";

function LoadingScene() {
  const t = useT();
  return <div className="flex h-full items-center justify-center text-sm text-stone-500">{t("app.loading3d")}</div>;
}

// WebGL needs the browser, so the canvas is never prerendered on the server.
const RoomCanvas = dynamic(() => import("@/components/three/RoomCanvas").then((mod) => mod.RoomCanvas), {
  ssr: false,
  loading: () => <LoadingScene />,
});

function LanguageSwitch() {
  const t = useT();
  const locale = useLocaleStore((s) => s.locale);
  const setLocale = useLocaleStore((s) => s.setLocale);
  return (
    <div role="group" aria-label={t("app.language")} className="flex rounded-lg bg-stone-100 p-0.5 text-xs font-semibold">
      {LOCALES.map((l) => (
        <button
          key={l}
          type="button"
          aria-pressed={l === locale}
          onClick={() => setLocale(l)}
          className={`rounded-md px-2 py-1 uppercase ${l === locale ? "bg-white text-stone-900 shadow-sm" : "text-stone-500 hover:text-stone-900"}`}
        >
          {l}
        </button>
      ))}
    </div>
  );
}

function ViewControls() {
  const t = useT();
  const requestView = useArrangementStore((s) => s.requestView);
  const hasSelection = useArrangementStore((s) => s.selectedModuleId !== null);
  const cls =
    "rounded-lg bg-white/90 px-3 py-1.5 text-xs font-medium text-stone-800 shadow-sm backdrop-blur transition-colors hover:bg-white disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-stone-800";
  return (
    <div className="absolute right-3 top-3 flex gap-2">
      <button type="button" className={cls} onClick={() => requestView("room")}>
        {t("view.room")}
      </button>
      <button type="button" className={cls} disabled={!hasSelection} onClick={() => requestView("selection")}>
        {t("view.selection")}
      </button>
    </div>
  );
}

const MENUS: readonly MenuId[] = ["space", "arrangement", "module"];

/**
 * The room-based configurator: 3D view plus three menus that keep the levels apart —
 * A the room (space), B the complete arrangement, C the selected module.
 */
export function RoomConfigurator() {
  const t = useT();
  useLocaleSync();
  const activeMenu = useArrangementStore((s) => s.activeMenu);
  const setMenu = useArrangementStore((s) => s.setActiveMenu);
  const arrangement = useArrangementStore((s) => s.arrangement);
  const selected = useArrangementStore((s) => s.arrangement.modules.find((m) => m.id === s.selectedModuleId));
  const [ordering, setOrdering] = useState(false);
  const conflicts = useMemo(() => detectCollisions(arrangement).length, [arrangement]);

  useEffect(() => {
    useArrangementStore.getState().hydrate();
    const stopPersisting = persistArrangement();
    const unbind = bindCabinetSession();
    return () => {
      stopPersisting();
      unbind();
    };
  }, []);

  const menuLabel = (menu: MenuId) =>
    menu === "module" && selected ? `${t("menu.module")}: ${typeName(t, selected.typeId)}` : t(`menu.${menu}`);

  return (
    <div className="flex min-h-dvh flex-col bg-[#ecebe8] font-sans text-stone-900 lg:h-dvh lg:flex-row lg:overflow-hidden">
      <section
        aria-label={t("app.preview")}
        className="sticky top-0 z-20 h-[45svh] min-h-64 w-full shrink-0 overflow-hidden shadow-md lg:relative lg:z-auto lg:h-full lg:min-h-0 lg:min-w-0 lg:flex-1 lg:shrink lg:shadow-none"
      >
        <RoomCanvas />
        <WallLabelOverlay />
        <ViewControls />
        <p className="pointer-events-none absolute bottom-3 left-1/2 max-w-[calc(100%-2rem)] -translate-x-1/2 truncate rounded-full bg-white/80 px-3 py-1 text-xs text-stone-600 shadow-sm backdrop-blur">
          {t("app.sceneHint")}
        </p>
      </section>

      <aside className="flex w-full flex-col border-t border-stone-200 bg-white lg:h-full lg:w-[420px] lg:shrink-0 lg:border-l lg:border-t-0">
        <header className="flex items-start justify-between gap-3 border-b border-stone-200 px-6 py-4">
          <div>
            <p className="text-xs font-medium uppercase tracking-[0.12em] text-stone-500">{t("app.kicker")}</p>
            <h1 className="mt-0.5 text-xl font-semibold tracking-tight text-stone-900">{t("app.title")}</h1>
          </div>
          <LanguageSwitch />
        </header>

        <nav aria-label={t("app.menus")} className="grid grid-cols-3 border-b border-stone-200 text-xs font-semibold">
          {MENUS.map((menu, i) => (
            <button
              key={menu}
              type="button"
              aria-current={menu === activeMenu ? "page" : undefined}
              onClick={() => setMenu(menu)}
              className={`border-b-2 px-2 py-3 text-center transition-colors ${
                menu === activeMenu ? "border-stone-900 text-stone-900" : "border-transparent text-stone-500 hover:text-stone-900"
              }`}
            >
              <span className="mr-1 text-stone-400">{"ABC"[i]}</span>
              <span className="line-clamp-1">{menuLabel(menu)}</span>
            </button>
          ))}
        </nav>

        <div className="flex-1 px-6 py-6 lg:overflow-y-auto">
          {activeMenu === "space" && <SpacePanel />}
          {activeMenu === "arrangement" && <ArrangementPanel />}
          {activeMenu === "module" && <ModulePanel />}
        </div>

        <footer className="space-y-2 border-t border-stone-200 px-6 py-4">
          <p className={`text-xs ${conflicts > 0 ? "text-red-700" : "text-stone-500"}`}>
            {conflicts > 0 ? t("footer.conflicts", { count: conflicts }) : t("footer.noConflicts", { count: arrangement.modules.length })}
          </p>
          <button type="button" className={`${primaryButtonClass} w-full`} disabled={arrangement.modules.length === 0} onClick={() => setOrdering(true)}>
            {t("footer.order")}
          </button>
        </footer>
      </aside>
      {ordering && <OrderDialog onClose={() => setOrdering(false)} />}
    </div>
  );
}
