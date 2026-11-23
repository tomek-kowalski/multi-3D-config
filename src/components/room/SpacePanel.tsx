"use client";

import { useState } from "react";
import { SectionHeading } from "@/components/configurator/SectionHeading";
import { DOOR_COLOR_PRESETS, FLOOR_COLOR_PRESETS, ROOM_LIMITS, WALL_COLOR_PRESETS } from "@/domain/room/defaults";
import { openingsOnWall, wallLength } from "@/domain/room/geometry";
import { cmToMm, mmToCm, roomIssueInCm } from "@/domain/room/units";
import { WALL_IDS, WALL_LETTERS, type OpeningKind, type RoomOpening, type WallId } from "@/domain/room/types";
import type { Issue } from "@/domain/shared/issues";
import { useT } from "@/i18n";
import { useArrangementStore, type ActionResult } from "@/store/useArrangementStore";
import { buttonClass, Card, ColorField, dangerButtonClass, IssueList, MmField, SelectField } from "@/components/ui/fields";

const issuesOf = (r: ActionResult): readonly Issue[] => (r.ok ? [] : r.issues);

/**
 * The room dimension inputs, in centimetres (0.1 cm = 1 mm steps). Values are converted at this
 * boundary only: the room is stored and validated in whole millimetres by the unchanged room logic.
 */
export function RoomDimensions() {
  const t = useT();
  const room = useArrangementStore((s) => s.arrangement.room);
  const setDimension = useArrangementStore((s) => s.setRoomDimension);
  const commit = (key: "width" | "depth" | "height", cm: number): readonly Issue[] => {
    const mm = cmToMm(cm);
    if (mm === null) return [{ code: "room_precision_cm" }];
    return issuesOf(setDimension(key, mm)).map(roomIssueInCm);
  };
  return (
    <section aria-label={t("space.dimensions")} className="space-y-3">
      <div className="grid grid-cols-3 gap-2">
        {(["width", "depth", "height"] as const).map((key) => (
          <MmField
            key={key}
            label={t(`space.${key}`)}
            unit="cm"
            step={0.1}
            buttonStep={0.1}
            hint={`${mmToCm(ROOM_LIMITS[key].min)}–${mmToCm(ROOM_LIMITS[key].max)}`}
            min={mmToCm(ROOM_LIMITS[key].min)}
            max={mmToCm(ROOM_LIMITS[key].max)}
            value={mmToCm(room[key])}
            onCommit={(v) => commit(key, v)}
          />
        ))}
      </div>
      <p className="text-xs text-stone-500">{t("space.dimensionsHint")}</p>
    </section>
  );
}

/** Wall picker (A–D) and the wall-label switch. Selecting a wall here, in 3D or via a label is the same action. */
function WallPicker() {
  const t = useT();
  const activeWall = useArrangementStore((s) => s.activeWall);
  const setActiveWall = useArrangementStore((s) => s.setActiveWall);
  const showLabels = useArrangementStore((s) => s.showWallLabels);
  const setShowLabels = useArrangementStore((s) => s.setShowWallLabels);
  return (
    <section aria-labelledby="room-walls" className="space-y-3">
      <SectionHeading id="room-walls">{t("space.walls")}</SectionHeading>
      <div role="group" aria-label={t("space.walls")} className="grid grid-cols-4 gap-1.5">
        {WALL_IDS.map((wall) => {
          const active = wall === activeWall;
          return (
            <button
              key={wall}
              type="button"
              data-wall-card={wall}
              data-active={active || undefined}
              aria-pressed={active}
              title={t(`wall.${wall}`)}
              onClick={() => setActiveWall(wall)}
              className={`flex flex-col items-center gap-0.5 rounded-lg border-2 px-1 py-1.5 text-xs transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-stone-900 ${
                active ? "border-blue-600 bg-blue-50 font-semibold text-blue-900" : "border-stone-200 text-stone-700 hover:bg-stone-50"
              }`}
            >
              <span className={`flex size-6 items-center justify-center rounded-full ${active ? "bg-blue-600 text-white" : "bg-stone-200"}`}>
                {WALL_LETTERS[wall]}
              </span>
              {t(`wall.short.${wall}`)}
            </button>
          );
        })}
      </div>
      <label className="flex cursor-pointer items-center gap-2 text-sm text-stone-700">
        <input
          type="checkbox"
          className="size-4 accent-stone-900"
          checked={showLabels}
          onChange={(e) => setShowLabels(e.target.checked)}
        />
        {t("space.showWallLabels")}
      </label>
      <p className="text-xs text-stone-500">{t("space.wallsHint")}</p>
    </section>
  );
}

function OpeningCard({ opening }: { opening: RoomOpening }) {
  const t = useT();
  const room = useArrangementStore((s) => s.arrangement.room);
  const selected = useArrangementStore((s) => s.selectedOpeningId === opening.id);
  const update = useArrangementStore((s) => s.updateOpening);
  const remove = useArrangementStore((s) => s.removeOpening);
  const select = useArrangementStore((s) => s.selectOpening);
  const [wallIssues, setWallIssues] = useState<readonly Issue[]>([]);
  const length = wallLength(room, opening.wall);
  const limits = ROOM_LIMITS.opening;
  // Ranges in which the opening stays inside its wall and below the ceiling (validation still decides).
  const ranges = {
    offset: { min: 0, max: length - opening.width },
    elevation: { min: 0, max: room.height - opening.height },
    width: { min: limits.width.min, max: Math.min(limits.width.max, length - opening.offset) },
    height: { min: limits.height.min, max: Math.min(limits.height.max, room.height - opening.elevation) },
    clearanceDepth: limits.clearanceDepth,
  } as const;
  const field = (key: keyof typeof ranges, hint?: string) => (
    <MmField
      label={t(`opening.${key}`)}
      hint={hint}
      value={opening[key]}
      min={ranges[key].min}
      max={ranges[key].max}
      onCommit={(v) => issuesOf(update(opening.id, { [key]: v }))}
    />
  );
  return (
    <Card selected={selected}>
      <div className="flex items-center justify-between gap-2">
        <button type="button" onClick={() => select(selected ? null : opening.id)} className="text-left text-sm font-semibold text-stone-900 hover:underline">
          {t(opening.kind === "door" ? "opening.door" : "opening.window")} <span className="font-normal text-stone-500">· {opening.id}</span>
        </button>
        <button type="button" onClick={() => remove(opening.id)} className={`${dangerButtonClass} px-2 py-1 text-xs`}>
          {t("common.remove")}
        </button>
      </div>
      <SelectField<WallId>
        label={t("opening.wall")}
        value={opening.wall}
        options={WALL_IDS.map((w) => ({ value: w, label: t(`wall.${w}`) }))}
        onChange={(wall) => setWallIssues(issuesOf(update(opening.id, { wall })))}
      />
      <IssueList issues={wallIssues} />
      <div className="grid grid-cols-2 gap-2">
        {field("offset", `0–${length - opening.width}`)}
        {field("elevation", `0–${room.height - opening.height}`)}
        {field("width")}
        {field("height")}
      </div>
      {field("clearanceDepth", `${ROOM_LIMITS.opening.clearanceDepth.min}–${ROOM_LIMITS.opening.clearanceDepth.max}`)}
      <p className="text-xs text-stone-500">{t(opening.kind === "door" ? "opening.clearanceHintDoor" : "opening.clearanceHintWindow")}</p>
      {opening.kind === "door" && (
        <ColorField label={t("opening.doorColor")} value={opening.color ?? "#FFFFFF"} presets={DOOR_COLOR_PRESETS} onChange={(color) => update(opening.id, { color })} />
      )}
    </Card>
  );
}

/** Settings of the active wall: its colour, adding windows/doors, and only the openings on this wall. */
function ActiveWallSettings() {
  const t = useT();
  const room = useArrangementStore((s) => s.arrangement.room);
  const wall = useArrangementStore((s) => s.activeWall);
  const add = useArrangementStore((s) => s.addOpening);
  const setWallColor = useArrangementStore((s) => s.setWallColor);
  const [issues, setIssues] = useState<readonly Issue[]>([]);
  // A message about a previous wall must not stay visible after switching walls.
  const [issuesWall, setIssuesWall] = useState<WallId>(wall);
  const openings = openingsOnWall(room, wall);
  const addKind = (kind: OpeningKind) => {
    setIssuesWall(wall);
    setIssues(issuesOf(add(kind, wall)));
  };
  return (
    <section aria-labelledby="active-wall" data-active-wall={wall} className="space-y-4 rounded-xl border border-blue-200 bg-blue-50/30 p-3">
      <h2 id="active-wall" className="text-sm font-semibold text-stone-900">
        {t(`wall.${wall}`)}
      </h2>
      <ColorField label={t("space.wallColor")} value={room.wallColors[wall]} presets={WALL_COLOR_PRESETS} onChange={(c) => setWallColor(wall, c)} />
      <div className="space-y-2">
        <p className="text-sm font-medium text-stone-800">{t("space.openings")}</p>
        <div className="grid grid-cols-2 gap-2">
          <button type="button" className={buttonClass} onClick={() => addKind("window")}>
            + {t("opening.window")}
          </button>
          <button type="button" className={buttonClass} onClick={() => addKind("door")}>
            + {t("opening.door")}
          </button>
        </div>
        {issuesWall === wall && <IssueList issues={issues} />}
      </div>
      {openings.length > 0 && (
        <div className="space-y-3" data-openings-for={wall}>
          <p className="text-xs text-stone-500">{t("space.openingsHint")}</p>
          {openings.map((o) => (
            <OpeningCard key={o.id} opening={o} />
          ))}
        </div>
      )}
    </section>
  );
}

function FloorColor() {
  const t = useT();
  const floorColor = useArrangementStore((s) => s.arrangement.room.floorColor);
  const setFloorColor = useArrangementStore((s) => s.setFloorColor);
  return (
    <section aria-labelledby="room-floor" className="space-y-3">
      <SectionHeading id="room-floor">{t("space.floor")}</SectionHeading>
      <ColorField label={t("space.floor")} value={floorColor} presets={FLOOR_COLOR_PRESETS} onChange={setFloorColor} />
    </section>
  );
}

/**
 * Menu A — the room: a spatial reference for placing furniture, not an architectural model. The room
 * dimensions are edited in their own panel (see RoomDimensionsPanel).
 */
export function SpacePanel() {
  return (
    <div className="space-y-6">
      <WallPicker />
      <ActiveWallSettings />
      <FloorColor />
    </div>
  );
}
