"use client";

import dynamic from "next/dynamic";
import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { detectCollisions } from "@/domain/arrangement/collisions";
import { LOCALES, useLocaleStore, useLocaleSync, useT } from "@/i18n";
import { bindCabinetSession } from "@/store/cabinetSession";
import { persistArrangement, useArrangementStore, type MenuId } from "@/store/useArrangementStore";
import { primaryButtonClass } from "@/components/ui/fields";
import { WallLabelOverlay } from "@/components/three/room/WallLabels";
import { ArrangementPanel, typeName } from "./ArrangementPanel";
import { ModulePanel } from "./ModulePanel";
import { FurnitureContextMenu } from "./FurnitureContextMenu";
import { OrderDialog } from "./OrderDialog";
import { CollisionNotes, DockingPrompt, ViewOverlay } from "./ViewOverlay";

function LoadingScene() {
  const t = useT();
  return <div className="flex h-full items-center justify-center text-sm text-stone-500">{t("app.loading3d")}</div>;
}

// WebGL needs the browser, so the canvas is never prerendered on the server.
import { WebGLErrorBoundary } from "@/components/three/WebGLErrorBoundary";

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

const MENUS: readonly MenuId[] = ["arrangement", "module"];

/** The main menu: A — Układ mebli (arrangement), B — Moduł (selected module). */
export function MainMenu() {
  const t = useT();
  const activeMenu = useArrangementStore((s) => s.activeMenu);
  const setMenu = useArrangementStore((s) => s.setActiveMenu);
  const selected = useArrangementStore((s) => s.arrangement.modules.find((m) => m.id === s.selectedModuleId));
  const menuLabel = (menu: MenuId) =>
    menu === "module" && selected ? `${t("menu.module")}: ${typeName(t, selected.typeId)}` : t(`menu.${menu}`);
  return (
    <nav aria-label={t("app.menus")} className="grid grid-cols-2 border-b border-stone-200 text-xs font-semibold">
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
          <span className="mr-1 text-stone-400">{"AB"[i]}</span>
          <span className="line-clamp-1">{menuLabel(menu)}</span>
        </button>
      ))}
    </nav>
  );
}

const DESKTOP_QUERY = "(min-width: 1024px)"; // Tailwind lg: the side-by-side layout

/** Whether the side-by-side (desktop) layout applies; false on the server and without matchMedia. */
function useDesktopLayout(): boolean {
  return useSyncExternalStore(
    (onChange) => {
      if (typeof window === "undefined" || !window.matchMedia) return () => {};
      const query = window.matchMedia(DESKTOP_QUERY);
      query.addEventListener("change", onChange);
      return () => query.removeEventListener("change", onChange);
    },
    () => typeof window !== "undefined" && !!window.matchMedia && window.matchMedia(DESKTOP_QUERY).matches,
    () => false,
  );
}

/** Panel icon (sidebar on the right): open = the panel can be closed, closed = it can be opened. */
function PanelIcon({ open }: { open: boolean }) {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <path d="M15 3v18" />
      <path d={open ? "m8 9 3 3-3 3" : "m10 15-3-3 3-3"} />
    </svg>
  );
}

/**
 * The always-visible header: "Konfigurator — Meble w Twoim pomieszczeniu", the language switch and
 * the menu toggle. Rendered at the top of the menu, or as a compact card over the 3D view when the
 * menu is collapsed.
 */
function AppHeader({ collapsed }: { collapsed: boolean }) {
  const t = useT();
  const setCollapsed = useArrangementStore((s) => s.setMenuCollapsed);
  return (
    <header className="flex items-start justify-between gap-3 px-6 py-4" data-app-header>
      <div>
        <p className="text-xs font-medium uppercase tracking-[0.12em] text-stone-500">{t("app.kicker")}</p>
        <h1 className="mt-0.5 text-xl font-semibold tracking-tight text-stone-900">{t("app.title")}</h1>
      </div>
      <div className="flex items-center gap-2">
        <LanguageSwitch />
        <button
          type="button"
          onClick={() => setCollapsed(!collapsed)}
          aria-expanded={!collapsed}
          aria-controls="main-menu-content"
          aria-label={t(collapsed ? "app.expandMenu" : "app.collapseMenu")}
          title={t(collapsed ? "app.expandMenu" : "app.collapseMenu")}
          data-menu-toggle
          className="rounded-lg border border-stone-200 p-1.5 text-stone-600 transition-colors hover:bg-stone-100 hover:text-stone-900 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-stone-800"
        >
          <PanelIcon open={!collapsed} />
        </button>
      </div>
    </header>
  );
}

/**
 * The room-based configurator: 3D view plus two menus that keep the levels apart —
 * A the complete furniture arrangement, B the selected module; the room settings open in their own
 * panel from the 3D view ("Wymiary pomieszczenia").
 */
export function RoomConfigurator() {
  const t = useT();
  useLocaleSync();
  const activeMenu = useArrangementStore((s) => s.activeMenu);
  const collapsed = useArrangementStore((s) => s.menuCollapsed);
  const desktop = useDesktopLayout();
  const arrangement = useArrangementStore((s) => s.arrangement);
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

  return (
    <div
      className={`relative flex flex-col bg-[#ecebe8] font-sans text-stone-900 lg:h-dvh lg:flex-row lg:overflow-hidden ${
        collapsed ? "h-dvh overflow-hidden" : "min-h-dvh"
      }`}
      data-menu-collapsed={collapsed}
    >
      {/*
        The 3D view takes all the space the menu releases (desktop: the menu's width; stacked layouts:
        everything below the header bar). The canvas follows its container (R3F resizes it and only
        updates the camera's aspect ratio; position and target stay).
      */}
      <section
        aria-label={t("app.preview")}
        data-3d-workspace
        className={`top-0 z-20 w-full overflow-hidden shadow-md lg:relative lg:z-auto lg:h-full lg:min-h-0 lg:min-w-0 lg:flex-1 lg:shrink lg:shadow-none ${
          collapsed ? "relative min-h-64 flex-1" : "sticky h-[45svh] min-h-64 shrink-0"
        }`}
      >
        <WebGLErrorBoundary>
          <RoomCanvas />
        </WebGLErrorBoundary>
        <WallLabelOverlay />
        <ViewOverlay />
        <DockingPrompt />
        <CollisionNotes />
        <FurnitureContextMenu />
        <p className="pointer-events-none absolute bottom-3 left-1/2 max-w-[calc(100%-2rem)] -translate-x-1/2 truncate rounded-full bg-white/80 px-3 py-1 text-xs text-stone-600 shadow-sm backdrop-blur">
          {t("app.sceneHint")}
        </p>
      </section>

      {/* Collapsed on desktop: only the header, as a card over the 3D view (no empty sidebar). */}
      {collapsed && desktop && (
        <div className="absolute right-3 top-3 z-30 rounded-xl border border-stone-200 bg-white/95 shadow-lg backdrop-blur" data-header-card>
          <AppHeader collapsed />
        </div>
      )}

      <aside
        className={`flex w-full shrink-0 flex-col overflow-hidden border-stone-200 bg-white transition-[width] duration-200 ease-out lg:h-full lg:border-l ${
          collapsed ? "border-t lg:w-0 lg:border-l-0" : "border-t lg:w-[420px] lg:border-t-0"
        }`}
      >
        {/* Collapsed on tablets and phones: the header bar stays below the 3D view. */}
        {!(collapsed && desktop) && (
          <div className="border-b border-stone-200 lg:min-w-[420px]">
            <AppHeader collapsed={collapsed} />
          </div>
        )}

        {/*
          The menu stays mounted while collapsed (hidden and inert): the selected tab, inputs being edited
          and the selection are exactly as they were when it is expanded again.
        */}
        <div id="main-menu-content" hidden={collapsed} inert={collapsed} className="flex min-h-0 flex-1 flex-col lg:min-w-[420px]">
        <MainMenu />

        <div className="flex-1 px-6 py-6 lg:overflow-y-auto">
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
        </div>
      </aside>
      {ordering && <OrderDialog onClose={() => setOrdering(false)} />}
    </div>
  );
}
