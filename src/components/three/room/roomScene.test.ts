import { describe, expect, it } from "vitest";
import { DEFAULT_ROOM } from "@/domain/room/defaults";
import { openingKeepFreeBox, wallFrame } from "@/domain/room/geometry";
import { WALL_IDS, WALL_LETTERS, type RoomOpening } from "@/domain/room/types";
import { translate } from "@/i18n";
import { contrastColor, openingOutline, openingParts, wallAngle, wallHighlights, wallLabels } from "./roomScene";

const room = { ...DEFAULT_ROOM, width: 4000, depth: 3000, height: 2600 };
const window_: RoomOpening = { id: "window-1", kind: "window", wall: "left", offset: 500, elevation: 900, width: 1200, height: 1400, clearanceDepth: 0 };
const door: RoomOpening = { id: "door-1", kind: "door", wall: "front", offset: 300, elevation: 0, width: 900, height: 2050, clearanceDepth: 900, color: "#7A5A3F" };

describe("windows and doors", () => {
  it("never cast or receive shadows", () => {
    for (const opening of [window_, door]) {
      for (const part of openingParts(opening)) {
        expect(part.castShadow, `${opening.id}/${part.key}`).toBe(false);
        expect(part.receiveShadow, `${opening.id}/${part.key}`).toBe(false);
      }
    }
  });

  it("fill exactly the opening's size and keep the door colour", () => {
    const frame = openingParts(window_).filter((p) => p.role === "frame");
    const minX = Math.min(...frame.map((p) => p.center[0] - p.size[0] / 2));
    const maxX = Math.max(...frame.map((p) => p.center[0] + p.size[0] / 2));
    const maxY = Math.max(...frame.map((p) => p.center[1] + p.size[1] / 2));
    expect([minX, maxX, maxY].map((v) => Math.round(v * 1000))).toEqual([0, 1200, 1400]);
    expect(openingParts(door).find((p) => p.role === "leaf")?.color).toBe("#7A5A3F");
  });

  it("are tied visibly to their wall: outline around the opening in a contrasting colour", () => {
    const outline = openingOutline(window_);
    const xs = outline.map((p) => p[0]);
    expect(Math.min(...xs)).toBeLessThan(0);
    expect(Math.max(...xs)).toBeGreaterThan(1.2);
    expect(outline[0]).toEqual(outline[outline.length - 1]);
    expect(contrastColor("#F2F0EB")).not.toBe("#F2F0EB");
    expect(contrastColor("#2E2F31")).not.toBe("#2E2F31");
  });

  it("leave the collision geometry untouched", () => {
    const box = openingKeepFreeBox(room, window_);
    const xs = box.corners.map((c) => c.x);
    const zs = box.corners.map((c) => c.z);
    expect([Math.min(...xs), Math.max(...xs), Math.min(...zs), Math.max(...zs), box.yMin, box.yMax]).toEqual([0, 1, 1300, 2500, 900, 2300]);
  });

  it("are oriented with the wall's frame (x along the wall, z into the room)", () => {
    for (const wall of WALL_IDS) {
      const frame = wallFrame(room, wall);
      const a = wallAngle(room, wall);
      expect(Math.cos(a)).toBeCloseTo(frame.along.x, 12);
      expect(-Math.sin(a)).toBeCloseTo(frame.along.z, 12);
      expect(Math.sin(a)).toBeCloseTo(frame.inward.x, 12);
      expect(Math.cos(a)).toBeCloseTo(frame.inward.z, 12);
    }
  });
});

describe("active wall and wall labels", () => {
  it("highlights only the active wall and follows a change immediately", () => {
    expect(wallHighlights("back")).toEqual({ back: true, right: false, front: false, left: false });
    expect(wallHighlights("left")).toEqual({ back: false, right: false, front: false, left: true });
    expect(Object.values(wallHighlights(null)).some(Boolean)).toBe(false);
  });

  it("labels every wall with its identifier and marks only the active one", () => {
    const labels = wallLabels(room, "right");
    expect(labels.map((l) => [l.wall, l.letter, l.active])).toEqual([
      ["back", "A", false],
      ["right", "B", true],
      ["front", "C", false],
      ["left", "D", false],
    ]);
    // Each label sits at its own wall's midpoint (in metres), just inside the room.
    const back = labels.find((l) => l.wall === "back")!;
    expect(back.position[0]).toBeCloseTo(2, 9);
    expect(back.position[2]).toBeCloseTo(0.06, 9);
    const left = labels.find((l) => l.wall === "left")!;
    expect(left.position[0]).toBeCloseTo(0.06, 9);
    expect(left.position[2]).toBeCloseTo(1.5, 9);
  });

  it("uses the same identifiers as the configuration menus in both languages", () => {
    for (const wall of WALL_IDS) {
      expect(translate("pl", `wall.${wall}`)).toContain(`Ściana ${WALL_LETTERS[wall]}`);
      expect(translate("en", `wall.${wall}`)).toContain(`Wall ${WALL_LETTERS[wall]}`);
    }
  });
});
