// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { BedConfiguration } from "@/domain/beds/bedType";
import { useLocaleStore } from "@/i18n";
import { useArrangementStore } from "@/store/useArrangementStore";
import { BedPanel } from "./BedPanel";

afterEach(cleanup);
beforeEach(() => {
  useLocaleStore.setState({ locale: "pl" });
  useArrangementStore.getState().reset();
});

const bed = () => useArrangementStore.getState().arrangement.modules[0];
const config = () => bed().configuration as BedConfiguration;

function renderBed(typeId: string) {
  useArrangementStore.getState().addModule(typeId);
  const view = render(<BedPanel module={bed()} />);
  // Re-render with the updated module after every store change.
  const unsubscribe = useArrangementStore.subscribe(() => view.rerender(<BedPanel module={bed()} />));
  return unsubscribe;
}

describe("mattress control", () => {
  it("is offered for a product with a mattress option, unselected by default", () => {
    const stop = renderBed("clickbed-o");
    const control = within(document.querySelector("[data-mattress-control]") as HTMLElement);
    expect(control.getByRole("button", { name: "Nie" }).getAttribute("aria-pressed")).toBe("true");
    expect(control.queryByText("Twardość materaca")).toBeNull();
    expect(config().mattress).toBe(false);
    stop();
  });

  it("adds the mattress only on explicit selection and removes it with its firmness on deselection", () => {
    const stop = renderBed("clickbed-o-desk");
    const control = () => within(document.querySelector("[data-mattress-control]") as HTMLElement);
    fireEvent.click(control().getByRole("button", { name: "Tak" }));
    expect(config()).toMatchObject({ mattress: true, firmness: "H3" });
    expect(control().getByText("Twardość materaca")).toBeTruthy();
    fireEvent.click(control().getByRole("button", { name: "H4" }));
    expect(config().firmness).toBe("H4");
    fireEvent.click(control().getByRole("button", { name: "Nie" }));
    expect(config()).toMatchObject({ mattress: false, firmness: null });
    expect(control().queryByText("Twardość materaca")).toBeNull();
    stop();
  });

  it("keeps the selection per bed instance", () => {
    useArrangementStore.getState().addModule("clickbed-o");
    useArrangementStore.getState().addModule("clickbed-o");
    const [first, second] = useArrangementStore.getState().arrangement.modules;
    render(<BedPanel module={first} />);
    fireEvent.click(within(document.querySelector("[data-mattress-control]") as HTMLElement).getByRole("button", { name: "Tak" }));
    const modules = useArrangementStore.getState().arrangement.modules;
    expect((modules[0].configuration as BedConfiguration).mattress).toBe(true);
    expect((modules[1].configuration as BedConfiguration).mattress).toBe(false);
    expect(second.id).toBe("module-2");
    expect(screen.getAllByText("Materac Velora Silver")).toHaveLength(1);
  });
});
