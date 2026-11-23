"use client";

import Image from "next/image";
import { useMemo, useState } from "react";
import { detectCollisions } from "@/domain/arrangement/collisions";
import { useT } from "@/i18n";
import { useArrangementStore } from "@/store/useArrangementStore";
import { buttonClass, primaryButtonClass } from "@/components/ui/fields";
import { describeCollision, typeName } from "./ArrangementPanel";
import { prewarmPhotoRenderer } from "@/components/three/photo/photoService";
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
  // With the menu collapsed, its header card sits in the top-right corner (desktop): the controls go below it.
  const menuCollapsed = useArrangementStore((s) => s.menuCollapsed);
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
      <div className={`absolute right-3 z-10 flex flex-col items-end gap-2 ${menuCollapsed ? "top-3 lg:top-24" : "top-3"}`} data-view-controls>
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
        <button
          type="button"
          className={overlayButton}
          aria-haspopup="dialog"
          data-render-image
          // Prepare the renderer while the pointer is on its way to the click.
          onPointerEnter={prewarmPhotoRenderer}
          onFocus={prewarmPhotoRenderer}
          onClick={() => setPhotoOpen(true)}
        >
          {t("photo.button")}
        </button>
      </div>
      {roomPanelOpen && <RoomDimensionsPanel onClose={() => setRoomPanelOpen(false)} />}
      {photoOpen && <PhotoPreview onClose={() => setPhotoOpen(false)} />}
    </>
  );
}

const MAX_COLLISION_NOTES = 3;

/**
 * Why furniture is outlined in red: the conflicting module or obstacle, in the menu's wording. Shown
 * while a conflict exists (the outline and this note disappear together when it is resolved).
 */
export function CollisionNotes() {
  const t = useT();
  const arrangement = useArrangementStore((s) => s.arrangement);
  const lines = useMemo(() => {
    const seen = new Set<string>();
    const label = (id: string) => {
      const m = arrangement.modules.find((x) => x.id === id);
      return m ? `${typeName(t, m.typeId)} (${id})` : id;
    };
    for (const issue of detectCollisions(arrangement)) seen.add(describeCollision(t, issue, arrangement.modules, issue.moduleId, label));
    return [...seen];
  }, [arrangement, t]);
  if (lines.length === 0) return null;
  return (
    <div
      role="status"
      data-collision-notes
      className="pointer-events-none absolute bottom-12 left-3 z-10 max-w-[min(26rem,calc(100%-1.5rem))] rounded-lg border border-red-200 bg-white/95 px-3 py-2 text-xs text-red-800 shadow-sm backdrop-blur"
    >
      <ul className="space-y-0.5">
        {lines.slice(0, MAX_COLLISION_NOTES).map((line) => (
          <li key={line}>⚠ {line}</li>
        ))}
        {lines.length > MAX_COLLISION_NOTES && <li>{t("collision.more", { count: lines.length - MAX_COLLISION_NOTES })}</li>}
      </ul>
    </div>
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
  // While dragging the position is only previewed in 3D; the question comes once, on drop.
  const dragging = useArrangementStore((s) => s.draggingModuleId !== null);
  if (!proposal || dragging) return null;
  const side = t(proposal.side === "left" ? "docking.left" : "docking.right");
  const names = { module: describe(proposal.moduleId), target: describe(proposal.targetId), side };
  const invalid = proposal.verdict === "invalid";
  // Why it cannot dock (invalid) or what docking would block (warning), in the menu's collision wording.
  const reasons = proposal.issues.map((issue) => describeCollision(t, issue, modules, proposal.moduleId, describe));
  return (
    <div
      role="alertdialog"
      aria-labelledby="docking-prompt"
      data-docking-prompt
      data-docking-verdict={proposal.verdict}
      className={`absolute bottom-12 left-1/2 z-20 flex w-[min(32rem,calc(100%-2rem))] -translate-x-1/2 flex-wrap items-center justify-between gap-3 rounded-xl border bg-white/95 px-4 py-3 shadow-lg backdrop-blur ${
        invalid ? "border-red-300" : proposal.verdict === "warning" ? "border-amber-300" : "border-emerald-300"
      }`}
    >
      <div id="docking-prompt" className="space-y-1 text-sm text-stone-800">
        <p>{t(invalid ? "docking.invalid" : "docking.prompt", names)}</p>
        {proposal.verdict === "warning" && <p className="text-xs text-amber-800">{t("docking.warning")}</p>}
        {reasons.length > 0 && (
          <ul className={`list-disc pl-4 text-xs ${invalid ? "text-red-700" : "text-amber-800"}`}>
            {reasons.map((r) => (
              <li key={r}>{r}</li>
            ))}
          </ul>
        )}
      </div>
      <div className="flex gap-2">
        {invalid ? (
          <button type="button" className={`${buttonClass} px-3 py-1.5 text-xs`} onClick={reject}>
            {t("docking.close")}
          </button>
        ) : (
          <>
            <button type="button" className={`${buttonClass} px-3 py-1.5 text-xs`} onClick={reject}>
              {t("docking.reject")}
            </button>
            <button type="button" className={`${primaryButtonClass} px-3 py-1.5 text-xs`} onClick={() => confirm()}>
              {t("docking.confirm")}
            </button>
          </>
        )}
      </div>
    </div>
  );
}
