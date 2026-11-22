import { describe, expect, it } from "vitest";
import type { BedConfiguration } from "../beds/bedType";
import { DEFAULT_CABINET } from "../furniture/defaults";
import type { CabinetConfiguration } from "../furniture/types";
import type { ModuleInstance } from "../modules/types";
import { DEFAULT_ROOM } from "../room/defaults";
import { addOpening, updateOpening } from "../room/operations";
import type { RoomConfiguration } from "../room/types";
import { detectCollisions } from "./collisions";
import {
  addModule,
  addModuleNextTo,
  duplicateModule,
  moduleCorner,
  removeModule,
  rotateModule,
  setModuleState,
  setPlacement,
  snapToWall,
  updateModuleConfiguration,
} from "./operations";
import type { Arrangement } from "./types";

function unwrap<T>(r: { ok: true; value: T } | { ok: false; issues: readonly unknown[] }): T {
  if (!r.ok) throw new Error(JSON.stringify(r.issues));
  return r.value;
}

const EMPTY: Arrangement = { room: { ...DEFAULT_ROOM, width: 6000, depth: 4000, height: 2700 }, modules: [] };

function withCabinet(arrangement = EMPTY) {
  return unwrap(addModule(arrangement, "cabinet"));
}

function get(arrangement: Arrangement, id: string): ModuleInstance {
  return arrangement.modules.find((m) => m.id === id)!;
}

describe("adding, positioning and removing modules", () => {
  it("adds a module against the back wall at the first free spot", () => {
    const { arrangement, id } = withCabinet();
    const cabinet = get(arrangement, id);
    // Default cabinet 800 × 1800 × 500: centre 400 from the left wall, 250 from the back wall.
    expect(cabinet.placement).toEqual({ x: 400, y: 0, z: 250, rotationDeg: 0 });
    const second = unwrap(addModule(arrangement, "cabinet"));
    expect(get(second.arrangement, second.id).placement.x).toBe(1200);
  });

  it("uses whole-millimetre numeric coordinates as the authoritative position", () => {
    const { arrangement, id } = withCabinet();
    const moved = unwrap(setPlacement(arrangement, id, { x: 2000, z: 1500, y: 300 }));
    expect(get(moved.arrangement, id).placement).toEqual({ x: 2000, y: 300, z: 1500, rotationDeg: 0 });
    expect(setPlacement(arrangement, id, { x: 10.5 }).ok).toBe(false);
    expect(setPlacement(arrangement, id, { y: -1 }).ok).toBe(false);
  });

  it("rotates about the footprint centre and normalizes the angle", () => {
    const { arrangement, id } = withCabinet();
    const rotated = unwrap(rotateModule(arrangement, id, -90));
    expect(get(rotated.arrangement, id).placement).toMatchObject({ x: 400, z: 250, rotationDeg: 270 });
  });

  it("snaps a module flush against a wall, facing into the room", () => {
    const { arrangement, id } = withCabinet();
    const snapped = unwrap(snapToWall(arrangement, id, "left"));
    const placement = get(snapped.arrangement, id).placement;
    expect(placement.rotationDeg).toBe(90);
    expect(placement.x).toBe(250); // half the 500 mm depth from the left wall
    expect(detectCollisions(snapped.arrangement)).toEqual([]);
  });

  it("removes modules", () => {
    const { arrangement, id } = withCabinet();
    expect(unwrap(removeModule(arrangement, id)).arrangement.modules).toHaveLength(0);
    expect(removeModule(arrangement, "missing").ok).toBe(false);
  });
});

describe("duplication", () => {
  it("duplicates directly to the right and left with a new id and copied configuration", () => {
    const start = unwrap(setPlacement(withCabinet().arrangement, "module-1", { x: 2000 })).arrangement;
    const right = unwrap(duplicateModule(start, "module-1", "right"));
    const left = unwrap(duplicateModule(right.arrangement, "module-1", "left"));
    expect(right.id).toBe("module-2");
    expect(left.id).toBe("module-3");
    expect(get(left.arrangement, "module-2").placement.x).toBe(2800);
    expect(get(left.arrangement, "module-3").placement.x).toBe(1200);
    expect(get(left.arrangement, "module-2").configuration).toEqual(get(start, "module-1").configuration);
    expect(detectCollisions(left.arrangement)).toEqual([]);
  });

  it("uses the module's own orientation for left and right", () => {
    // Against the left wall (rotation 90) the module's right points towards the back wall (−Z).
    const start = unwrap(setPlacement(withCabinet().arrangement, "module-1", { x: 250, z: 2000, rotationDeg: 90 })).arrangement;
    const right = unwrap(duplicateModule(start, "module-1", "right"));
    expect(get(right.arrangement, right.id).placement).toEqual({ x: 250, y: 0, z: 1200, rotationDeg: 90 });
    const left = unwrap(duplicateModule(start, "module-1", "left"));
    expect(get(left.arrangement, left.id).placement).toEqual({ x: 250, y: 0, z: 2800, rotationDeg: 90 });
  });

  it("refuses a duplicate that would leave the room or overlap another module", () => {
    const { arrangement } = withCabinet(); // at the left wall
    const result = duplicateModule(arrangement, "module-1", "left");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues[0]).toMatchObject({ code: "no_space_beside", params: { side: "left" } });
    const blocked = unwrap(addModule(arrangement, "cabinet")).arrangement; // module-2 right next to it
    expect(duplicateModule(blocked, "module-1", "right").ok).toBe(false);
  });

  it("keeps the copies' configurations independent", () => {
    const start = unwrap(setPlacement(withCabinet().arrangement, "module-1", { x: 2000 })).arrangement;
    const dup = unwrap(duplicateModule(start, "module-1", "right"));
    const original = get(dup.arrangement, "module-1").configuration as CabinetConfiguration;
    const changed = unwrap(updateModuleConfiguration(dup.arrangement, dup.id, { ...original, height: 900 })).arrangement;
    expect((get(changed, "module-1").configuration as CabinetConfiguration).height).toBe(1800);
    expect((get(changed, dup.id).configuration as CabinetConfiguration).height).toBe(900);
    expect(get(changed, dup.id).configuration).not.toBe(get(changed, "module-1").configuration);
  });

  it("adds a different furniture type beside a module with the backs aligned", () => {
    const start = unwrap(setPlacement(withCabinet().arrangement, "module-1", { x: 1000 })).arrangement;
    const next = unwrap(addModuleNextTo(start, "module-1", "clickbed-o", "right"));
    const bed = get(next.arrangement, next.id);
    expect(bed.typeId).toBe("clickbed-o");
    const corner = moduleCorner(bed);
    expect(corner.z).toBe(0); // back against the same wall as the cabinet
    expect(corner.x).toBe(1400); // directly right of the cabinet (1000 + 800 / 2)
    expect(detectCollisions(next.arrangement)).toEqual([]);
  });
});

describe("configuration changes", () => {
  it("keeps the back-left corner in place when a module changes size", () => {
    const { arrangement, id } = withCabinet();
    const cabinet = get(arrangement, id);
    const wider = unwrap(updateModuleConfiguration(arrangement, id, { ...(cabinet.configuration as CabinetConfiguration), width: 1200, depth: 600 }));
    const after = get(wider.arrangement, id);
    expect(moduleCorner(after)).toEqual(moduleCorner(cabinet));
    expect(after.placement).toMatchObject({ x: 600, z: 300 });
  });

  it("rejects an invalid configuration", () => {
    const { arrangement, id } = withCabinet();
    expect(updateModuleConfiguration(arrangement, id, { ...DEFAULT_CABINET, width: 10 }).ok).toBe(false);
  });

  it("only accepts states the furniture type defines", () => {
    const bed = unwrap(addModule(EMPTY, "clickbed-o"));
    expect(unwrap(setModuleState(bed.arrangement, bed.id, "unfolded")).arrangement.modules[0].state).toBe("unfolded");
    expect(setModuleState(bed.arrangement, bed.id, "open").ok).toBe(false);
    const cabinet = withCabinet();
    expect(setModuleState(cabinet.arrangement, cabinet.id, "unfolded").ok).toBe(false);
  });
});

describe("collision detection", () => {
  it("detects overlapping modules and modules outside the room", () => {
    const { arrangement } = withCabinet();
    const two = unwrap(addModule(arrangement, "cabinet")).arrangement;
    const overlapping = unwrap(setPlacement(two, "module-2", { x: 600 })).arrangement;
    expect(detectCollisions(overlapping)).toEqual([{ kind: "module", moduleId: "module-1", otherId: "module-2", phase: "static" }]);
    const outside = unwrap(setPlacement(two, "module-2", { x: 5900 })).arrangement;
    expect(detectCollisions(outside)).toEqual([{ kind: "outside-room", moduleId: "module-2", phase: "static" }]);
    const tooHigh = unwrap(setPlacement(two, "module-2", { y: 1000 })).arrangement; // 1000 + 1800 > 2700
    expect(detectCollisions(tooHigh)).toEqual([{ kind: "outside-room", moduleId: "module-2", phase: "static" }]);
  });

  function roomWithWindow(sill: number): RoomConfiguration {
    const { room, id } = unwrap(addOpening(EMPTY.room, "window", "back"));
    return unwrap(updateOpening(room, id, { offset: 0, elevation: sill, width: 1200, height: 1200 }));
  }

  it("allows furniture below a window and flags furniture reaching into it", () => {
    const low: CabinetConfiguration = { ...DEFAULT_CABINET, height: 850 };
    const below = unwrap(addModule({ ...EMPTY, room: roomWithWindow(900) }, "cabinet", low)).arrangement;
    expect(detectCollisions(below)).toEqual([]);
    const tall = unwrap(addModule({ ...EMPTY, room: roomWithWindow(900) }, "cabinet")).arrangement; // 1800 high
    expect(detectCollisions(tall)).toEqual([{ kind: "opening", moduleId: "module-1", openingId: "window-1", phase: "static" }]);
  });

  it("keeps a door's clearance free", () => {
    const { room, id } = unwrap(addOpening(EMPTY.room, "door", "left"));
    const placed = unwrap(updateOpening(room, id, { offset: 3000, clearanceDepth: 900 })); // door spans z 100…1000 from the back
    const cabinet = unwrap(addModule({ ...EMPTY, room: placed }, "cabinet")).arrangement; // x 0…800, z 0…500
    expect(detectCollisions(cabinet)).toEqual([{ kind: "opening", moduleId: "module-1", openingId: "door-1", phase: "static" }]);
    const away = unwrap(setPlacement(cabinet, "module-1", { x: 1400 })).arrangement;
    expect(detectCollisions(away)).toEqual([]);
  });

  it("checks a wall bed's operation space even while it is folded", () => {
    const bed = unwrap(addModule(EMPTY, "clickbed-o"));
    const folded = bed.arrangement;
    expect(get(folded, bed.id).state).toBe("folded");
    // A cabinet standing in front of the folded bed, where the bed unfolds.
    const cabinet = unwrap(addModule(folded, "cabinet")).arrangement;
    const inFront = unwrap(setPlacement(cabinet, "module-2", { x: 1000, z: 1200 })).arrangement;
    expect(detectCollisions(inFront)).toEqual([{ kind: "module", moduleId: "module-1", otherId: "module-2", phase: "operation" }]);
    // Unfolded, the same arrangement is a static collision.
    const unfolded = unwrap(setModuleState(inFront, "module-1", "unfolded")).arrangement;
    expect(detectCollisions(unfolded)).toEqual([{ kind: "module", moduleId: "module-1", otherId: "module-2", phase: "static" }]);
  });

  it("flags a bed whose unfolding would hit the opposite wall", () => {
    const narrow = { ...EMPTY, room: { ...EMPTY.room, depth: 1500 } };
    const bed = unwrap(addModule(narrow, "clickbed-o")).arrangement; // 140×200: unfolds to ≥ 1640 mm
    expect(detectCollisions(bed)).toEqual([{ kind: "outside-room", moduleId: "module-1", phase: "operation" }]);
  });

  it("reports a bed folding into a door's clearance as an operation conflict", () => {
    const { room, id } = unwrap(addOpening(EMPTY.room, "door", "front"));
    // Door on the front wall, 900 mm clearance into the room: z 3100…4000 on the front wall's span.
    const door = unwrap(updateOpening({ ...room, depth: 2500 }, id, { offset: 3900, clearanceDepth: 900 }));
    const bed = unwrap(addModule({ ...EMPTY, room: door }, "clickbed-o")).arrangement;
    const config = get(bed, "module-1").configuration as BedConfiguration;
    expect(config.size).toBe("140x200");
    expect(detectCollisions(bed)).toEqual([{ kind: "opening", moduleId: "module-1", openingId: "door-1", phase: "operation" }]);
  });
});
