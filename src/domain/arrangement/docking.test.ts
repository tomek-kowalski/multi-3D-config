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

});

describe("docking works across furniture types", () => {
  /** Places module-1 (`first`) and module-2 (`second`) at the given positions. */
  function pair(first: string, at1: Parameters<typeof setPlacement>[2], second: string, at2: Parameters<typeof setPlacement>[2]) {
    let a: Arrangement = { room: ROOM, modules: [] };
    a = unwrap(addModule(a, first)).arrangement;
    a = unwrap(setPlacement(a, "module-1", at1)).arrangement;
    a = unwrap(addModule(a, second)).arrangement;
    return unwrap(setPlacement(a, "module-2", at2)).arrangement;
  }

  it("docks a bed next to a bed (left and right, by their real outlines)", () => {
    // ClickBed O 140×200: footprint 2162 × 400, centred at x 2000 against the back wall.
    expect(proposeDocking(pair("clickbed-o", { x: 2000 }, "clickbed-o", { x: 4222, z: 230 }), "module-2")).toMatchObject({
      side: "right",
      placement: { x: 4162, z: 200 },
    });
    expect(proposeDocking(pair("clickbed-o", { x: 3500 }, "clickbed-o", { x: 1300, z: 200 }), "module-2")).toMatchObject({
      side: "left",
      placement: { x: 1338, z: 200 },
    });
  });

  it("docks a cabinet next to a bed and a bed next to a cabinet, backs aligned", () => {
    // Cabinet (800 × 500) right of the bed: centre 2000 + 1081 + 400; back on the bed's back (z 250).
    expect(proposeDocking(pair("clickbed-o", { x: 2000 }, "cabinet", { x: 3500, z: 260 }), "module-2")).toMatchObject({
      targetId: "module-1",
      side: "right",
      placement: { x: 3481, z: 250 },
    });
    // Bed right of the cabinet: centre 2000 + 400 + 1081; back on the cabinet's back (z 200).
    expect(proposeDocking(pair("cabinet", { x: 2000 }, "clickbed-o", { x: 3520, z: 210 }), "module-2")).toMatchObject({
      side: "right",
      placement: { x: 3481, z: 200 },
    });
  });

  it("keeps the unfolding space of a transforming bed free", () => {
    // module-2 (bed) near the right of module-1 (bed): valid while nothing stands where it unfolds…
    const base = pair("clickbed-o", { x: 2000 }, "clickbed-o", { x: 4222, z: 230 });
    expect(proposeDocking(base, "module-2")).not.toBeNull();
    // …but a cabinet in front of the docking spot (clear of the folded bed, inside its unfolding
    // envelope) makes the spot invalid.
    let blocked = unwrap(addModule(base, "cabinet")).arrangement;
    blocked = unwrap(setPlacement(blocked, "module-3", { x: 4162, z: 1200 })).arrangement;
    expect(proposeDocking(blocked, "module-2")).toBeNull();
  });

  it("keeps wall-mounting requirements: a wall-mounted bed only docks where its back is on a wall", () => {
    const atWall = pair("clickbed-o-classico", { x: 2000 }, "clickbed-o-classico", { x: 4240, z: 220 });
    expect(proposeDocking(atWall, "module-2")).toMatchObject({ placement: { x: 4180, z: 200 } });
    // Target 300 mm in front of the wall: the docked bed would not be fixed to a wall either.
    const awayFromWall = pair("clickbed-o-classico", { x: 2000, z: 500 }, "clickbed-o-classico", { x: 4240, z: 520 });
    expect(proposeDocking(awayFromWall, "module-2")).toBeNull();
  });

  it("leaves both configurations independent after docking", () => {
    const a = pair("clickbed-o", { x: 2000 }, "clickbed-o", { x: 4222, z: 230 });
    const proposal = proposeDocking(a, "module-2")!;
    const docked = unwrap(setPlacement(a, "module-2", proposal.placement)).arrangement;
    expect(docked.modules[0].configuration).toBe(a.modules[0].configuration);
    expect(docked.modules[1].configuration).toBe(a.modules[1].configuration);
    expect(docked.modules[0].configuration).not.toBe(docked.modules[1].configuration);
    expect(detectCollisions(docked)).toEqual([]);
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
