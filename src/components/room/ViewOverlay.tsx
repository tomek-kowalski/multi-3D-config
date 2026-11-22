"use client";

import Image from "next/image";
import { useState } from "react";
import { useT } from "@/i18n";
import { useArrangementStore } from "@/store/useArrangementStore";
import { buttonClass, primaryButtonClass } from "@/components/ui/fields";
import { RoomDimensions } from "./SpacePanel";

/** Logo asset, used unmodified (270 × 300 px); displayed at a responsive height, width from its ratio. */
export const LOGO_SRC = "/img/clickbed_logo_01.png";
const LOGO_WIDTH = 270;
const LOGO_HEIGHT = 300;

const overlayButton =
  "rounded-lg bg-white/90 px-3 py-1.5 text-xs font-medium text-stone-800 shadow-sm backdrop-blur transition-colors hover:bg-white disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-stone-800";

/**
 * Room dimensions in their own panel at the top centre of the application. It shows the regular
 * dimension inputs (same store, same validation); closing it keeps every applied value.
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
      className="fixed left-1/2 top-24 z-40 w-[min(34rem,calc(100vw-2rem))] -translate-x-1/2 rounded-2xl border border-stone-200 bg-white p-5 shadow-xl"
    >
      <div className="mb-3 flex items-center justify-between gap-3">
        <h2 id="room-panel-title" className="text-base font-semibold text-stone-900">
          {t("view.roomDimensions")}
        </h2>
        <button type="button" onClick={onClose} className={`${buttonClass} px-3 py-1.5 text-xs`}>
          ✕ {t("roomPanel.close")}
        </button>
      </div>
      <RoomDimensions />
    </div>
  );
}

/** Logo (top left) and view controls (top right, with the room-dimensions button beneath). */
export function ViewOverlay() {
  const t = useT();
  const requestView = useArrangementStore((s) => s.requestView);
  const hasSelection = useArrangementStore((s) => s.selectedModuleId !== null);
  const [roomPanelOpen, setRoomPanelOpen] = useState(false);
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
          onClick={() => setRoomPanelOpen((open) => !open)}
        >
          {t("view.roomDimensions")}
        </button>
      </div>
      {roomPanelOpen && <RoomDimensionsPanel onClose={() => setRoomPanelOpen(false)} />}
    </>
  );
}

/** Asks the customer to confirm a proposed cabinet docking position (previewed in 3D). */
export function DockingPrompt() {
  const t = useT();
  const proposal = useArrangementStore((s) => s.dockingProposal);
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
          module: proposal.moduleId,
          target: proposal.targetId,
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
