import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CabinetConfiguration } from "@/domain/furniture/types";
import { bindCabinetSession } from "./cabinetSession";
import { useArrangementStore } from "./useArrangementStore";
import { useConfiguratorStore } from "./useConfiguratorStore";

const config = (id: string) =>
  useArrangementStore.getState().arrangement.modules.find((m) => m.id === id)!.configuration as CabinetConfiguration;

describe("cabinet editing session", () => {
  let unbind: () => void;

  beforeEach(() => {
    useArrangementStore.getState().reset();
    useConfiguratorStore.getState().reset();
    unbind = bindCabinetSession();
  });
  afterEach(() => unbind());

  it("edits only the selected cabinet and keeps every configuration when switching", () => {
    const store = useArrangementStore.getState();
    expect(store.addModule("cabinet").ok).toBe(true); // module-1, selected
    expect(useArrangementStore.getState().duplicateSelected("right").ok).toBe(true); // module-2, selected

    // The existing cabinet store/panels edit the selected module (module-2).
    expect(useConfiguratorStore.getState().setNumericField("width", 1000).ok).toBe(true);
    expect(useConfiguratorStore.getState().setMaterial("body", "walnut").ok).toBe(true);
    expect(config("module-2")).toMatchObject({ width: 1000, materials: { body: "walnut" } });
    expect(config("module-1")).toMatchObject({ width: 800, materials: { body: "natural-oak" } });

    // Switching loads the other module's own configuration into the cabinet session.
    useArrangementStore.getState().selectModule("module-1");
    expect(useConfiguratorStore.getState().configuration).toBe(config("module-1"));
    useConfiguratorStore.getState().setNumericField("height", 900);
    useArrangementStore.getState().selectModule("module-2");
    expect(useConfiguratorStore.getState().configuration.width).toBe(1000);
    expect(config("module-1").height).toBe(900);
    expect(config("module-2").height).toBe(1800);
  });

  it("ignores cabinet edits while a non-cabinet module is selected", () => {
    useArrangementStore.getState().addModule("cabinet");
    useArrangementStore.getState().addModule("clickbed-o");
    const before = config("module-1");
    useConfiguratorStore.getState().setNumericField("width", 1500);
    expect(config("module-1")).toBe(before);
  });
});
