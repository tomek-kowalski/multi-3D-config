import { describe, expect, it } from "vitest";
import { DEFAULT_ROOM } from "@/domain/room/defaults";
import { openingKeepFreeBox, wallFrame } from "@/domain/room/geometry";
import { WALL_IDS, WALL_LETTERS, type RoomOpening } from "@/domain/room/types";
import { translate } from "@/i18n";
import { Euler, Vector3 } from "three";
import { contrastColor, leafRotation, openingOutline, openingParts, openingScene, wallAngle, wallHighlights, wallLabels } from "./roomScene";

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

describe("opening windows and doors", () => {
  /** Far end of a leaf (its free edge) after turning by `progress`, relative to the opening's frame. */
  const freeEdge = (opening: RoomOpening, index: number, progress: number) => {
    const leaf = openingScene(opening).leaves[index];
    const reach = Math.max(...leaf.parts.map((p) => Math.abs(p.center[0]) + p.size[0] / 2));
    const v = new Vector3(leaf.direction * reach, 0, 0).applyEuler(new Euler(0, leafRotation(leaf.direction, progress), 0));
    return { x: v.x + leaf.pivot[0], z: v.z + leaf.pivot[2] };
  };

  it("a door has a stationary frame and one leaf hinged on its left, with the handle", () => {
    const scene = openingScene(door);
    expect(scene.fixed.map((p) => p.key)).toEqual(["left", "right", "top"]);
    expect(scene.leaves.map((l) => l.id)).toEqual(["leaf"]);
    expect(scene.leaves[0].pivot[0]).toBeCloseTo(0.06);
    expect(scene.leaves[0].parts.map((p) => p.role)).toEqual(["leaf", "handle"]);
  });

  it("a window has two sashes hinged at its outer edges and no fixed mullion", () => {
    const scene = openingScene(window_);
    expect(scene.fixed.some((p) => p.key === "mullion")).toBe(false);
    expect(scene.leaves.map((l) => [l.id, l.direction, Math.round(l.pivot[0] * 1000)])).toEqual([
      ["left-sash", 1, 60],
      ["right-sash", -1, 1140],
    ]);
    expect(scene.leaves.every((l) => l.parts.some((p) => p.role === "glass"))).toBe(true);
  });

  it("leaves open inward, into the room (+z), by 90°, and are flat in the wall when closed", () => {
    for (const [opening, index] of [
      [door, 0],
      [window_, 0],
      [window_, 1],
    ] as const) {
      const closed = freeEdge(opening, index, 0);
      const open = freeEdge(opening, index, 1);
      const leaf = openingScene(opening).leaves[index];
      expect(closed.z).toBeCloseTo(leaf.pivot[2]);
      expect(open.z - leaf.pivot[2]).toBeGreaterThan(0.4);
      expect(open.x).toBeCloseTo(leaf.pivot[0], 5);
    }
  });
});
