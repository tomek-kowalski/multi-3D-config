"use client";

import { useState } from "react";
import { SectionHeading } from "@/components/configurator/SectionHeading";
import { DOOR_COLOR_PRESETS, FLOOR_COLOR_PRESETS, ROOM_LIMITS, WALL_COLOR_PRESETS } from "@/domain/room/defaults";
import { wallLength } from "@/domain/room/geometry";
import { WALL_IDS, type OpeningKind, type RoomOpening, type WallId } from "@/domain/room/types";
import type { Issue } from "@/domain/shared/issues";
import { useT } from "@/i18n";
import { useArrangementStore, type ActionResult } from "@/store/useArrangementStore";
import { buttonClass, Card, ColorField, dangerButtonClass, IssueList, MmField, SelectField } from "@/components/ui/fields";

const issuesOf = (r: ActionResult): readonly Issue[] => (r.ok ? [] : r.issues);

function RoomDimensions() {
  const t = useT();
  const room = useArrangementStore((s) => s.arrangement.room);
  const setDimension = useArrangementStore((s) => s.setRoomDimension);
  return (
    <section aria-labelledby="room-dims" className="space-y-3">
      <SectionHeading id="room-dims">{t("space.dimensions")}</SectionHeading>
      <div className="grid grid-cols-3 gap-2">
        {(["width", "depth", "height"] as const).map((key) => (
          <MmField
            key={key}
            label={t(`space.${key}`)}
            hint={`${ROOM_LIMITS[key].min}–${ROOM_LIMITS[key].max}`}
            value={room[key]}
            onCommit={(v) => issuesOf(setDimension(key, v))}
          />
        ))}
      </div>
      <p className="text-xs text-stone-500">{t("space.dimensionsHint")}</p>
    </section>
  );
}

function RoomColors() {
  const t = useT();
  const room = useArrangementStore((s) => s.arrangement.room);
  const setWallColor = useArrangementStore((s) => s.setWallColor);
  const setFloorColor = useArrangementStore((s) => s.setFloorColor);
  return (
    <section aria-labelledby="room-colors" className="space-y-4">
      <SectionHeading id="room-colors">{t("space.colors")}</SectionHeading>
      {WALL_IDS.map((wall) => (
        <ColorField key={wall} label={t(`wall.${wall}`)} value={room.wallColors[wall]} presets={WALL_COLOR_PRESETS} onChange={(c) => setWallColor(wall, c)} />
      ))}
      <ColorField label={t("space.floor")} value={room.floorColor} presets={FLOOR_COLOR_PRESETS} onChange={setFloorColor} />
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
  const field = (key: "offset" | "elevation" | "width" | "height" | "clearanceDepth", hint?: string) => (
    <MmField label={t(`opening.${key}`)} hint={hint} value={opening[key]} onCommit={(v) => issuesOf(update(opening.id, { [key]: v }))} />
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

function Openings() {
  const t = useT();
  const openings = useArrangementStore((s) => s.arrangement.room.openings);
  const add = useArrangementStore((s) => s.addOpening);
  const [wall, setWall] = useState<WallId>("back");
  const [issues, setIssues] = useState<readonly Issue[]>([]);
  const addKind = (kind: OpeningKind) => setIssues(issuesOf(add(kind, wall)));
  return (
    <section aria-labelledby="room-openings" className="space-y-3">
      <SectionHeading id="room-openings">{t("space.openings")}</SectionHeading>
      <p className="text-xs text-stone-500">{t("space.openingsHint")}</p>
      <div className="grid grid-cols-[1fr_auto_auto] items-end gap-2">
        <SelectField<WallId> label={t("opening.wall")} value={wall} options={WALL_IDS.map((w) => ({ value: w, label: t(`wall.${w}`) }))} onChange={setWall} />
        <button type="button" className={buttonClass} onClick={() => addKind("window")}>
          + {t("opening.window")}
        </button>
        <button type="button" className={buttonClass} onClick={() => addKind("door")}>
          + {t("opening.door")}
        </button>
      </div>
      <IssueList issues={issues} />
      {openings.length === 0 ? (
        <p className="rounded-lg border border-dashed border-stone-300 px-3 py-4 text-center text-xs text-stone-500">{t("space.noOpenings")}</p>
      ) : (
        <div className="space-y-3">
          {openings.map((o) => (
            <OpeningCard key={o.id} opening={o} />
          ))}
        </div>
      )}
    </section>
  );
}

/** Menu A — the room: a spatial reference for placing furniture, not an architectural model. */
export function SpacePanel() {
  return (
    <div className="space-y-8">
      <RoomDimensions />
      <Openings />
      <RoomColors />
    </div>
  );
}
