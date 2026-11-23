"use client";

import { useFrame, useThree } from "@react-three/fiber";
import { useEffect } from "react";
import { Vector3 } from "three";
import type { WallId } from "@/domain/room/types";
import { useT } from "@/i18n";
import { useArrangementStore } from "@/store/useArrangementStore";
import { wallLabels } from "./roomScene";

/**
 * Wall identifiers (the same names as in the menus) shown over the 3D view. The labels are DOM
 * buttons in an overlay above the canvas, so they stay readable from every camera angle; clicking one
 * selects that wall and opens its settings. Only the small labels themselves take pointer events, the
 * overlay around them lets every click and drag through to the 3D scene. `WallLabelProjector`, inside
 * the canvas, moves them to the projected wall positions on every rendered frame.
 */
const elements = new Map<WallId, HTMLElement>();

export function WallLabelOverlay() {
  const t = useT();
  const room = useArrangementStore((s) => s.arrangement.room);
  const activeWall = useArrangementStore((s) => s.activeWall);
  const visible = useArrangementStore((s) => s.showWallLabels);
  const setActiveWall = useArrangementStore((s) => s.setActiveWall);
  const openRoomPanel = useArrangementStore((s) => s.setRoomPanelOpen);
  if (!visible) return null;
  return (
    <div className="pointer-events-none absolute inset-0 overflow-hidden" data-wall-labels>
      {wallLabels(room, activeWall).map((label) => (
        <button
          type="button"
          key={label.wall}
          aria-pressed={label.active}
          aria-label={t("wallLabel.select", { wall: t(`wall.${label.wall}`) })}
          onClick={() => {
            setActiveWall(label.wall);
            openRoomPanel(true);
          }}
          ref={(el) => {
            if (el) elements.set(label.wall, el);
            else elements.delete(label.wall);
          }}
          data-wall-label={label.wall}
          data-active={label.active || undefined}
          style={{ visibility: "hidden" }}
          className={`pointer-events-auto absolute left-0 top-0 cursor-pointer select-none whitespace-nowrap rounded-full px-2.5 py-0.5 text-xs font-semibold shadow-sm transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-stone-900 ${
            label.active ? "z-10 bg-blue-600 text-white ring-2 ring-white" : "bg-white/90 text-stone-700 hover:bg-white hover:text-stone-900"
          }`}
        >
          {t(`wall.${label.wall}`)}
        </button>
      ))}
    </div>
  );
}

export function WallLabelProjector() {
  const room = useArrangementStore((s) => s.arrangement.room);
  const activeWall = useArrangementStore((s) => s.activeWall);
  const visible = useArrangementStore((s) => s.showWallLabels);
  const invalidate = useThree((s) => s.invalidate);
  // A room, selection or visibility change must reposition the labels even if the camera does not move.
  useEffect(() => invalidate(), [room, activeWall, visible, invalidate]);
  useFrame(({ camera, size }) => {
    const point = new Vector3();
    for (const label of wallLabels(room, activeWall)) {
      const el = elements.get(label.wall);
      if (!el) continue;
      point.set(label.position[0], label.position[1], label.position[2]).project(camera);
      const visible = point.z < 1 && Math.abs(point.x) <= 1.05 && Math.abs(point.y) <= 1.05;
      const x = ((point.x + 1) / 2) * size.width;
      const y = ((1 - point.y) / 2) * size.height;
      el.style.visibility = visible ? "visible" : "hidden";
      el.style.transform = `translate(${x}px, ${y}px) translate(-50%, -50%)`;
    }
  });
  return null;
}
