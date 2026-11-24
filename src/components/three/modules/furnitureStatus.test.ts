import { describe, expect, it } from "vitest";
import { detectCollisions } from "@/domain/arrangement/collisions";
import { addModule, setModuleState, setPlacement } from "@/domain/arrangement/operations";
import type { Arrangement } from "@/domain/arrangement/types";
import { DEFAULT_ROOM } from "@/domain/room/defaults";
import { furnitureStatus, furnitureStatuses, openingStatuses, STATUS_COLORS } from "./furnitureStatus";

function unwrap<T>(r: { ok: true; value: T } | { ok: false; issues: readonly unknown[] }): T {
  if (!r.ok) throw new Error(JSON.stringify(r.issues));
  return r.value;
}

/** A cabinet and a ClickBed O side by side, nothing colliding. */
function arrangement(): Arrangement {
  let a: Arrangement = { room: { ...DEFAULT_ROOM, width: 6000, depth: 4000 }, modules: [] };
  a = unwrap(addModule(a, "cabinet")).arrangement;
  a = unwrap(addModule(a, "clickbed-o")).arrangement;
  return a;
}

const ids = (a: Arrangement) => a.modules.map((m) => m.id);

describe("furniture status outlines", () => {
  it("collision > valid (while moving) > selected > normal", () => {
    expect(furnitureStatus({ colliding: true, moving: true, selected: true })).toBe("collision");
    expect(furnitureStatus({ colliding: false, moving: true, selected: true })).toBe("valid");
    expect(furnitureStatus({ colliding: false, moving: false, selected: true })).toBe("selected");
    expect(furnitureStatus({ colliding: false, moving: false, selected: false })).toBe("normal");
    expect(STATUS_COLORS).toEqual({ selected: "#2563eb", valid: "#16a34a", collision: "#dc2626" });
  });

  it("outlines a selected cabinet or bed in blue, and no other module", () => {
    const a = arrangement();
    expect(detectCollisions(a)).toEqual([]);
    expect([...furnitureStatuses(ids(a), [], "module-1", null)]).toEqual([["module-1", "selected"]]);
    expect([...furnitureStatuses(ids(a), [], "module-2", null)]).toEqual([["module-2", "selected"]]);
    // Correctly placed, unselected furniture has its normal look.
    expect(furnitureStatuses(ids(a), [], null, null).size).toBe(0);
  });

  it("is green only while a module is being moved to a free position", () => {
    const a = arrangement();
    expect([...furnitureStatuses(ids(a), detectCollisions(a), "module-2", "module-2")]).toEqual([["module-2", "valid"]]);
    // Dropped: back to selected.
    expect([...furnitureStatuses(ids(a), detectCollisions(a), "module-2", null)]).toEqual([["module-2", "selected"]]);
  });

  it("is red for both modules of a collision, over selection and movement, until it is resolved", () => {
    let a = arrangement();
    a = unwrap(setPlacement(a, "module-2", { x: 900 })).arrangement; // bed pushed onto the cabinet
    const issues = detectCollisions(a);
    expect(issues.length).toBeGreaterThan(0);
    expect(Object.fromEntries(furnitureStatuses(ids(a), issues, "module-2", "module-2"))).toEqual({ "module-1": "collision", "module-2": "collision" });
    const resolved = unwrap(setPlacement(a, "module-2", { x: 3000 })).arrangement;
    expect(Object.fromEntries(furnitureStatuses(ids(resolved), detectCollisions(resolved), "module-2", null))).toEqual({ "module-2": "selected" });
  });

  it("also flags a bed that could not unfold (its operating space blocked)", () => {
    let a = arrangement();
    a = unwrap(addModule(a, "cabinet")).arrangement;
    const bed = a.modules[1];
    // A cabinet standing in front of the folded bed, where it unfolds.
    a = unwrap(setPlacement(a, "module-3", { x: bed.placement.x, z: 1300 })).arrangement;
    const issues = detectCollisions(a);
    expect(issues.some((i) => i.phase === "operation")).toBe(true);
    expect(furnitureStatuses(ids(a), issues, null, null).get("module-2")).toBe("collision");
    // Unfolding is not needed for this: the folded state is what is shown.
    expect(unwrap(setModuleState(a, "module-2", "folded")).arrangement.modules[1].state).toBe("folded");
  });
});

describe("window and door outlines", () => {
  const ids = ["window-1", "door-1"];
  it("blue when selected, green while dragged freely, red when corrected or in conflict", () => {
    expect(openingStatuses(ids, [], null, null).size).toBe(0);
    expect(openingStatuses(ids, [], "window-1", null).get("opening:window-1")).toBe("selected");
    expect(openingStatuses(ids, [], "window-1", { id: "window-1", valid: true }).get("opening:window-1")).toBe("valid");
    expect(openingStatuses(ids, [], "window-1", { id: "window-1", valid: false }).get("opening:window-1")).toBe("collision");
    const conflict = openingStatuses(ids, [{ kind: "opening", moduleId: "module-1", openingId: "door-1", phase: "static" }], null, null);
    expect([...conflict]).toEqual([["opening:door-1", "collision"]]);
  });
});
