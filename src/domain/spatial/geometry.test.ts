import { describe, expect, it } from "vitest";
import { boxesIntersect, localAxes, localToRoom, placeBox, roomBox, roomToLocal } from "./geometry";

describe("module frame", () => {
  it("maps local axes for the four wall orientations", () => {
    expect(localAxes(0)).toEqual({ right: { x: 1, z: 0 }, front: { x: 0, z: 1 } });
    expect(localAxes(90)).toEqual({ right: { x: 0, z: -1 }, front: { x: 1, z: 0 } });
    expect(localAxes(180)).toEqual({ right: { x: -1, z: 0 }, front: { x: 0, z: -1 } });
    expect(localAxes(270)).toEqual({ right: { x: 0, z: 1 }, front: { x: -1, z: 0 } });
  });

  it("round-trips local and room coordinates at any angle", () => {
    const placement = { x: 1234, y: 0, z: 987, rotationDeg: 33 };
    const fp = { width: 800, depth: 500 };
    const p = { x: 120, z: 410 };
    const back = roomToLocal(localToRoom(p, placement, fp), placement, fp);
    expect(back.x).toBeCloseTo(p.x, 9);
    expect(back.z).toBeCloseTo(p.z, 9);
  });

  it("places the footprint centre at the placement position", () => {
    const placed = placeBox(
      { position: { x: 0, y: 0, z: 0 }, dimensions: { width: 800, height: 700, depth: 500 } },
      { x: 1000, y: 100, z: 250, rotationDeg: 0 },
      { width: 800, depth: 500 },
    );
    expect(placed.corners[0]).toEqual({ x: 600, z: 0 });
    expect(placed.corners[2]).toEqual({ x: 1400, z: 500 });
    expect([placed.yMin, placed.yMax]).toEqual([100, 800]);
  });
});

describe("intersection", () => {
  it("treats touching boxes as not intersecting", () => {
    expect(boxesIntersect(roomBox(0, 100, 0, 100, 0, 100), roomBox(100, 200, 0, 100, 0, 100))).toBe(false);
    expect(boxesIntersect(roomBox(0, 100, 0, 100, 0, 100), roomBox(99, 200, 0, 100, 0, 100))).toBe(true);
  });

  it("separates boxes by height", () => {
    expect(boxesIntersect(roomBox(0, 100, 0, 100, 0, 900), roomBox(0, 100, 0, 100, 900, 2000))).toBe(false);
  });

  it("handles rotated boxes (separating axis)", () => {
    const fp = { width: 1000, depth: 100 };
    const diagonal = placeBox({ position: { x: 0, y: 0, z: 0 }, dimensions: { width: 1000, height: 10, depth: 100 } }, { x: 0, y: 0, z: 0, rotationDeg: 45 }, fp);
    expect(boxesIntersect(diagonal, roomBox(300, 400, 300, 400, 0, 10))).toBe(false);
    expect(boxesIntersect(diagonal, roomBox(-50, 50, -50, 50, 0, 10))).toBe(true);
  });

});
