// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useLocaleStore } from "@/i18n";
import { useArrangementStore } from "@/store/useArrangementStore";
import { RoomConfigurator } from "./RoomConfigurator";

// The 3D canvas needs WebGL; the layout around it is what is tested here.
vi.mock("next/dynamic", () => ({ default: () => () => <canvas data-testid="room-canvas" /> }));

const store = () => useArrangementStore.getState();

beforeEach(() => {
  useLocaleStore.setState({ locale: "pl" });
  store().reset();
  store().setMenuCollapsed(false);
  for (const type of ["cabinet", "clickbed-o"]) store().addModule(type);
});
afterEach(cleanup);

const toggle = () => screen.getByRole("button", { name: /Zwiń menu|Rozwiń menu/ });

describe("collapsible main menu", () => {
  it("collapses to the header and expands again; header and toggle always visible", () => {
    const { container } = render(<RoomConfigurator />);
    const content = container.querySelector("#main-menu-content") as HTMLElement;
    expect(toggle().getAttribute("aria-expanded")).toBe("true");
    expect(content.hidden).toBe(false);

    fireEvent.click(toggle());
    expect(store().menuCollapsed).toBe(true);
    expect(toggle().getAttribute("aria-label")).toBe("Rozwiń menu");
    expect(toggle().getAttribute("aria-expanded")).toBe("false");
    expect(content.hidden).toBe(true);
    expect(content.hasAttribute("inert")).toBe(true);
    // Only the header remains: Konfigurator — Meble w Twoim pomieszczeniu, once.
    expect(screen.getAllByText("Konfigurator")).toHaveLength(1);
    expect(screen.getAllByRole("heading", { name: "Meble w Twoim pomieszczeniu" })).toHaveLength(1);
    // No tabs, inputs or order button reachable.
    expect(screen.queryByRole("navigation", { name: "Menu konfiguracji" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Zamówienie" })).toBeNull();

    fireEvent.click(toggle());
    expect(content.hidden).toBe(false);
    expect(screen.getByRole("button", { name: "Zamówienie" })).toBeTruthy();
  });

  it("gives the space to the 3D view: no sidebar width while collapsed", () => {
    const { container } = render(<RoomConfigurator />);
    const root = container.firstElementChild as HTMLElement;
    const aside = container.querySelector("aside") as HTMLElement;
    const workspace = container.querySelector("[data-3d-workspace]") as HTMLElement;
    expect(aside.className).toContain("lg:w-[420px]");
    fireEvent.click(toggle());
    expect(root.dataset.menuCollapsed).toBe("true");
    expect(aside.className).toContain("lg:w-0");
    expect(aside.className).not.toContain("lg:w-[420px]");
    expect(workspace.className).toContain("flex-1"); // stacked layouts: the view fills the height
    expect(container.querySelector("[data-header-card]")).toBeNull(); // stacked layout: header bar below the view
    expect(screen.getByTestId("room-canvas")).toBeTruthy(); // the scene stays mounted
  });

  it("on desktop shows the collapsed header as a card over the 3D view", () => {
    vi.stubGlobal("matchMedia", (query: string) => ({ matches: query.includes("1024"), addEventListener: () => {}, removeEventListener: () => {} }));
    const { container } = render(<RoomConfigurator />);
    fireEvent.click(toggle());
    const card = container.querySelector("[data-header-card]") as HTMLElement;
    expect(card.textContent).toContain("Meble w Twoim pomieszczeniu");
    expect(screen.getAllByRole("heading", { name: "Meble w Twoim pomieszczeniu" })).toHaveLength(1);
    fireEvent.click(toggle());
    expect(container.querySelector("[data-header-card]")).toBeNull();
    vi.unstubAllGlobals();
  });

  it("is purely visual: tab, selection, configuration and arrangement are untouched", () => {
    store().selectModule("module-2");
    store().setActiveMenu("module");
    render(<RoomConfigurator />);
    const before = JSON.stringify({ a: store().arrangement, s: store().selectedModuleId, w: store().activeWall });
    fireEvent.click(toggle());
    fireEvent.click(toggle());
    expect(JSON.stringify({ a: store().arrangement, s: store().selectedModuleId, w: store().activeWall })).toBe(before);
    expect(store().activeMenu).toBe("module");
    expect(screen.getByRole("button", { current: "page" }).textContent).toMatch(/Moduł/);
  });
});
