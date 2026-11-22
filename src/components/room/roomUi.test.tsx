// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { sceneOpenings, wallHighlights } from "@/components/three/room/roomScene";
import { WallLabelOverlay } from "@/components/three/room/WallLabels";
import { addModule, setPlacement } from "@/domain/arrangement/operations";
import type { Arrangement } from "@/domain/arrangement/types";
import { DEFAULT_ROOM } from "@/domain/room/defaults";
import { addOpening } from "@/domain/room/operations";
import type { RoomConfiguration } from "@/domain/room/types";
import { useLocaleStore } from "@/i18n";
import { useArrangementStore } from "@/store/useArrangementStore";
import { SpacePanel } from "./SpacePanel";
import { DockingPrompt, ViewOverlay } from "./ViewOverlay";

function unwrap<T>(r: { ok: true; value: T } | { ok: false; issues: readonly unknown[] }): T {
  if (!r.ok) throw new Error(JSON.stringify(r.issues));
  return r.value;
}

afterEach(cleanup);
beforeEach(() => {
  useLocaleStore.setState({ locale: "pl" });
  useArrangementStore.getState().reset();
  useArrangementStore.setState({ showWallLabels: true, dockingEnabled: true });
});

const store = () => useArrangementStore.getState();
const button = (name: string | RegExp) => screen.getByRole("button", { name });

/** Two windows on the back wall (A), one door on the left wall (D), nothing on B and C. */
function roomWithOpenings(): RoomConfiguration {
  let room: RoomConfiguration = DEFAULT_ROOM;
  room = unwrap(addOpening(room, "window", "back")).room;
  room = unwrap(addOpening(room, "window", "back")).room;
  room = unwrap(addOpening(room, "door", "left")).room;
  return room;
}

describe("adding windows and doors in the menu", () => {
  it("places new openings automatically and explains when the wall is full", () => {
    render(<SpacePanel />);
    for (let i = 0; i < 3; i++) fireEvent.click(button("+ Okno"));
    expect(store().arrangement.room.openings.map((o) => o.offset)).toEqual([0, 1200, 2400]);
    expect(screen.queryByRole("alert")).toBeNull();
    fireEvent.click(button("+ Okno"));
    expect(screen.getByRole("alert").textContent).toContain("Brak miejsca na ścianie A");
    expect(store().arrangement.room.openings).toHaveLength(3);
  });
});

describe("opening settings follow the selected wall", () => {
  beforeEach(() => store().replaceArrangement({ room: roomWithOpenings(), modules: [] }));
  const cardTitles = () => screen.queryAllByRole("button", { name: /^(Okno|Drzwi) · / }).map((b) => b.textContent);

  it("lists only the openings of the selected wall", () => {
    render(<SpacePanel />);
    expect(screen.getByRole("heading", { name: "Ściana A (tylna)" })).toBeTruthy();
    expect(cardTitles()).toEqual(["Okno · window-1", "Okno · window-2"]);
    fireEvent.click(document.querySelector('[data-wall-card="left"]')!);
    expect(screen.getByRole("heading", { name: "Ściana D (lewa)" })).toBeTruthy();
    expect(cardTitles()).toEqual(["Drzwi · door-1"]);
    // Every field of the opening is there.
    const card = within(document.querySelector("[data-openings-for='left']") as HTMLElement);
    for (const label of ["Od lewego końca ściany", "Od podłogi", "Szerokość", "Wysokość", "Strefa wolna przed otworem"]) {
      expect(card.getByLabelText(label)).toBeTruthy();
    }
    expect(card.getByRole("button", { name: "Usuń" })).toBeTruthy();
  });

  it("shows only the wall and the add buttons for a wall without openings", () => {
    render(<SpacePanel />);
    fireEvent.click(document.querySelector('[data-wall-card="right"]')!);
    expect(screen.getByRole("heading", { name: "Ściana B (prawa)" })).toBeTruthy();
    expect(button("+ Okno")).toBeTruthy();
    expect(button("+ Drzwi")).toBeTruthy();
    expect(cardTitles()).toEqual([]);
    expect(document.querySelector("[data-openings-for]")).toBeNull();
  });

  it("does not change any opening when switching walls, and the 3D scene keeps all of them", () => {
    const before = structuredClone(store().arrangement.room.openings);
    render(<SpacePanel />);
    for (const wall of ["left", "right", "front", "back", "left"]) fireEvent.click(document.querySelector(`[data-wall-card="${wall}"]`)!);
    expect(store().arrangement.room.openings).toEqual(before);
    expect(sceneOpenings(store().arrangement.room).map((o) => o.id)).toEqual(["window-1", "window-2", "door-1"]);
  });
});

describe("wall labels", () => {
  const labels = () => [...document.querySelectorAll("[data-wall-labels] button")].map((b) => b.textContent);

  it("can be shown and hidden with the checkbox, without touching the wall selection", () => {
    render(
      <>
        <SpacePanel />
        <WallLabelOverlay />
      </>,
    );
    expect(labels()).toEqual(["Ściana A (tylna)", "Ściana B (prawa)", "Ściana C (przednia)", "Ściana D (lewa)"]);
    const checkbox = screen.getByRole("checkbox", { name: "Pokaż oznaczenia ścian" }) as HTMLInputElement;
    expect(checkbox.checked).toBe(true);
    fireEvent.click(checkbox);
    expect(document.querySelector("[data-wall-labels]")).toBeNull();
    expect(store().activeWall).toBe("back");
    fireEvent.click(checkbox);
    expect(labels()).toHaveLength(4);
  });

  it("selects the clicked wall, moves the highlight and opens its settings", () => {
    store().setActiveMenu("arrangement");
    render(
      <>
        <SpacePanel />
        <WallLabelOverlay />
      </>,
    );
    // Labels stay visibility:hidden until the in-canvas projector positions them (no WebGL in jsdom).
    // Hidden elements get no computed accessible name, so the label is found by its wall instead.
    const label = () => document.querySelector('[data-wall-label="front"]') as HTMLButtonElement;
    expect(label().getAttribute("aria-label")).toBe("Zaznacz: Ściana C (przednia)");
    fireEvent.click(label());
    expect(store().activeWall).toBe("front");
    expect(store().activeMenu).toBe("space");
    expect(wallHighlights(store().activeWall)).toEqual({ back: false, right: false, front: true, left: false });
    // The menu and the labels agree on the active wall.
    expect(document.querySelector('[data-wall-card="front"]')!.hasAttribute("data-active")).toBe(true);
    expect(document.querySelectorAll("[data-wall-card][data-active]")).toHaveLength(1);
    expect(label().getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("heading", { name: "Ściana C (przednia)" })).toBeTruthy();
  });
});

describe("room dimensions panel", () => {
  it("is opened from a button beneath the two view buttons", () => {
    render(<ViewOverlay />);
    const controls = document.querySelector("[data-view-controls]")!;
    const names = [...controls.querySelectorAll("button")].map((b) => b.textContent);
    expect(names).toEqual(["Całe pomieszczenie", "Wybrany moduł", "Wymiary pomieszczenia"]);
    // The first two share a row; the dimensions button is the next row below them.
    expect(controls.firstElementChild!.querySelectorAll("button")).toHaveLength(2);
    expect(controls.lastElementChild!.textContent).toBe("Wymiary pomieszczenia");
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("opens at the top centre, edits the room through the existing validation, and keeps values when closed", () => {
    render(<ViewOverlay />);
    fireEvent.click(button("Wymiary pomieszczenia"));
    const panel = screen.getByRole("dialog", { name: "Wymiary pomieszczenia" });
    expect(panel.className).toContain("left-1/2");
    expect(panel.className).toContain("-translate-x-1/2");
    expect(panel.className).toContain("top-24");

    fireEvent.click(within(panel).getByRole("button", { name: "Zwiększ: Szerokość" }));
    expect(store().arrangement.room.width).toBe(4001);
    const depth = within(panel).getByLabelText("Głębokość") as HTMLInputElement;
    fireEvent.change(depth, { target: { value: "500" } });
    fireEvent.keyDown(depth, { key: "Enter" });
    expect(within(panel).getByRole("alert").textContent).toContain("1000");
    expect(store().arrangement.room.depth).toBe(3500);

    fireEvent.click(within(panel).getByRole("button", { name: /Zamknij/ }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(store().arrangement.room.width).toBe(4001);
    fireEvent.click(button("Wymiary pomieszczenia"));
    expect((within(screen.getByRole("dialog")).getByLabelText("Szerokość") as HTMLInputElement).value).toBe("4001");
  });
});

describe("docking confirmation", () => {
  function proposeNearby() {
    let a: Arrangement = { room: { ...DEFAULT_ROOM, width: 6000 }, modules: [] };
    a = unwrap(addModule(a, "cabinet")).arrangement;
    a = unwrap(setPlacement(a, "module-1", { x: 2000 })).arrangement;
    a = unwrap(addModule(a, "cabinet")).arrangement;
    a = unwrap(setPlacement(a, "module-2", { x: 2860, z: 260 })).arrangement;
    store().replaceArrangement(a);
    store().proposeDockingFor("module-2");
  }
  const position = () => store().arrangement.modules.find((m) => m.id === "module-2")!.placement;

  it("asks before moving and keeps the manual position when rejected", () => {
    proposeNearby();
    render(<DockingPrompt />);
    expect(screen.getByRole("alertdialog").textContent).toContain("do prawej strony szafki module-1");
    fireEvent.click(button("Zostaw tutaj"));
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(position()).toMatchObject({ x: 2860, z: 260 });
  });

  it("applies the docking position on confirmation", () => {
    proposeNearby();
    render(<DockingPrompt />);
    fireEvent.click(button("Dosuń"));
    expect(position()).toMatchObject({ x: 2800, z: 250 });
  });
});
