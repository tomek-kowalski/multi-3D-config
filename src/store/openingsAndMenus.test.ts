import { beforeEach, describe, expect, it } from "vitest";
import { moduleFootprint } from "@/domain/arrangement/spatial";
import { addDoor } from "@/domain/attachments/operations";
import { ROOT_COMPARTMENT_ID } from "@/domain/furniture/defaults";
import type { CabinetConfiguration } from "@/domain/furniture/types";
import { useArrangementStore } from "./useArrangementStore";
import { usePreviewStore } from "./usePreviewStore";

const store = () => useArrangementStore.getState();
const opening = (id: string) => store().arrangement.room.openings.find((o) => o.id === id)!;

beforeEach(() => {
  store().reset();
  usePreviewStore.getState().closeAll();
});

/** Adds a door ("single" / "double") to the cabinet `id`. */
function withCabinetDoor(id: string, layout: "single" | "double") {
  const configuration = store().arrangement.modules.find((m) => m.id === id)!.configuration as CabinetConfiguration;
  const result = addDoor(configuration, ROOT_COMPARTMENT_ID, layout);
  if (!result.ok) throw new Error(result.error.message);
  expect(store().updateModuleConfiguration(id, result.configuration).ok).toBe(true);
}

/** A door on the back wall at `offset`, closed, and its id. */
function door(offset: number): string {
  store().addOpening("door", "back");
  const id = store().selectedOpeningId!;
  store().updateOpening(id, { offset, clearanceDepth: 0 });
  return id;
}

describe("windows and doors on the active wall", () => {
  it("selecting another wall clears the selected window/door; the same wall keeps it", () => {
    const id = door(1000);
    expect(store().activeWall).toBe("back");
    store().setActiveWall("back");
    expect(store().selectedOpeningId).toBe(id);
    store().setActiveWall("left");
    expect(store().selectedOpeningId).toBeNull();
  });

  it("the context menu opens only for an opening of the active wall, and selects it", () => {
    const id = door(1000);
    store().selectOpening(null as unknown as string);
    store().setActiveWall("right");
    store().openOpeningMenu(id, 10, 20);
    expect(store().contextMenu).toBeNull();
    store().setActiveWall("back");
    store().openOpeningMenu(id, 10, 20);
    expect(store().contextMenu).toEqual({ kind: "opening", openingId: id, x: 10, y: 20 });
    expect(store().selectedOpeningId).toBe(id);
  });

  it("opens and closes independently per opening", () => {
    const a = door(200);
    const b = door(2500);
    expect(store().setOpeningOpen(a, true).ok).toBe(true);
    expect(opening(a).open).toBe(true);
    expect(opening(b).open).toBeFalsy();
    expect(store().setOpeningOpen(a, false).ok).toBe(true);
    expect(opening(a).open).toBe(false);
  });

  it("refuses to open a door whose leaf would hit furniture, naming it", () => {
    const id = door(1000);
    store().addModule("cabinet");
    const cabinet = store().arrangement.modules[0].id;
    store().setPlacement(cabinet, { x: 1500, z: 700, rotationDeg: 0 });
    const result = store().setOpeningOpen(id, true);
    expect(result).toEqual({ ok: false, issues: [{ code: "opening_blocked", params: { opening: id, obstacles: cabinet } }] });
    expect(opening(id).open).toBeFalsy();
    // Closing is always possible.
    expect(store().setOpeningOpen(id, false).ok).toBe(true);
  });

  it("dragging uses the positioning assistance and never leaves an invalid position", () => {
    const id = door(1000);
    const p = store().moveOpening(id, 99999, 500);
    expect(p).toMatchObject({ valid: false, reason: { code: "opening_clamped_to_wall" } });
    expect(opening(id).offset).toBe(store().arrangement.room.width - opening(id).width);
    expect(opening(id).elevation).toBe(0); // doors stay on the floor
    expect(store().moveOpening(id, 1200, 0)).toMatchObject({ offset: 1200, valid: true, reason: null });
    expect(opening(id).offset).toBe(1200);
  });
});

describe("furniture context-menu actions", () => {
  it("a bed is not unfolded into a wardrobe; the obstacle is reported", () => {
    store().addModule("clickbed-o");
    const bed = store().arrangement.modules[0];
    const fp = moduleFootprint(bed);
    store().setPlacement(bed.id, { x: 2000, z: fp.depth / 2, rotationDeg: 0 });
    store().addModule("cabinet");
    const cabinet = store().arrangement.modules[1].id;
    store().setPlacement(cabinet, { x: 2000, z: fp.depth + 400, rotationDeg: 0 });
    const result = store().setModuleState(bed.id, "unfolded");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues[0]).toMatchObject({ code: "transform_blocked", params: { module: bed.id, state: "unfolded", obstacles: cabinet } });
    expect(store().arrangement.modules[0].state).toBe("folded");
    // Without the wardrobe in the way it unfolds.
    store().removeModule(cabinet);
    expect(store().setModuleState(bed.id, "unfolded").ok).toBe(true);
    expect(store().arrangement.modules[0].state).toBe("unfolded");
  });

  it("opens all fronts of a cabinet that has room, and closes them again", () => {
    store().addModule("cabinet");
    const id = store().arrangement.modules[0].id;
    withCabinetDoor(id, "double");
    store().setPlacement(id, { x: 2000, z: 250, rotationDeg: 0 });
    const fronts = store().arrangement.modules[0].configuration as { attachments: { id: string }[] };
    expect(fronts.attachments.length).toBeGreaterThan(0);
    expect(store().setFrontsOpen(id, true).ok).toBe(true);
    const open = usePreviewStore.getState().openAttachmentIds;
    for (const a of fronts.attachments) expect(open.has(a.id)).toBe(true);
    expect(store().setFrontsOpen(id, false).ok).toBe(true);
    expect(usePreviewStore.getState().openAttachmentIds.size).toBe(0);
  });

  it("keeps blocked fronts closed and says what is in the way", () => {
    store().addModule("cabinet");
    const id = store().arrangement.modules[0].id;
    withCabinetDoor(id, "single");
    store().setPlacement(id, { x: 2000, z: 250, rotationDeg: 0 });
    store().addModule("cabinet");
    const other = store().arrangement.modules[1].id;
    store().setPlacement(other, { x: 2000, z: 1050, rotationDeg: 180 });
    const result = store().setFrontsOpen(id, true);
    expect(result).toMatchObject({ ok: false, issues: [{ code: "fronts_blocked", params: { module: id, count: 1, obstacles: other } }] });
    expect(store().selectedModuleId).toBe(id);
    expect(usePreviewStore.getState().openAttachmentIds.size).toBe(0);
  });
});

describe("one selection at a time", () => {
  it("selecting furniture deselects the wall and its window/door until a wall is selected again", () => {
    const id = door(1000);
    expect(store().wallSelected).toBe(true);
    store().addModule("cabinet");
    const cabinet = store().arrangement.modules[0].id;
    expect(store().selectedModuleId).toBe(cabinet);
    expect(store().wallSelected).toBe(false);
    expect(store().selectedOpeningId).toBeNull();
    // The hidden wall's windows/doors do not react while furniture is selected.
    store().openOpeningMenu(id, 1, 1);
    expect(store().contextMenu).toBeNull();
    // Deselecting the furniture does not bring the wall selection back.
    store().selectModule(null);
    expect(store().wallSelected).toBe(false);
    // Selecting the same wall again (label, wall card) deselects furniture and highlights it.
    store().selectModule(cabinet);
    store().setActiveWall("back");
    expect(store().wallSelected).toBe(true);
    expect(store().selectedModuleId).toBeNull();
  });

  it("selecting a window/door deselects the furniture; right-clicking furniture deselects the wall", () => {
    const id = door(1000);
    store().addModule("cabinet");
    const cabinet = store().arrangement.modules[0].id;
    store().selectOpening(id);
    expect(store().selectedModuleId).toBeNull();
    expect(store().wallSelected).toBe(true);
    store().openContextMenu(cabinet, 5, 5);
    expect(store().selectedModuleId).toBe(cabinet);
    expect(store().wallSelected).toBe(false);
    expect(store().selectedOpeningId).toBeNull();
  });
});
