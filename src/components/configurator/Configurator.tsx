"use client";

import dynamic from "next/dynamic";
import { useConfiguratorStore } from "@/store/useConfiguratorStore";
import { ConfiguratorSidebar } from "./ConfiguratorSidebar";
import { useLocaleSync, useT } from "@/i18n";

function LoadingPreview() {
  const t = useT();
  return <div className="flex h-full items-center justify-center text-sm text-stone-500">{t("app.loading3d")}</div>;
}

// WebGL needs the browser, so the canvas is never prerendered on the server.
import { WebGLErrorBoundary } from "@/components/three/WebGLErrorBoundary";

const FurnitureCanvas = dynamic(
  () => import("@/components/three/FurnitureCanvas").then((mod) => mod.FurnitureCanvas),
  {
    ssr: false,
    loading: () => <LoadingPreview />,
  },
);

function ViewControls() {
  const t = useT();
  const requestView = useConfiguratorStore((state) => state.requestView);
  const buttonClass =
    "rounded-lg bg-white/90 px-3 py-1.5 text-xs font-medium text-stone-800 shadow-sm backdrop-blur transition-colors hover:bg-white focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-stone-800";

  return (
    <div className="absolute right-3 top-3 flex gap-2">
      <button type="button" onClick={() => requestView("fit")} className={buttonClass}>
        {t("cab.fitView")}
      </button>
      <button type="button" onClick={() => requestView("reset")} className={buttonClass}>
        {t("cab.resetView")}
      </button>
    </div>
  );
}

export function Configurator() {
  const t = useT();
  useLocaleSync();
  return (
    // No `flex-1` here: a 0% flex-basis would override `lg:h-dvh`, and since <body> only has a
    // min-height, the flexed height is not definite and the viewer's `h-full` collapses to `auto`.
    // On desktop the root is exactly one viewport tall; the sidebar scrolls on its own.
    <div className="flex min-h-dvh flex-col bg-[#ecebe8] font-sans text-stone-900 lg:h-dvh lg:flex-row lg:overflow-hidden">
      {/*
        Mobile: the viewer stays pinned to the top while the page (the controls) scrolls below it,
        so every change is visible immediately. Desktop: it fills the left column as before.
        min-w-0 lets the viewer shrink below the canvas' current pixel width when the window narrows.
      */}
      <section
        aria-label={t("app.preview")}
        className="sticky top-0 z-20 h-[45svh] min-h-64 w-full shrink-0 overflow-hidden shadow-md lg:relative lg:z-auto lg:h-full lg:min-h-0 lg:min-w-0 lg:flex-1 lg:shrink lg:shadow-none"
      >
        <WebGLErrorBoundary>
          <FurnitureCanvas />
        </WebGLErrorBoundary>
        <ViewControls />
        <p className="pointer-events-none absolute bottom-3 left-1/2 max-w-[calc(100%-2rem)] -translate-x-1/2 truncate rounded-full bg-white/80 px-3 py-1 text-xs text-stone-600 shadow-sm backdrop-blur">
          {t("cab.sceneHint")}
        </p>
      </section>
      <ConfiguratorSidebar />
    </div>
  );
}
