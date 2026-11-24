import { describe, expect, it } from "vitest";
import { addDoor } from "../attachments/operations";
import { detectCollisions, openingMotionObstacles } from "../arrangement/collisions";
import { cabinetFrontSweeps, checkFrontMotion, movableFronts } from "../arrangement/frontMotion";
import { addModule, setPlacement, updateModuleConfiguration } from "../arrangement/operations";
import type { Arrangement } from "../arrangement/types";
import { DEFAULT_CABINET, ROOT_COMPARTMENT_ID } from "../furniture/defaults";
import type { CabinetConfiguration } from "../furniture/types";
import { DEFAULT_ROOM } from "./defaults";
import { addOpening, updateOpening } from "./operations";
import { assistOpeningPosition, clampOpeningPosition, OPENING_FRAME_MM, openingLeaves, openingSwingBoxes } from "./openingMotion";
import type { RoomConfiguration, RoomOpening } from "./types";

function unwrap<T>(r: { ok: true; value: T } | { ok: false; issues: readonly unknown[] }): T {
  if (!r.ok) throw new Error(JSON.stringify(r.issues));
  return r.value;
}

const ROOM: RoomConfiguration = { ...DEFAULT_ROOM, width: 4000, depth: 3500, height: 2600 };

/** A room with one opening of `kind` on the back wall at `offset`. */
function withOpening(kind: "window" | "door", offset: number, room = ROOM, extra: Partial<RoomOpening> = {}) {
  const added = unwrap(addOpening(room, kind, "back"));
  const next = unwrap(updateOpening(added.room, added.id, { offset, ...extra }));
  return { room: next, opening: next.openings.find((o) => o.id === added.id)! };
}

/** A default cabinet (800 × 1800 × 500) with its back on the back wall, centred at x. */
function cabinetAt(room: RoomConfiguration, x: number, configuration?: CabinetConfiguration, z = 250): Arrangement {
  let a: Arrangement = { room, modules: [] };
  a = unwrap(addModule(a, "cabinet")).arrangement;
  if (configuration) a = unwrap(updateModuleConfiguration(a, a.modules[0].id, configuration)).arrangement;
  return unwrap(setPlacement(a, a.modules[0].id, { x, z, rotationDeg: 0 })).arrangement;
}

describe("window and door leaves", () => {
  it("a door has one leaf hinged on its left, on the floor, inside the frame", () => {
    const { opening } = withOpening("door", 1000);
    const [leaf] = openingLeaves(opening);
    expect(openingLeaves(opening)).toHaveLength(1);
    expect(leaf).toMatchObject({ id: "leaf", hingeU: 1000 + OPENING_FRAME_MM, direction: 1, width: opening.width - 2 * OPENING_FRAME_MM, bottom: 0 });
    expect(leaf.top).toBe(opening.height - OPENING_FRAME_MM);
  });

  it("a window has two sashes hinged at its outer edges, meeting in the middle", () => {
    const { opening } = withOpening("window", 1000);
    const [left, right] = openingLeaves(opening);
    expect(left).toMatchObject({ id: "left-sash", hingeU: 1000 + OPENING_FRAME_MM, direction: 1 });
    expect(right).toMatchObject({ id: "right-sash", hingeU: 1000 + opening.width - OPENING_FRAME_MM, direction: -1 });
    expect(left.hingeU + left.width).toBe(right.hingeU - right.width);
    expect(left.bottom).toBe(opening.elevation + OPENING_FRAME_MM);
  });

  it("the leaves swing into the room by their own width", () => {
    const { room, opening } = withOpening("door", 1000);
    const [swing] = openingSwingBoxes(room, opening);
    const leaf = openingLeaves(opening)[0];
    // Back wall: along +x, into the room +z.
    expect(swing.corners[0]).toEqual({ x: leaf.hingeU, z: 0 });
    expect(swing.corners[2]).toEqual({ x: leaf.hingeU + leaf.width, z: leaf.width });
    expect([swing.yMin, swing.yMax]).toEqual([0, leaf.top]);
  });
});

describe("positioning assistance", () => {
  it("keeps the requested position when it is free", () => {
    const { room, opening } = withOpening("window", 500);
    expect(assistOpeningPosition(room, opening, 1500, 1000)).toEqual({ offset: 1500, elevation: 1000, valid: true, reason: null });
  });

  it("clamps to the wall and below the ceiling, explaining it", () => {
    const { room, opening } = withOpening("window", 500);
    const p = assistOpeningPosition(room, opening, 9000, 5000);
    expect(p).toMatchObject({ offset: 4000 - opening.width, elevation: 2600 - opening.height, valid: false, reason: { code: "opening_clamped_to_wall" } });
    expect(clampOpeningPosition(room, opening, -300, -50)).toEqual({ offset: 0, elevation: 0 });
  });

  it("a door stays on the floor", () => {
    const { room, opening } = withOpening("door", 500);
    expect(assistOpeningPosition(room, opening, 1200, 700)).toMatchObject({ offset: 1200, elevation: 0, valid: true });
  });

  it("never overlaps another opening: the nearest free side is used and named", () => {
    const first = withOpening("window", 400);
    const second = unwrap(addOpening(first.room, "window", "back"));
    const room = second.room;
    const opening = room.openings.find((o) => o.id === second.id)!;
    // Dropped mostly over the first window, slightly to its right: placed right next to it.
    const p = assistOpeningPosition(room, opening, 900, first.opening.elevation);
    expect(p.valid).toBe(false);
    expect(p.reason).toEqual({ code: "opening_moved_off", other: first.opening.id });
    expect(p.offset).toBe(400 + first.opening.width);
  });
});

describe("open windows and doors in the collision check", () => {
  it("furniture in an open door's swing collides; with the door closed only the keep-free space counts", () => {
    const { room, opening } = withOpening("door", 1000, ROOM, { clearanceDepth: 0 });
    const closed = cabinetAt(room, 1500, undefined, 600);
    expect(detectCollisions(closed).some((i) => i.kind === "opening")).toBe(false);
    expect(openingMotionObstacles(closed, opening.id)).toEqual([{ kind: "module", moduleId: closed.modules[0].id }]);
    const open: Arrangement = { ...closed, room: unwrap(updateOpening(room, opening.id, { open: true })) };
    expect(detectCollisions(open).some((i) => i.kind === "opening" && i.openingId === opening.id)).toBe(true);
  });

  it("a free door can be opened", () => {
    const { room, opening } = withOpening("door", 1000);
    expect(openingMotionObstacles(cabinetAt(room, 3000), opening.id)).toEqual([]);
  });

  it("a window's sashes hit a tall cabinet in front of it, but not one far away", () => {
    const { room, opening } = withOpening("window", 1000);
    expect(openingMotionObstacles(cabinetAt(room, 1300), opening.id)).toHaveLength(1);
    expect(openingMotionObstacles(cabinetAt(room, 3500), opening.id)).toEqual([]);
  });

  it("neighbouring windows on one wall never meet (sashes swing over their own window)", () => {
    const first = withOpening("window", 400, ROOM, { open: true });
    const second = unwrap(addOpening(first.room, "window", "back"));
    const room = unwrap(updateOpening(second.room, second.id, { offset: 400 + first.opening.width }));
    expect(openingMotionObstacles({ room, modules: [] }, second.id)).toEqual([]);
  });

  it("two doors in a corner: the second cannot open into the open first one", () => {
    const first = withOpening("door", 0, ROOM, { open: true });
    const added = unwrap(addOpening(first.room, "door", "left"));
    const room = unwrap(updateOpening(added.room, added.id, { offset: ROOM.depth - 900 }));
    expect(openingMotionObstacles({ room, modules: [] }, added.id)).toEqual([{ kind: "opening", openingId: first.opening.id }]);
    const closedFirst = unwrap(updateOpening(room, first.opening.id, { open: false }));
    expect(openingMotionObstacles({ room: closedFirst, modules: [] }, added.id)).toEqual([]);
  });
});

describe("cabinet fronts opening in the room", () => {
  const withDoor = (() => {
    const r = addDoor(DEFAULT_CABINET, ROOT_COMPARTMENT_ID, "single");
    if (!r.ok) throw new Error(r.error.message);
    return r.configuration;
  })();

  it("a hinged door sweeps its own width in front of the cabinet", () => {
    const [sweep] = cabinetFrontSweeps(withDoor);
    expect(cabinetFrontSweeps(withDoor)).toHaveLength(1);
    expect(sweep.box.position.z).toBeGreaterThanOrEqual(DEFAULT_CABINET.depth - 30);
    expect(sweep.box.dimensions.depth).toBeGreaterThan(DEFAULT_CABINET.width * 0.8);
  });

  it("lists the movable fronts and opens freely in an empty room", () => {
    const a = cabinetAt(ROOM, 2000, withDoor);
    expect(movableFronts(a.modules[0])).toEqual(withDoor.attachments.map((x) => x.id));
    expect(checkFrontMotion(a, a.modules[0].id).every((c) => c.obstacles.length === 0)).toBe(true);
  });

  it("is blocked by furniture standing in front of the cabinet", () => {
    let a = cabinetAt(ROOM, 2000, withDoor);
    a = unwrap(addModule(a, "cabinet")).arrangement;
    const other = a.modules[1].id;
    // Back to back with the first cabinet's front, 300 mm away: inside the door's swing.
    a = unwrap(setPlacement(a, other, { x: 2000, z: 500 + 300 + 250, rotationDeg: 180 })).arrangement;
    const [check] = checkFrontMotion(a, a.modules[0].id);
    expect(check.obstacles).toEqual([{ kind: "module", moduleId: other }]);
  });
});
