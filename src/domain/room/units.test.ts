import { describe, expect, it } from "vitest";
import { addModule } from "../arrangement/operations";
import { exportArrangementJson, importArrangementJson } from "../serialization/arrangementJson";
import { DEFAULT_ROOM, ROOM_LIMITS } from "./defaults";
import { setRoomDimension } from "./operations";
import { cmToMm, mmToCm, roomIssueInCm } from "./units";

describe("room dimensions in centimetres (UI boundary only)", () => {
  it("converts stored millimetres to centimetres and back exactly", () => {
    expect(mmToCm(4009)).toBe(400.9);
    expect(mmToCm(3500)).toBe(350);
    expect(mmToCm(2600)).toBe(260);
    expect(cmToMm(400.9)).toBe(4009);
    expect(cmToMm(350)).toBe(3500);
    expect(cmToMm(0.1)).toBe(1);
    for (let mm = 1000; mm <= 1100; mm++) expect(cmToMm(mmToCm(mm))).toBe(mm);
  });

  it("rejects values finer than 0.1 cm and non-numbers instead of rounding", () => {
    expect(cmToMm(350.75)).toBeNull();
    expect(cmToMm(Number.NaN)).toBeNaN();
  });

  it("shows the unchanged physical limits in centimetres", () => {
    expect([mmToCm(ROOM_LIMITS.width.min), mmToCm(ROOM_LIMITS.width.max)]).toEqual([100, 2000]);
    expect([mmToCm(ROOM_LIMITS.depth.min), mmToCm(ROOM_LIMITS.depth.max)]).toEqual([100, 2000]);
    expect([mmToCm(ROOM_LIMITS.height.min), mmToCm(ROOM_LIMITS.height.max)]).toEqual([180, 600]);
    expect(ROOM_LIMITS.width).toEqual({ min: 1000, max: 20000 }); // stored limits stay in mm
    const issue = setRoomDimension(DEFAULT_ROOM, "width", 500);
    expect(issue.ok).toBe(false);
    if (!issue.ok) expect(roomIssueInCm(issue.issues[0])).toEqual({ code: "below_minimum_cm", path: "width", params: { min: 100 } });
  });

  it("keeps the room geometry, furniture and saved files in millimetres", () => {
    const room = setRoomDimension(DEFAULT_ROOM, "width", cmToMm(400.9)!);
    expect(room.ok && room.value.width).toBe(4009);
    const added = addModule({ room: DEFAULT_ROOM, modules: [] }, "cabinet");
    if (!added.ok) throw new Error();
    const doc = JSON.parse(exportArrangementJson(added.value.arrangement));
    expect(doc.room.width).toBe(4000); // mm, as before
    expect(doc.modules[0].configuration.cabinet.width).toBe(800); // furniture mm
    // A file saved before the change imports unchanged.
    expect(importArrangementJson(JSON.stringify(doc))).toMatchObject({ ok: true, value: { room: { width: 4000, depth: 3500, height: 2600 } } });
  });
});
