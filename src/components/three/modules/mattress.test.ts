import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Object3D } from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { describe, expect, it } from "vitest";
import { addModule, updateModuleConfiguration } from "@/domain/arrangement/operations";
import type { Arrangement } from "@/domain/arrangement/types";
import { bedFormFields, validateBed, type BedConfiguration } from "@/domain/beds/bedType";
import { getBedModel, getBedOptions, offersMattress, type BedProductOptions } from "@/domain/beds/catalog";
import { buildOrder } from "@/domain/commerce/order";
import { getFurnitureType } from "@/domain/modules/registry";
import { DEFAULT_ROOM } from "@/domain/room/defaults";
import { exportArrangementJson, importArrangementJson } from "@/domain/serialization/arrangementJson";
import { applyBedVisibility, isMattressNode, prepareBedScene } from "./BedModel";

function unwrap<T>(r: { ok: true; value: T } | { ok: false; issues: readonly unknown[] }): T {
  if (!r.ok) throw new Error(JSON.stringify(r.issues));
  return r.value;
}

/** Loads a converted bed model exactly as the app does (GLTFLoader), without WebGL. */
async function loadBed(typeId: string, size = "140x200"): Promise<Object3D> {
  const buffer = readFileSync(join(__dirname, "../../../../public/models/clickbed", getBedModel(typeId, size)!.file));
  const data = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
  const gltf = await new GLTFLoader().parseAsync(data, "");
  return gltf.scene;
}

/** Whether any mattress mesh would actually be drawn (it and all its ancestors visible). */
function mattressDrawn(root: Object3D): boolean {
  let drawn = false;
  root.traverse((node) => {
    if (!isMattressNode(node.name)) return;
    let visible = true;
    for (let n: Object3D | null = node; n; n = n.parent) visible &&= n.visible;
    drawn ||= visible;
  });
  return drawn;
}

const defaultBed = (typeId: string) => getFurnitureType(typeId).createDefault() as BedConfiguration;

describe("embedded mattress of the imported models", () => {
  for (const typeId of ["clickbed-o", "clickbed-o-classico", "clickbed-o-desk"]) {
    it(`${typeId}: hidden by default, shown only on explicit selection, removed on deselection`, async () => {
      const scene = await loadBed(typeId);
      // The supplied model does contain a mattress (named "unfoldedmattress" once loaded)…
      expect(scene.getObjectByName("unfoldedmattress")).toBeDefined();
      expect(isMattressNode("unfoldedmattress")).toBe(true);
      // …but a freshly prepared bed never draws it, in any state, before any selection is applied.
      const { root } = prepareBedScene(scene);
      expect(mattressDrawn(root)).toBe(false);
      root.getObjectByName("unfolded")!.visible = true; // even if the unfolded state is shown
      expect(mattressDrawn(root)).toBe(false);

      expect(defaultBed(typeId).mattress).toBe(false);
      applyBedVisibility(root, "unfolded", false);
      expect(mattressDrawn(root)).toBe(false);
      applyBedVisibility(root, "unfolded", true);
      expect(mattressDrawn(root)).toBe(true);
      applyBedVisibility(root, "unfolded", false);
      expect(mattressDrawn(root)).toBe(false);
      // Folded, the mattress is inside the closed bed: never drawn.
      applyBedVisibility(root, "folded", true);
      expect(mattressDrawn(root)).toBe(false);
    });
  }

  it("keeps each bed instance's mattress independent", async () => {
    const scene = await loadBed("clickbed-o");
    const a = prepareBedScene(scene).root;
    const b = prepareBedScene(scene).root;
    applyBedVisibility(a, "unfolded", true);
    applyBedVisibility(b, "unfolded", false);
    expect([mattressDrawn(a), mattressDrawn(b)]).toEqual([true, false]);
    expect(mattressDrawn(scene)).toBe(true); // the shared loaded asset itself is never modified
  });
});

describe("products without a mattress option", () => {
  // A product form without any mattress fields (none of the current ClickBeds; checks the rule itself).
  const real = getBedOptions(4000);
  const withoutMattress: BedProductOptions = {
    ...real,
    sizes: real.sizes.map((s) => ({ key: s.key, label: s.label, value: s.value, categoryField: s.categoryField })),
    mattress: undefined,
    firmness: undefined,
  };

  it("are recognised, and the current ClickBeds all offer the mattress", () => {
    expect(offersMattress(withoutMattress)).toBe(false);
    for (const id of [4000, 10759, 4184]) expect(offersMattress(getBedOptions(id))).toBe(true);
  });

  it("can never be configured or ordered with a mattress", () => {
    const config = defaultBed("clickbed-o");
    expect(validateBed(withoutMattress, config)).toEqual([]);
    expect(validateBed(withoutMattress, { ...config, mattress: true, firmness: "H3" }).map((i) => i.code)).toContain("bed.mattress_not_offered");
    const fields = unwrap(bedFormFields(withoutMattress, config));
    expect(Object.keys(fields).some((f) => Object.values(real.sizes).some((s) => s.mattressField === f))).toBe(false);
    expect(fields[real.firmness!.field]).toBeUndefined();
  });
});

describe("mattress in saved configurations and orders", () => {
  function bedWith(mattress: boolean): Arrangement {
    let a: Arrangement = { room: DEFAULT_ROOM, modules: [] };
    a = unwrap(addModule(a, "clickbed-o")).arrangement;
    const config = a.modules[0].configuration as BedConfiguration;
    return unwrap(updateModuleConfiguration(a, "module-1", mattress ? { ...config, mattress: true, firmness: "H3" } : config)).arrangement;
  }
  const options = getBedOptions(4000);
  const mattressField = options.sizes.find((s) => s.key === "140x200")!.mattressField!;
  const orderFields = (a: Arrangement) => {
    const item = unwrap(buildOrder(a)).modules[0].items[0];
    return item.kind === "product-options" ? item.fields : {};
  };

  it("restores the selected and the unselected state exactly", () => {
    for (const mattress of [true, false]) {
      const reloaded = unwrap(importArrangementJson(exportArrangementJson(bedWith(mattress))));
      expect((reloaded.modules[0].configuration as BedConfiguration).mattress).toBe(mattress);
    }
  });

  it("asks the shop for the mattress only when it is selected, and drops it again on deselection", () => {
    const without = orderFields(bedWith(false));
    expect(without[mattressField]).toBe(options.mattress!.values.nie); // the shop's own "no" (no price)
    expect(without[options.firmness!.field]).toBeUndefined();
    const withMattress = orderFields(bedWith(true));
    expect(withMattress[mattressField]).toBe(options.mattress!.values.tak);
    expect(withMattress[options.firmness!.field]).toBe("H3_0");
    // Deselecting removes the mattress and its firmness from the order data.
    const selected = bedWith(true);
    const config = selected.modules[0].configuration as BedConfiguration;
    const deselected = unwrap(updateModuleConfiguration(selected, "module-1", { ...config, mattress: false, firmness: null })).arrangement;
    expect(orderFields(deselected)).toEqual(without);
    // No separate mattress product is ever added: one line per bed.
    expect(unwrap(buildOrder(selected)).modules[0].items).toHaveLength(1);
  });
});
