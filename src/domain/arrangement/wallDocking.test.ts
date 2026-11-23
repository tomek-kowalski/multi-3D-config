import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Box3, Mesh, Vector3 } from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { beforeEach, describe, expect, it } from "vitest";
import { getBedModel } from "@/domain/beds/catalog";
import { getFurnitureType } from "@/domain/modules/registry";
import { useArrangementStore } from "@/store/useArrangementStore";
import { DEFAULT_ROOM } from "../room/defaults";
import { addOpening, updateOpening } from "../room/operations";
import { WALL_IDS, type WallId } from "../room/types";
import { detectCollisions } from "./collisions";
import { proposeDocking } from "./docking";
import { addModule, adjacentPlacement, setPlacement, WALL_ROTATION } from "./operations";
import { moduleFootprint } from "./spatial";
import type { Arrangement } from "./types";
import { backWallContact, meetsWallMounting } from "./wallContact";
import { proposeWallDocking, requiresWallMounting, WALL_DOCKING_DISTANCE_MM, WALL_DOCKING_HYSTERESIS_MM } from "./wallDocking";

function unwrap<T>(r: { ok: true; value: T } | { ok: false; issues: readonly unknown[] }): T {
  if (!r.ok) throw new Error(JSON.stringify(r.issues));
  return r.value;
}

const ROOM = { ...DEFAULT_ROOM, width: 6000, depth: 5000, height: 2700 };
const BEDS = ["clickbed-o", "clickbed-o-classico", "clickbed-o-desk"] as const;

/** One module of `type`, its back `gapMm` away from `wall`, mid-wall, turned by `turnDeg` from the mounting pose. */
function nearWall(type: string, wall: WallId, gapMm: number, turnDeg = 0, room = ROOM): Arrangement {
  let a: Arrangement = { room, modules: [] };
  a = unwrap(addModule(a, type)).arrangement;
  const m = a.modules[0];
  const fp = moduleFootprint(m);
  const rot = WALL_ROTATION[wall];
  // Centre of the footprint for "back on the wall at mid-length", then moved gapMm into the room.
  const mid = { back: { x: room.width / 2, z: 0 }, front: { x: room.width / 2, z: room.depth }, left: { x: 0, z: room.depth / 2 }, right: { x: room.width, z: room.depth / 2 } }[wall];
  const inward = { back: { x: 0, z: 1 }, front: { x: 0, z: -1 }, left: { x: 1, z: 0 }, right: { x: -1, z: 0 } }[wall];
  const d = fp.depth / 2 + gapMm;
  return unwrap(setPlacement(a, m.id, { x: mid.x + inward.x * d, z: mid.z + inward.z * d, rotationDeg: (rot + turnDeg + 360) % 360 })).arrangement;
}

/** Applies a proposal's placement. */
const apply = (a: Arrangement, id: string, p: { placement: { x: number; z: number; y: number; rotationDeg: number } }) =>
  unwrap(setPlacement(a, id, p.placement)).arrangement;

describe("mounting face of the supplied bed models", () => {
  it("is the back of the footprint (local z = 0) for every bed type and size, also in the model geometry", async () => {
    for (const type of BEDS) {
      const t = getFurnitureType(type);
      const c = t.createDefault();
      for (const state of t.states(c)) {
        const boxes = t.collisionBoxes(c, state);
        // The carcass (the tallest part) starts at z = 0; everything else lies in front of it (+z).
        const carcass = boxes.reduce((a, b) => (b.dimensions.height > a.dimensions.height ? b : a));
        expect(carcass.position.z).toBe(0);
        expect(Math.min(...boxes.map((b) => b.position.z))).toBe(0);
      }
      // The converted GLB itself: its carcass/body geometry starts at z = 0 and extends towards +z.
      const buffer = readFileSync(join(__dirname, "../../../public/models/clickbed", getBedModel(type, "140x200")!.file));
      const gltf = await new GLTFLoader().parseAsync(buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength), "");
      const folded = gltf.scene.getObjectByName("folded")!;
      const body = new Box3();
      folded.updateMatrixWorld(true);
      folded.traverse((o) => {
        if (o instanceof Mesh && (o.material as { name: string }).name === "body") body.expandByObject(o);
      });
      expect(body.min.z).toBeCloseTo(0, 2);
      expect(body.max.z).toBeGreaterThan(0.3);
      // Width of the body geometry ≈ the catalogue footprint (the Desk's body is 15 mm narrower).
      const width = moduleFootprint({ typeId: type, configuration: c, placement: { x: 0, y: 0, z: 0, rotationDeg: 0 }, id: "x", state: "folded" }).width;
      expect(Math.abs(body.getSize(new Vector3()).x * 1000 - width)).toBeLessThan(20);
    }
  });
});

describe("wall docking proposal", () => {
  it("is offered when a wall-mounted bed comes near any wall (A–D), and mounts it exactly", () => {
    for (const type of ["clickbed-o-classico", "clickbed-o-desk"])
      for (const wall of WALL_IDS) {
        const a = nearWall(type, wall, 180);
        expect(meetsWallMounting(a.room, a.modules[0]), `${type} ${wall} before`).toBe(false);
        const p = proposeWallDocking(a, "module-1")!;
        expect(p, `${type} at ${wall}`).toMatchObject({ kind: "wall", wall, verdict: "ok", slidMm: 0 });
        expect(p.placement.rotationDeg).toBe(WALL_ROTATION[wall]);
        const docked = apply(a, "module-1", p);
        const contact = backWallContact(docked.room, docked.modules[0])!;
        expect(contact.wall).toBe(wall);
        // Mounting face flush on the wall (both corners at 0 mm), wall mounting satisfied, nothing colliding.
        for (const d of contact.cornerClearancesMm) expect(Math.abs(d)).toBeLessThanOrEqual(1e-6);
        expect(detectCollisions(docked)).toEqual([]);
      }
  });

  it("turns a bed that is near the wall but at the wrong angle", () => {
    // Slightly askew, and standing front first against the wall (turned around).
    for (const turn of [10, -20, 180]) {
      const a = nearWall("clickbed-o-classico", "back", 150, turn);
      const p = proposeWallDocking(a, "module-1")!;
      expect(p, `turned ${turn}°`).not.toBeNull();
      expect(p.placement.rotationDeg).toBe(0);
      expect(Math.abs(p.rotationDeltaDeg)).toBeCloseTo(Math.abs(turn), 6);
      expect(meetsWallMounting(ROOM, apply(a, "module-1", p).modules[0])).toBe(true);
    }
  });

  it("is not offered far from walls or once mounted; the customer can still ask for it explicitly", () => {
    const far = nearWall("clickbed-o-classico", "back", WALL_DOCKING_DISTANCE_MM + 200);
    expect(proposeWallDocking(far, "module-1")).toBeNull();
    expect(proposeWallDocking(far, "module-1", { explicit: true })).toMatchObject({ wall: "back", verdict: "ok" });
    const mounted = apply(far, "module-1", proposeWallDocking(far, "module-1", { explicit: true })!);
    expect(proposeWallDocking(mounted, "module-1")).toBeNull();
    // ClickBed O need not be wall-mounted: no automatic proposal, but docking on request works.
    const o = nearWall("clickbed-o", "left", 200);
    expect(requiresWallMounting(o.modules[0])).toBe(false);
    expect(proposeWallDocking(o, "module-1")).toBeNull();
    const asked = proposeWallDocking(o, "module-1", { explicit: true })!;
    expect(asked).toMatchObject({ wall: "left", verdict: "ok" });
    expect(backWallContact(o.room, apply(o, "module-1", asked).modules[0])?.wall).toBe("left");
  });

  it("chooses by distance and the turn needed, not just the closest wall", () => {
    // In a corner: 120 mm from the back wall but turned 90°, 300 mm from the left wall facing correctly.
    let a: Arrangement = { room: ROOM, modules: [] };
    a = unwrap(addModule(a, "clickbed-o-classico")).arrangement;
    const fp = moduleFootprint(a.modules[0]);
    a = unwrap(setPlacement(a, "module-1", { x: fp.depth / 2 + 300, z: fp.width / 2 + 120, rotationDeg: 90 })).arrangement;
    expect(proposeWallDocking(a, "module-1")).toMatchObject({ wall: "left", rotationDeltaDeg: 0 });
  });

  it("keeps the configured dimensions and materials", () => {
    const a = nearWall("clickbed-o-desk", "right", 200);
    const docked = apply(a, "module-1", proposeWallDocking(a, "module-1")!);
    expect(docked.modules[0].configuration).toBe(a.modules[0].configuration);
    expect(moduleFootprint(docked.modules[0])).toEqual(moduleFootprint(a.modules[0]));
  });

  it("respects windows and doors: shifts along the wall to a free spot, or explains the obstacle", () => {
    const { room, id } = unwrap(addOpening(ROOM, "window", "back"));
    const withWindow = unwrap(updateOpening(room, id, { offset: 2400, width: 1200 })); // 2400…3600 mm, from 900 mm up
    const a = nearWall("clickbed-o-classico", "back", 150, 0, withWindow);
    const p = proposeWallDocking(a, "module-1")!;
    expect(p.verdict).not.toBe("invalid");
    expect(p.slidMm).not.toBe(0);
    expect(detectCollisions(apply(a, "module-1", p))).toEqual([]);
    // A narrow room whose only free wall is the window wall: explained.
    const tight = unwrap(updateOpening({ ...withWindow, width: 3000, depth: 1500 }, id, { offset: 300, width: 2400 }));
    const b = nearWall("clickbed-o-classico", "back", 150, 0, tight);
    const q = proposeWallDocking(b, "module-1")!;
    expect(q.verdict).toBe("invalid");
    expect(q.issues.some((i) => i.kind === "opening" || i.kind === "outside-room")).toBe(true);
  });

  it("respects other furniture, and never moves it", () => {
    let a = nearWall("clickbed-o-classico", "back", 150);
    const bed = a.modules[0];
    a = unwrap(addModule(a, "cabinet")).arrangement;
    a = unwrap(setPlacement(a, "module-2", { x: bed.placement.x, z: 250 })).arrangement; // where the bed would mount
    const p = proposeWallDocking(a, "module-1")!;
    expect(p.verdict).toBe("ok");
    expect(Math.abs(p.slidMm)).toBeGreaterThan(0);
    const docked = apply(a, "module-1", p);
    expect(docked.modules[1].placement).toEqual(a.modules[1].placement);
    expect(detectCollisions(docked)).toEqual([]);
  });

  it("validates the operating space separately: a blocked unfolding area is a warning, not a refusal", () => {
    let a = nearWall("clickbed-o-classico", "back", 150);
    const bed = a.modules[0];
    a = unwrap(addModule(a, "cabinet")).arrangement;
    // A cabinet in front of the mounted bed, inside its unfolding space but clear of the folded bed.
    a = unwrap(setPlacement(a, "module-2", { x: bed.placement.x, z: 1100 })).arrangement;
    expect(proposeWallDocking(a, "module-1")).toMatchObject({
      verdict: "warning",
      slidMm: 0,
      issues: [{ kind: "module", phase: "operation" }],
    });
  });

  it("does not flicker: the shown wall is kept a little beyond the activation distance", () => {
    const edge = nearWall("clickbed-o-classico", "back", WALL_DOCKING_DISTANCE_MM + WALL_DOCKING_HYSTERESIS_MM / 2);
    expect(proposeWallDocking(edge, "module-1")).toBeNull();
    expect(proposeWallDocking(edge, "module-1", { previousWall: "back" })).toMatchObject({ wall: "back" });
  });
});

describe("wall docking with furniture docking and the store", () => {
  beforeEach(() => {
    useArrangementStore.getState().reset();
    useArrangementStore.getState().setDockingEnabled(true);
  });
  const store = useArrangementStore.getState;

  it("asks once, commits the exact mounting pose on confirmation, keeps the position on cancel", () => {
    store().replaceArrangement(nearWall("clickbed-o-classico", "back", 180, 3));
    const before = store().arrangement.modules[0].placement;
    store().proposeDockingFor("module-1");
    expect(store().dockingProposal).toMatchObject({ kind: "wall", wall: "back" });
    store().rejectDocking();
    expect(store().arrangement.modules[0].placement).toEqual(before);
    // Declined: the missing mounting stays reported for the final validation.
    expect(detectCollisions(store().arrangement)).toEqual([{ kind: "wall-mounting", moduleId: "module-1", phase: "static" }]);
    store().proposeDockingFor("module-1");
    expect(store().confirmDocking().ok).toBe(true);
    expect(meetsWallMounting(store().arrangement.room, store().arrangement.modules[0])).toBe(true);
    expect(detectCollisions(store().arrangement)).toEqual([]);
  });

  it("prefers docking next to furniture standing at the wall, which also mounts the bed", () => {
    let a: Arrangement = { room: ROOM, modules: [] };
    a = unwrap(addModule(a, "cabinet")).arrangement;
    a = unwrap(setPlacement(a, "module-1", { x: 1500 })).arrangement; // at the back wall
    a = unwrap(addModule(a, "clickbed-o-classico")).arrangement;
    const exact = adjacentPlacement(a.modules[0], a.modules[1], "right");
    a = unwrap(setPlacement(a, "module-2", { x: exact.x + 120, z: exact.z + 90 })).arrangement;
    store().replaceArrangement(a);
    store().proposeDockingFor("module-2");
    expect(store().dockingProposal).toMatchObject({ kind: "module", targetId: "module-1", verdict: "ok" });
    expect(store().confirmDocking().ok).toBe(true);
    expect(meetsWallMounting(ROOM, store().arrangement.modules[1])).toBe(true);
  });

  it("never docks a wall-mounted bed beside furniture standing away from the wall; offers the wall instead", () => {
    let a: Arrangement = { room: ROOM, modules: [] };
    a = unwrap(addModule(a, "cabinet")).arrangement;
    a = unwrap(setPlacement(a, "module-1", { x: 1500, z: 700 })).arrangement; // 450 mm away from the wall
    a = unwrap(addModule(a, "clickbed-o-classico")).arrangement;
    const exact = adjacentPlacement(a.modules[0], a.modules[1], "right");
    a = unwrap(setPlacement(a, "module-2", { x: exact.x + 100, z: exact.z })).arrangement;
    expect(proposeDocking(a, "module-2")).toMatchObject({ verdict: "invalid", issues: [{ kind: "wall-mounting" }] });
    store().replaceArrangement(a);
    store().proposeDockingFor("module-2");
    expect(store().dockingProposal).toMatchObject({ kind: "wall", wall: "back", verdict: "ok" });
  });

  it("can be requested explicitly for the selected bed", () => {
    store().replaceArrangement(nearWall("clickbed-o-desk", "front", 1200));
    store().requestWallDocking("module-1");
    expect(store().dockingProposal).toMatchObject({ kind: "wall", wall: "front" });
  });
});
