"use client";

import Image from "next/image";
import { useState } from "react";
import { useT } from "@/i18n";
import { useArrangementStore } from "@/store/useArrangementStore";
import { buttonClass, primaryButtonClass } from "@/components/ui/fields";
import { typeName } from "./ArrangementPanel";
import { PhotoPreview } from "./PhotoPreview";
import { RoomDimensions, SpacePanel } from "./SpacePanel";

/** Logo asset, used unmodified (270 × 300 px); displayed at a responsive height, width from its ratio. */
export const LOGO_SRC = "/img/clickbed_logo_01.png";
const LOGO_WIDTH = 270;
const LOGO_HEIGHT = 300;

const overlayButton =
  "rounded-lg bg-white/90 px-3 py-1.5 text-xs font-medium text-stone-800 shadow-sm backdrop-blur transition-colors hover:bg-white disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-stone-800";

/**
 * The room panel at the top centre of the application: room dimensions plus every space setting
 * (walls and their colours, windows and doors, wall labels, floor). It renders the regular controls
 * (same store, same validation); closing it keeps every applied value. It scrolls when its content is
 * taller than the screen.
 */
export function RoomDimensionsPanel({ onClose }: { onClose: () => void }) {
  const t = useT();
  return (
    <div
      role="dialog"
      aria-modal="false"
      aria-labelledby="room-panel-title"
      data-room-dimensions-panel
      // Top centre of the viewport, below the canvas buttons; never wider than the screen.
      className="fixed left-1/2 top-24 z-40 flex max-h-[calc(100dvh-7rem)] w-[min(36rem,calc(100vw-2rem))] -translate-x-1/2 flex-col rounded-2xl border border-stone-200 bg-white shadow-xl"
    >
      <div className="flex shrink-0 items-center justify-between gap-3 border-b border-stone-200 px-5 py-3">
        <h2 id="room-panel-title" className="text-base font-semibold text-stone-900">
          {t("view.roomDimensions")}
        </h2>
        <button type="button" onClick={onClose} className={`${buttonClass} px-3 py-1.5 text-xs`}>
          ✕ {t("roomPanel.close")}
        </button>
      </div>
      <div className="space-y-6 overflow-y-auto px-5 py-4" data-room-panel-body>
        <RoomDimensions />
        <SpacePanel />
      </div>
    </div>
  );
}

/** Logo (top left) and view controls (top right, with the room-dimensions button beneath). */
export function ViewOverlay() {
  const t = useT();
  const requestView = useArrangementStore((s) => s.requestView);
  const hasSelection = useArrangementStore((s) => s.selectedModuleId !== null);
  const roomPanelOpen = useArrangementStore((s) => s.roomPanelOpen);
  const setRoomPanelOpen = useArrangementStore((s) => s.setRoomPanelOpen);
  const [photoOpen, setPhotoOpen] = useState(false);
  return (
    <>
      <div className="pointer-events-none absolute left-3 top-3 z-10">
        <Image
          src={LOGO_SRC}
          alt={t("app.logoAlt")}
          width={LOGO_WIDTH}
          height={LOGO_HEIGHT}
          priority
          className="h-10 w-auto drop-shadow-sm sm:h-14 lg:h-16"
        />
      </div>
      <div className="absolute right-3 top-3 z-10 flex flex-col items-end gap-2" data-view-controls>
        <div className="flex gap-2">
          <button type="button" className={overlayButton} onClick={() => requestView("room")}>
            {t("view.room")}
          </button>
          <button type="button" className={overlayButton} disabled={!hasSelection} onClick={() => requestView("selection")}>
            {t("view.selection")}
          </button>
        </div>
        <button
          type="button"
          className={overlayButton}
          aria-expanded={roomPanelOpen}
          aria-haspopup="dialog"
          onClick={() => setRoomPanelOpen(!roomPanelOpen)}
        >
          {t("view.roomDimensions")}
        </button>
        <button type="button" className={overlayButton} aria-haspopup="dialog" data-render-image onClick={() => setPhotoOpen(true)}>
          {t("photo.button")}
        </button>
      </div>
      {roomPanelOpen && <RoomDimensionsPanel onClose={() => setRoomPanelOpen(false)} />}
      {photoOpen && <PhotoPreview onClose={() => setPhotoOpen(false)} />}
    </>
  );
}

/** Asks the customer to confirm a proposed docking position (previewed in 3D). */
export function DockingPrompt() {
  const t = useT();
  const proposal = useArrangementStore((s) => s.dockingProposal);
  const modules = useArrangementStore((s) => s.arrangement.modules);
  const describe = (id: string) => {
    const module_ = modules.find((m) => m.id === id);
    return module_ ? `${typeName(t, module_.typeId)} (${id})` : id;
  };
  const confirm = useArrangementStore((s) => s.confirmDocking);
  const reject = useArrangementStore((s) => s.rejectDocking);
  if (!proposal) return null;
  return (
    <div
      role="alertdialog"
      aria-labelledby="docking-prompt"
      data-docking-prompt
      className="absolute bottom-12 left-1/2 z-20 flex w-[min(30rem,calc(100%-2rem))] -translate-x-1/2 flex-wrap items-center justify-between gap-3 rounded-xl border border-emerald-300 bg-white/95 px-4 py-3 shadow-lg backdrop-blur"
    >
      <p id="docking-prompt" className="text-sm text-stone-800">
        {t("docking.prompt", {
          module: describe(proposal.moduleId),
          target: describe(proposal.targetId),
          side: t(proposal.side === "left" ? "docking.left" : "docking.right"),
        })}
      </p>
      <div className="flex gap-2">
        <button type="button" className={`${buttonClass} px-3 py-1.5 text-xs`} onClick={reject}>
          {t("docking.reject")}
        </button>
        <button type="button" className={`${primaryButtonClass} px-3 py-1.5 text-xs`} onClick={() => confirm()}>
          {t("docking.confirm")}
        </button>
      </div>
    </div>
  );
}
