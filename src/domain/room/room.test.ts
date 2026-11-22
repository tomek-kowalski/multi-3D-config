import { describe, expect, it } from "vitest";
import { DEFAULT_ROOM } from "./defaults";
import { openingKeepFreeBox, wallFrame, wallPoint } from "./geometry";
import { addOpening, findFreeOpeningOffset, removeOpening, setFloorColor, setRoomDimension, setWallColor, updateOpening } from "./operations";
import type { RoomConfiguration } from "./types";
import { validateRoom } from "./validateRoom";

function unwrap<T>(r: { ok: true; value: T } | { ok: false; issues: readonly unknown[] }): T {
  if (!r.ok) throw new Error(JSON.stringify(r.issues));
  return r.value;
}

describe("room dimensions", () => {
  it("accepts whole-millimetre dimensions within the limits", () => {
    const room = unwrap(setRoomDimension(DEFAULT_ROOM, "width", 5230));
    expect(room.width).toBe(5230);
    expect(validateRoom(room)).toEqual([]);
  });

  it("rejects fractions, values out of range and non-numbers without changing the room", () => {
    for (const value of [3500.5, 999, 20001, Number.NaN]) {
      const result = setRoomDimension(DEFAULT_ROOM, "depth", value);
      expect(result.ok).toBe(false);
    }
    expect(DEFAULT_ROOM.depth).toBe(3500);
  });

  it("refuses a smaller room that would cut an opening off", () => {
    const { room } = unwrap(addOpening(DEFAULT_ROOM, "window", "back"));
    const result = setRoomDimension(room, "width", 1100);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues[0].code).toBe("opening_outside_wall");
  });
});

describe("wall and door colours", () => {
  it("sets each wall colour independently", () => {
    const room = unwrap(setWallColor(DEFAULT_ROOM, "left", "#8E9AA6"));
    expect(room.wallColors.left).toBe("#8E9AA6");
    expect(room.wallColors.back).toBe(DEFAULT_ROOM.wallColors.back);
  });

  it("validates colour values", () => {
    expect(setWallColor(DEFAULT_ROOM, "back", "red" as never).ok).toBe(false);
    expect(setFloorColor(DEFAULT_ROOM, "#123456").ok).toBe(true);
  });

  it("gives doors a colour and keeps windows colourless", () => {
    const withDoor = unwrap(addOpening(DEFAULT_ROOM, "door", "front"));
    const door = withDoor.room.openings[0];
    expect(door.color).toBe("#FFFFFF");
    const recoloured = unwrap(updateOpening(withDoor.room, door.id, { color: "#7A5A3F" }));
    expect(recoloured.openings[0].color).toBe("#7A5A3F");

    const withWindow = unwrap(addOpening(DEFAULT_ROOM, "window", "back"));
    expect(withWindow.room.openings[0].color).toBeUndefined();
    expect(updateOpening(withWindow.room, withWindow.id, { color: "#000000" }).ok).toBe(false);
  });
});

describe("openings", () => {
  it("adds an opening at the first free position from the wall's left end", () => {
    const { room, id } = unwrap(addOpening(DEFAULT_ROOM, "window", "back"));
    const window = room.openings.find((o) => o.id === id)!;
    expect(window).toMatchObject({ wall: "back", width: 1200, height: 1400, elevation: 900, offset: 0 });
  });

  it("finds free space beside existing openings without moving them", () => {
    const first = unwrap(addOpening(DEFAULT_ROOM, "window", "back"));
    const moved = unwrap(updateOpening(first.room, first.id, { offset: 500 })); // window-1: 500…1700
    const second = unwrap(addOpening(moved, "window", "back"));
    const byId = new Map(second.room.openings.map((o) => [o.id, o]));
    expect(byId.get("window-1")!.offset).toBe(500); // unchanged
    expect(byId.get("window-2")!.offset).toBe(1700); // first gap from the left that fits 1200 (0…500 is too small)
    // Remaining gaps 0…500 and 2900…4000 are both narrower than 1200 mm.
    expect(addOpening(second.room, "window", "back")).toMatchObject({ ok: false, issues: [{ code: "no_space_for_opening" }] });
  });

  it("never overlaps and stays inside the wall; reports a clear error when the wall is full", () => {
    let room: RoomConfiguration = DEFAULT_ROOM; // back wall 4000 mm → three 1200 mm windows fit
    for (let i = 0; i < 3; i++) room = unwrap(addOpening(room, "window", "back")).room;
    const offsets = room.openings.map((o) => [o.offset, o.offset + o.width]);
    expect(offsets).toEqual([
      [0, 1200],
      [1200, 2400],
      [2400, 3600],
    ]);
    expect(validateRoom(room)).toEqual([]);
    const full = addOpening(room, "window", "back");
    expect(full).toMatchObject({ ok: false, issues: [{ code: "no_space_for_opening", params: { kind: "window", wall: "A", width: 1200 } }] });
    expect(room.openings).toHaveLength(3);
  });

  it("only treats openings with an overlapping height range as blocking", () => {
    // A door (0…2050) blocks a window (900…2300) at the same place; a 1200 mm high door would not block a window from 1300 up.
    const door = unwrap(addOpening(DEFAULT_ROOM, "door", "back"));
    const window = unwrap(addOpening(door.room, "window", "back"));
    expect(window.room.openings.find((o) => o.id === window.id)!.offset).toBe(900);
    expect(findFreeOpeningOffset({ ...DEFAULT_ROOM, openings: [{ ...door.room.openings[0], height: 1200 }] }, "back", 1200, 1300, 1000)).toBe(0);
  });

  it("edits position and dimensions exactly", () => {
    const { room, id } = unwrap(addOpening(DEFAULT_ROOM, "window", "left"));
    const edited = unwrap(updateOpening(room, id, { offset: 250, elevation: 850, width: 900, height: 1200 }));
    expect(edited.openings[0]).toMatchObject({ offset: 250, elevation: 850, width: 900, height: 1200 });
  });

  it("keeps openings inside the wall and below the ceiling", () => {
    const { room, id } = unwrap(addOpening(DEFAULT_ROOM, "window", "back"));
    expect(updateOpening(room, id, { offset: 2900 }).ok).toBe(false); // 2900 + 1200 > 4000
    expect(updateOpening(room, id, { elevation: 1300 }).ok).toBe(false); // 1300 + 1400 > 2600
    expect(updateOpening(room, id, { offset: 2800 }).ok).toBe(true);
  });

  it("keeps rejecting overlaps when openings are edited by hand", () => {
    const first = unwrap(addOpening(DEFAULT_ROOM, "window", "back"));
    const second = unwrap(addOpening(first.room, "window", "back"));
    const result = updateOpening(second.room, second.id, { offset: 600 });
    expect(result).toMatchObject({ ok: false, issues: [{ code: "openings_overlap" }] });
    expect(addOpening(first.room, "window", "front").ok).toBe(true);
  });

  it("allows a window above a door-free stretch and removes openings", () => {
    const { room, id } = unwrap(addOpening(DEFAULT_ROOM, "door", "right"));
    expect(unwrap(removeOpening(room, id)).openings).toHaveLength(0);
    expect(removeOpening(room, "nope").ok).toBe(false);
  });
});

describe("room geometry", () => {
  const room: RoomConfiguration = { ...DEFAULT_ROOM, width: 4000, depth: 3000 };

  it("measures every wall from its left end seen from inside the room", () => {
    expect(wallPoint(wallFrame(room, "back"), 100, 0)).toEqual({ x: 100, z: 0 });
    expect(wallPoint(wallFrame(room, "right"), 100, 0)).toEqual({ x: 4000, z: 100 });
    expect(wallPoint(wallFrame(room, "front"), 100, 0)).toEqual({ x: 3900, z: 3000 });
    expect(wallPoint(wallFrame(room, "left"), 100, 0)).toEqual({ x: 0, z: 2900 });
  });

  it("builds the keep-free volume of an opening from its clearance", () => {
    const box = openingKeepFreeBox(room, {
      id: "door-1",
      kind: "door",
      wall: "left",
      offset: 500,
      elevation: 0,
      width: 900,
      height: 2050,
      clearanceDepth: 900,
    });
    const xs = box.corners.map((c) => c.x);
    const zs = box.corners.map((c) => c.z);
    expect([Math.min(...xs), Math.max(...xs)]).toEqual([0, 900]);
    expect([Math.min(...zs), Math.max(...zs)]).toEqual([1600, 2500]);
    expect([box.yMin, box.yMax]).toEqual([0, 2050]);
  });
});
