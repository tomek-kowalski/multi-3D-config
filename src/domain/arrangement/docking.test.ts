import { beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_CABINET } from "../furniture/defaults";
import { DEFAULT_ROOM } from "../room/defaults";
import { addOpening, updateOpening } from "../room/operations";
import { useArrangementStore } from "@/store/useArrangementStore";
import { detectCollisions } from "./collisions";
import { proposeDocking, DOCKING_DISTANCE_MM } from "./docking";
import { addModule, setPlacement } from "./operations";
import type { Arrangement } from "./types";

function unwrap<T>(r: { ok: true; value: T } | { ok: false; issues: readonly unknown[] }): T {
  if (!r.ok) throw new Error(JSON.stringify(r.issues));
  return r.value;
}

const ROOM = { ...DEFAULT_ROOM, width: 6000, depth: 4000, height: 2700 };

/** Cabinet module-1 at x 2000 against the back wall, cabinet module-2 wherever `second` puts it. */
function twoCabinets(second: Parameters<typeof setPlacement>[2], room = ROOM, config = DEFAULT_CABINET): Arrangement {
  let a: Arrangement = { room, modules: [] };
  a = unwrap(addModule(a, "cabinet")).arrangement;
  a = unwrap(setPlacement(a, "module-1", { x: 2000 })).arrangement;
  a = unwrap(addModule(a, "cabinet", config)).arrangement;
  return unwrap(setPlacement(a, "module-2", second)).arrangement;
}

describe("docking proposals", () => {
  it("proposes the exact right-hand and left-hand positions of a nearby cabinet", () => {
    expect(proposeDocking(twoCabinets({ x: 2850, z: 280 }), "module-2")).toMatchObject({
      targetId: "module-1",
      side: "right",
      placement: { x: 2800, z: 250, y: 0, rotationDeg: 0 },
    });
    expect(proposeDocking(twoCabinets({ x: 1150, z: 250 }), "module-2")).toMatchObject({
      side: "left",
      placement: { x: 1200, z: 250 },
    });
  });

  it("uses both cabinets' real sizes: different depths keep the backs aligned", () => {
    const deeper = { ...DEFAULT_CABINET, width: 600, depth: 600 };
    expect(proposeDocking(twoCabinets({ x: 2720, z: 320 }, ROOM, deeper), "module-2")?.placement).toMatchObject({ x: 2700, z: 300 });
  });

  it("respects orientation: left/right follow the target's rotation, other orientations are not docked", () => {
    let a: Arrangement = { room: ROOM, modules: [] };
    a = unwrap(addModule(a, "cabinet")).arrangement;
    a = unwrap(setPlacement(a, "module-1", { x: 250, z: 2000, rotationDeg: 90 })).arrangement; // against the left wall
    a = unwrap(addModule(a, "cabinet")).arrangement;
    const rotated = unwrap(setPlacement(a, "module-2", { x: 260, z: 1230, rotationDeg: 90 })).arrangement;
    // Facing +X, the cabinet's right-hand side is towards the back wall (−Z).
    expect(proposeDocking(rotated, "module-2")).toMatchObject({ side: "right", placement: { x: 250, z: 1200, rotationDeg: 90 } });
    const turned = unwrap(setPlacement(a, "module-2", { x: 260, z: 1230, rotationDeg: 0 })).arrangement;
    expect(proposeDocking(turned, "module-2")).toBeNull();
  });

  it("proposes nothing when the cabinet is far away or already docked", () => {
    expect(proposeDocking(twoCabinets({ x: 2800 + DOCKING_DISTANCE_MM + 10, z: 250 }), "module-2")).toBeNull();
    expect(proposeDocking(twoCabinets({ x: 2800, z: 250 }), "module-2")).toBeNull();
  });

  it("never proposes a position that collides with an opening, a wall or other furniture", () => {
    const { room, id } = unwrap(addOpening(ROOM, "window", "back"));
    const withWindow = unwrap(updateOpening(room, id, { offset: 2400 })); // window over x 2400…3600 from 900 mm up
    expect(proposeDocking(twoCabinets({ x: 2850, z: 250 }, withWindow), "module-2")).toBeNull();
    // Left of a cabinet standing in the corner would be outside the room.
    let a: Arrangement = { room: ROOM, modules: [] };
    a = unwrap(addModule(a, "cabinet")).arrangement; // x 400 in the corner
    a = unwrap(addModule(a, "cabinet")).arrangement;
    a = unwrap(setPlacement(a, "module-2", { x: 300, z: 900 })).arrangement;
    const proposal = proposeDocking(a, "module-2");
    if (proposal) {
      const applied = unwrap(setPlacement(a, "module-2", proposal.placement)).arrangement;
      expect(detectCollisions(applied)).toEqual([]);
    }
    const valid = proposeDocking(twoCabinets({ x: 2850, z: 250 }), "module-2")!;
    const docked = unwrap(setPlacement(twoCabinets({ x: 2850, z: 250 }), "module-2", valid.placement)).arrangement;
    expect(detectCollisions(docked)).toEqual([]);
  });

  it("does not dock beds or other non-cabinet furniture", () => {
    let a: Arrangement = { room: ROOM, modules: [] };
    a = unwrap(addModule(a, "cabinet")).arrangement;
    a = unwrap(setPlacement(a, "module-1", { x: 3000 })).arrangement;
    a = unwrap(addModule(a, "clickbed-o")).arrangement;
    a = unwrap(setPlacement(a, "module-2", { x: 3000 + 400 + 1081 + 40, z: 200 })).arrangement; // bed 40 mm right of the cabinet
    expect(proposeDocking(a, "module-2")).toBeNull();
    expect(proposeDocking(a, "module-1")).toBeNull();
  });
});

describe("docking needs the customer's confirmation", () => {
  beforeEach(() => useArrangementStore.getState().reset());

  function nearby() {
    const store = useArrangementStore.getState();
    store.replaceArrangement(twoCabinets({ x: 2850, z: 280 }));
    store.selectModule("module-2");
    store.proposeDockingFor("module-2");
  }
  const position = () => useArrangementStore.getState().arrangement.modules.find((m) => m.id === "module-2")!.placement;

  it("shows a proposal without moving anything", () => {
    nearby();
    expect(useArrangementStore.getState().dockingProposal).toMatchObject({ side: "right", placement: { x: 2800, z: 250 } });
    expect(position()).toMatchObject({ x: 2850, z: 280 });
  });

  it("keeps the manual position when the customer rejects", () => {
    nearby();
    useArrangementStore.getState().rejectDocking();
    expect(useArrangementStore.getState().dockingProposal).toBeNull();
    expect(position()).toMatchObject({ x: 2850, z: 280 });
  });

  it("moves only the docked cabinet when the customer confirms", () => {
    nearby();
    const before = useArrangementStore.getState().arrangement.modules[0];
    expect(useArrangementStore.getState().confirmDocking().ok).toBe(true);
    expect(position()).toMatchObject({ x: 2800, z: 250 });
    expect(useArrangementStore.getState().arrangement.modules[0]).toBe(before);
    expect(useArrangementStore.getState().dockingProposal).toBeNull();
  });

  it("drops the proposal when the cabinet is moved again, and can be switched off", () => {
    nearby();
    useArrangementStore.getState().setPlacement("module-2", { x: 2860 });
    expect(useArrangementStore.getState().dockingProposal).toBeNull();
    useArrangementStore.getState().setDockingEnabled(false);
    useArrangementStore.getState().proposeDockingFor("module-2");
    expect(useArrangementStore.getState().dockingProposal).toBeNull();
  });
});
