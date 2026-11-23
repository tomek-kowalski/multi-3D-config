// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NumericFieldControl } from "@/components/configurator/DimensionField";
import { RoomDimensions, SpacePanel } from "@/components/room/SpacePanel";
import { useLocaleStore } from "@/i18n";
import { useArrangementStore } from "@/store/useArrangementStore";
import { useConfiguratorStore } from "@/store/useConfiguratorStore";
import { MmField } from "./fields";
import { canStep, stepValue } from "./stepper";

afterEach(cleanup);
beforeEach(() => {
  useLocaleStore.setState({ locale: "pl" });
  useArrangementStore.getState().reset();
  useConfiguratorStore.getState().reset();
});

describe("stepValue", () => {
  it("steps by the field's increment within min and max", () => {
    expect(stepValue(800, 1)).toBe(801);
    expect(stepValue(800, -1)).toBe(799);
    expect(stepValue(800, 1, { step: 10 })).toBe(810);
    expect(stepValue(2400, 1, { min: 300, max: 2400 })).toBe(2400);
    expect(stepValue(300, -1, { min: 300, max: 2400 })).toBe(300);
    expect(stepValue(2395, 1, { step: 10, max: 2400 })).toBe(2400);
  });

  it("brings out-of-range or empty entries back into range and never accumulates float noise", () => {
    expect(stepValue(5000, -1, { min: 300, max: 2400 })).toBe(2400);
    expect(stepValue(10, 1, { min: 300, max: 2400 })).toBe(300);
    expect(stepValue(Number.NaN, 1, { min: 300 })).toBe(300);
    expect(stepValue(794.8, 1)).toBe(796); // whole millimetres
    let v = 0;
    for (let i = 0; i < 3; i++) v = stepValue(v, 1, { step: 0.1 });
    expect(v).toBe(0.3);
  });

  it("knows when a bound is reached", () => {
    expect(canStep(2400, 1, { max: 2400 })).toBe(false);
    expect(canStep(2400, -1, { max: 2400 })).toBe(true);
    expect(canStep(300, -1, { min: 300 })).toBe(false);
  });
});

describe("MmField", () => {
  /** A field bound to state like the real store: accepted values become the new value. */
  function setup(value = 100, range: { min?: number; max?: number } = {}) {
    const onCommit = vi.fn((v: number) => (v > 150 ? [{ code: "above_maximum", params: { max: 150 } }] : []));
    function Harness() {
      const [current, setCurrent] = useState(value);
      return (
        <MmField
          label="Szerokość"
          value={current}
          onCommit={(v) => {
            const issues = onCommit(v);
            if (issues.length === 0) setCurrent(v);
            return issues;
          }}
          {...range}
        />
      );
    }
    render(<Harness />);
    return { onCommit, input: screen.getByLabelText("Szerokość") as HTMLInputElement };
  }

  it("increments and decrements by 1 mm and commits immediately", () => {
    const { onCommit, input } = setup();
    fireEvent.click(screen.getByRole("button", { name: "Zwiększ: Szerokość" }));
    expect(onCommit).toHaveBeenLastCalledWith(101);
    expect(input.value).toBe("101");
    fireEvent.click(screen.getByRole("button", { name: "Zmniejsz: Szerokość" }));
    expect(onCommit).toHaveBeenLastCalledWith(100);
  });

  it("disables the buttons at the bounds", () => {
    setup(150, { min: 0, max: 150 });
    expect((screen.getByRole("button", { name: "Zwiększ: Szerokość" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Zmniejsz: Szerokość" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("keeps keyboard entry: typed values commit on Enter and rejected ones show their error", () => {
    const { onCommit, input } = setup();
    fireEvent.change(input, { target: { value: "120" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onCommit).toHaveBeenLastCalledWith(120);
    fireEvent.change(input, { target: { value: "200" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(screen.getByRole("alert").textContent).toContain("150");
    expect(input.value).toBe("200");
  });
});

describe("numeric controls drive the configuration the 3D scene renders", () => {
  it("room width +/− updates the arrangement store", () => {
    render(<RoomDimensions />);
    const [plus] = screen.getAllByRole("button", { name: "Zwiększ: Szerokość" });
    fireEvent.click(plus);
    expect(useArrangementStore.getState().arrangement.room.width).toBe(4001);
    const [minus] = screen.getAllByRole("button", { name: "Zmniejsz: Szerokość" });
    fireEvent.click(minus);
    fireEvent.click(minus);
    expect(useArrangementStore.getState().arrangement.room.width).toBe(3999);
  });

  it("cabinet dimension +/− goes through the cabinet validation and respects its range", () => {
    render(<NumericFieldControl field="width" label="Szerokość" sliderStep={10} />);
    // Furniture stays in millimetres (only the room uses centimetres).
    expect(screen.getAllByText("mm").length).toBeGreaterThan(0);
    expect(screen.queryByText("cm")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Zwiększ: Szerokość" }));
    expect(useConfiguratorStore.getState().configuration.width).toBe(801);
    useConfiguratorStore.getState().setNumericField("width", 2400);
    cleanup();
    render(<NumericFieldControl field="width" label="Szerokość" sliderStep={10} />);
    expect((screen.getByRole("button", { name: "Zwiększ: Szerokość" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("selecting a wall card makes it the single active wall", () => {
    render(<SpacePanel />);
    const card = (wall: string) => document.querySelector(`[data-wall-card="${wall}"]`)!;
    expect(useArrangementStore.getState().activeWall).toBe("back");
    fireEvent.click(card("left"));
    expect(useArrangementStore.getState().activeWall).toBe("left");
    expect(document.querySelectorAll("[data-wall-card][data-active]")).toHaveLength(1);
    expect(card("left").hasAttribute("data-active")).toBe(true);
  });
});
