import { describe, expect, it } from "vitest";
import type { Arrangement } from "../arrangement/types";
import { exportArrangementJson, importArrangementJson } from "../serialization/arrangementJson";
import { DEFAULT_ROOM } from "./defaults";
import { setFloor, setFloorColor, setRoomDimension } from "./operations";
import type { RoomConfiguration } from "./types";
import { isRoomFloor, validateRoom } from "./validateRoom";

const unwrap = <T,>(r: { ok: true; value: T } | { ok: false; issues: readonly unknown[] }): T => {
  if (!r.ok) throw new Error(JSON.stringify(r.issues));
  return r.value;
};

const arrangement = (room: RoomConfiguration): Arrangement => ({ room, modules: [] });

describe("floor material selection (Phase 4B)", () => {
  it("a room without the field is a colour floor (every room saved before floor materials)", () => {
    expect(DEFAULT_ROOM.floor).toBeUndefined();
    expect(validateRoom(DEFAULT_ROOM)).toEqual([]);
  });

  it("selects a material with its plank axis, keeps the floor colour, and returns to the colour floor", () => {
    const colored = unwrap(setFloorColor(DEFAULT_ROOM, "#8A6A4A"));
    const parquet = unwrap(setFloor(colored, { kind: "material", materialId: "herringbone-parquet", plankAxis: "z" }));
    expect(parquet.floor).toEqual({ kind: "material", materialId: "herringbone-parquet", plankAxis: "z" });
    expect(parquet.floorColor).toBe("#8A6A4A");
    const back = unwrap(setFloor(parquet, { kind: "color" }));
    expect(back).toEqual(colored); // the field is removed: identical to a room that never had a material
    expect("floor" in back).toBe(false);
  });

  it("rejects floors this version does not offer (no guessing of unknown materials or axes)", () => {
    for (const floor of [
      { kind: "material", materialId: "vinyl", plankAxis: "x" },
      { kind: "material", materialId: "laminate", plankAxis: "y" },
      { kind: "material", materialId: "laminate" },
      { kind: "tiles" },
      { kind: "color", extra: 1 },
      null,
    ]) {
      expect(isRoomFloor(floor)).toBe(false);
      expect(validateRoom({ ...DEFAULT_ROOM, floor: floor as never }).map((i) => i.code)).toContain("invalid_floor");
    }
    expect(isRoomFloor({ kind: "color" })).toBe(true);
  });

  it("the material survives room resizing (the pattern is anchored in the renderer, the selection in the room)", () => {
    const room = unwrap(setFloor(DEFAULT_ROOM, { kind: "material", materialId: "wood-planks", plankAxis: "x" }));
    const resized = unwrap(setRoomDimension(room, "width", room.width + 1000));
    expect(resized.floor).toEqual(room.floor);
  });

  it("arrangement JSON: round trip of a floor material; colour-floor documents are unchanged byte for byte", () => {
    const plain = exportArrangementJson(arrangement(DEFAULT_ROOM));
    expect(plain).not.toContain('"floor"');
    expect(exportArrangementJson(unwrap(importArrangementJson(plain)))).toBe(plain);

    const room = unwrap(setFloor(DEFAULT_ROOM, { kind: "material", materialId: "laminate", plankAxis: "z" }));
    const json = exportArrangementJson(arrangement(room));
    const loaded = unwrap(importArrangementJson(json));
    expect(loaded.room.floor).toEqual({ kind: "material", materialId: "laminate", plankAxis: "z" });
    expect(exportArrangementJson(loaded)).toBe(json);
  });

  it("arrangement JSON: an unknown floor value is rejected instead of being silently dropped", () => {
    const doc = JSON.parse(exportArrangementJson(arrangement(DEFAULT_ROOM)));
    doc.room.floor = { kind: "material", materialId: "marble", plankAxis: "x" };
    const result = importArrangementJson(JSON.stringify(doc));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues.map((i) => i.code)).toContain("invalid_floor");
  });
});
