import { describe, expect, it } from "vitest";
import { DEFAULT_CABINET } from "../furniture/defaults";
import type { CabinetConfiguration } from "../furniture/types";
import type { ModuleInstance } from "../modules/types";
import { DEFAULT_ROOM } from "../room/defaults";
import { wallFrame } from "../room/geometry";
import { WALL_IDS, type RoomConfiguration } from "../room/types";
import { roomBox } from "../spatial/geometry";
import { detectCollisions } from "./collisions";
import { addModule, setPlacement, snapToWall, updateModuleConfiguration } from "./operations";
import type { Arrangement } from "./types";
import {
  backWallContact,
  classifyWallContact,
  formatClearanceMm,
  GEOMETRY_EPSILON_MM,
  insideRoom,
  moduleWallRelations,
  relevantWallRelations,
  signedClearance,
  WALL_CONTACT_TOLERANCE_MM,
  wallContactDisplay,
  wallRelations,
} from "./wallContact";

function unwrap<T>(r: { ok: true; value: T } | { ok: false; issues: readonly unknown[] }): T {
  if (!r.ok) throw new Error(JSON.stringify(r.issues));
  return r.value;
}

const ROOM: RoomConfiguration = { ...DEFAULT_ROOM, width: 4000, depth: 3000, height: 2600 };
const EMPTY: Arrangement = { room: ROOM, modules: [] };

/** A box against the back wall whose back face is at `z` (exact double, any fraction). */
const backBox = (z: number) => roomBox(1000, 1800, z, z + 500, 0, 1800);
const back = (z: number) => wallRelations(ROOM, [backBox(z)]).find((r) => r.wall === "back")!;

function cabinet(arrangement = EMPTY, configuration: CabinetConfiguration = DEFAULT_CABINET) {
  return unwrap(addModule(arrangement, "cabinet", configuration));
}

function moved(arrangement: Arrangement, id: string, patch: Parameters<typeof setPlacement>[2]) {
  return unwrap(setPlacement(arrangement, id, patch)).arrangement;
}

function get(arrangement: Arrangement, id: string): ModuleInstance {
  return arrangement.modules.find((m) => m.id === id)!;
}

describe("classification", () => {
  it("uses separate tolerances for contact and floating-point error", () => {
    expect(WALL_CONTACT_TOLERANCE_MM).toBe(1);
    expect(GEOMETRY_EPSILON_MM).toBe(1e-6);
    expect(classifyWallContact(0)).toBe("contact");
    expect(classifyWallContact(0.5)).toBe("contact");
    expect(classifyWallContact(1)).toBe("contact");
    expect(classifyWallContact(1 + 5e-7)).toBe("contact"); // within epsilon of the threshold
    expect(classifyWallContact(1.00001)).toBe("separated");
    expect(classifyWallContact(5)).toBe("separated");
    expect(classifyWallContact(-5e-7)).toBe("contact"); // numerical zero
    expect(classifyWallContact(-0.01)).toBe("collision");
    expect(() => classifyWallContact(Number.NaN)).toThrow();
  });
});

describe("signed clearance from the real boundary", () => {
  it("measures exact contact, 0.5 mm, the 1 mm threshold and separation", () => {
    expect(back(0)).toMatchObject({ clearanceMm: 0, status: "contact", withinExtent: true });
    expect(back(0.5)).toMatchObject({ clearanceMm: 0.5, status: "contact" });
    expect(back(1)).toMatchObject({ clearanceMm: 1, status: "contact" });
    expect(back(1.00001)).toMatchObject({ status: "separated" });
    expect(back(5)).toMatchObject({ clearanceMm: 5, status: "separated" });
  });

  it("treats floating-point noise near zero as zero but small real penetration as collision", () => {
    expect(back(5e-7).status).toBe("contact");
    expect(back(-5e-7).status).toBe("contact");
    expect(insideRoom(ROOM, [backBox(-5e-7)])).toBe(true);
    expect(back(-0.01).status).toBe("collision");
    expect(insideRoom(ROOM, [backBox(-0.01)])).toBe(false);
  });

  it("uses the rotated outline, not the centre or an axis-aligned box", () => {
    const { arrangement, id } = cabinet();
    const angle = 30;
    const rad = (angle * Math.PI) / 180;
    // The corner nearest the back wall lies (W/2)·sin + (D/2)·cos from the centre.
    const reach = 400 * Math.sin(rad) + 250 * Math.cos(rad);
    const z = 1000;
    const rotated = moved(arrangement, id, { x: 2000, z, rotationDeg: angle });
    const clearance = moduleWallRelations(ROOM, get(rotated, id)).find((r) => r.wall === "back")!.clearanceMm;
    expect(clearance).toBeCloseTo(z - reach, 9);
    // Rotated so one corner pokes 0.67 mm into the back wall: a collision, although the centre is far.
    const zIn = Math.ceil(reach) - 1;
    const poking = moved(arrangement, id, { x: 2000, z: zIn, rotationDeg: angle });
    expect(moduleWallRelations(ROOM, get(poking, id)).find((r) => r.wall === "back")!.status).toBe("collision");
    expect(detectCollisions(poking)).toContainEqual({ kind: "outside-room", moduleId: id, phase: "static" });
  });

  it("follows resizing: the back stays in contact while the free side moves", () => {
    const { arrangement, id } = cabinet();
    const right = (a: Arrangement) => moduleWallRelations(ROOM, get(a, id)).find((r) => r.wall === "right")!.clearanceMm;
    expect(right(arrangement)).toBe(3200);
    const wider = unwrap(updateModuleConfiguration(arrangement, id, { ...DEFAULT_CABINET, width: 1200, depth: 600 })).arrangement;
    expect(moduleWallRelations(ROOM, get(wider, id)).find((r) => r.wall === "back")!.clearanceMm).toBe(0);
    expect(right(wider)).toBe(2800);
  });

  it("works for every wall orientation", () => {
    for (const wall of WALL_IDS) {
      const { arrangement, id } = cabinet();
      const snapped = unwrap(snapToWall(arrangement, id, wall)).arrangement;
      const relation = moduleWallRelations(ROOM, get(snapped, id)).find((r) => r.wall === wall)!;
      expect(relation, wall).toMatchObject({ clearanceMm: 0, status: "contact", withinExtent: true });
      expect(backWallContact(ROOM, get(snapped, id))?.wall).toBe(wall);
      expect(detectCollisions(snapped)).toEqual([]);
    }
  });

  it("snaps odd-sized furniture into contact without rounding into the wall", () => {
    const odd: CabinetConfiguration = { ...DEFAULT_CABINET, width: 801, depth: 501 };
    for (const wall of WALL_IDS) {
      const { arrangement, id } = cabinet(EMPTY, odd);
      const snapped = unwrap(snapToWall(arrangement, id, wall)).arrangement;
      const relation = moduleWallRelations(ROOM, get(snapped, id)).find((r) => r.wall === wall)!;
      expect(relation.clearanceMm).toBeGreaterThanOrEqual(0);
      expect(relation.status, wall).toBe("contact");
      expect(detectCollisions(snapped), wall).toEqual([]);
    }
  });

  it("ignores walls whose finite extent the furniture is not in front of", () => {
    // Beyond the right end of the back wall: touching the back plane, but not the back wall.
    const outside = roomBox(4100, 4900, 0, 500, 0, 1800);
    const relation = wallRelations(ROOM, [outside]).find((r) => r.wall === "back")!;
    expect(relation).toMatchObject({ clearanceMm: 0, withinExtent: false });
    expect(relevantWallRelations(wallRelations(ROOM, [outside])).map((r) => r.wall)).toEqual(["right"]);
    expect(wallRelations(ROOM, [outside]).find((r) => r.wall === "right")!.status).toBe("collision");
  });

  it("computes the clearance per wall plane from the inward normal", () => {
    const box = roomBox(10, 20, 30, 40, 0, 10);
    expect(signedClearance([box], wallFrame(ROOM, "left"))).toBe(10);
    expect(signedClearance([box], wallFrame(ROOM, "back"))).toBe(30);
    expect(signedClearance([box], wallFrame(ROOM, "right"))).toBe(3980);
    expect(signedClearance([box], wallFrame(ROOM, "front"))).toBe(2960);
  });
});

describe("furniture that must be wall-mounted", () => {
  const classico = () => unwrap(addModule(EMPTY, "clickbed-o-classico"));

  it("is valid with its back flush against a wall (0–1 mm)", () => {
    const { arrangement, id } = classico();
    expect(backWallContact(ROOM, get(arrangement, id))).toMatchObject({ wall: "back", cornerClearancesMm: [0, 0] });
    expect(detectCollisions(arrangement)).toEqual([]);
    const oneMm = moved(arrangement, id, { z: get(arrangement, id).placement.z + 1 });
    expect(detectCollisions(oneMm)).toEqual([]);
  });

  it("is reported when moved away, turned off parallel, or with its side against the wall", () => {
    const { arrangement, id } = classico();
    const { z, x } = get(arrangement, id).placement;
    const issue = { kind: "wall-mounting", moduleId: id, phase: "static" };
    expect(detectCollisions(moved(arrangement, id, { z: z + 2 }))).toEqual([issue]);
    expect(detectCollisions(moved(arrangement, id, { x: 1500, z: z + 200, rotationDeg: 3 }))).toEqual([issue]);
    // Rotated 90° with the side touching the back wall: in contact, but not mounted by its back.
    const sideways = moved(arrangement, id, { x, z: 1090, rotationDeg: 90 });
    expect(relevantWallRelations(moduleWallRelations(ROOM, get(sideways, id))).map((r) => r.wall)).toContain("back");
    expect(detectCollisions(sideways)).toContainEqual(issue);
  });

  it("does not report a penetrating module twice (the penetration is the collision)", () => {
    const { arrangement, id } = classico();
    const into = moved(arrangement, id, { z: get(arrangement, id).placement.z - 1 });
    expect(detectCollisions(into)).toEqual([{ kind: "outside-room", moduleId: id, phase: "static" }]);
  });

  it("is not assumed for products without a published requirement", () => {
    const { arrangement, id } = unwrap(addModule(EMPTY, "clickbed-o"));
    expect(detectCollisions(moved(arrangement, id, { z: get(arrangement, id).placement.z + 300 }))).toEqual([]);
  });
});

describe("one calculation for validation and UI", () => {
  it("reports outside-room exactly when a wall relation is a collision", () => {
    const { arrangement, id } = cabinet();
    for (const placement of [
      { x: 400, z: 250, rotationDeg: 0 },
      { x: 399, z: 250, rotationDeg: 0 },
      { x: 400, z: 249, rotationDeg: 0 },
      { x: 2000, z: 330, rotationDeg: 45 },
      { x: 2000, z: 320, rotationDeg: 45 },
      { x: 3700, z: 2700, rotationDeg: 200 },
    ]) {
      const a = moved(arrangement, id, placement);
      const collides = moduleWallRelations(ROOM, get(a, id)).some((r) => r.status === "collision");
      const flagged = detectCollisions(a).some((i) => i.kind === "outside-room");
      expect(flagged, JSON.stringify(placement)).toBe(collides);
    }
  });
});

describe("display precision", () => {
  const show = (d: number) => wallContactDisplay({ wall: "back", clearanceMm: d });
  it("formats exactly as specified, independent of the calculation", () => {
    expect(show(0)).toEqual({ kind: "distance", wallLetter: "A", distanceText: "0" });
    expect(show(0.0000005)).toEqual({ kind: "distance", wallLetter: "A", distanceText: "0" });
    expect(show(0.5)).toEqual({ kind: "contact", wallLetter: "A", distanceText: "0.5" });
    expect(show(1)).toEqual({ kind: "contact", wallLetter: "A", distanceText: "1" });
    expect(show(1.00001)).toEqual({ kind: "distance", wallLetter: "A", distanceText: "1.00001" });
    expect(show(5)).toEqual({ kind: "distance", wallLetter: "A", distanceText: "5" });
    expect(show(-0.0000005)).toEqual({ kind: "distance", wallLetter: "A", distanceText: "0" });
    expect(show(-0.01).kind).toBe("collision");
  });

  it("never shows a meaningful gap as 0 and strips float noise", () => {
    expect(formatClearanceMm(0.00001)).toBe("0.00001");
    expect(formatClearanceMm(0.1 + 0.2)).toBe("0.3");
    expect(formatClearanceMm(2.5000000000001)).toBe("2.5");
    expect(formatClearanceMm(1234)).toBe("1234");
  });
});
