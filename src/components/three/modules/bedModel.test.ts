import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { addModule, updateModuleConfiguration } from "@/domain/arrangement/operations";
import type { Arrangement } from "@/domain/arrangement/types";
import type { BedConfiguration } from "@/domain/beds/bedType";
import { BED_PRODUCTS, getBedModel, getBedOptions } from "@/domain/beds/catalog";
import { buildOrder } from "@/domain/commerce/order";
import { getFurnitureType } from "@/domain/modules/registry";
import { DEFAULT_ROOM } from "@/domain/room/defaults";
import { exportArrangementJson, importArrangementJson } from "@/domain/serialization/arrangementJson";
import { bedNodeVisible } from "./BedModel";

function unwrap<T>(r: { ok: true; value: T } | { ok: false; issues: readonly unknown[] }): T {
  if (!r.ok) throw new Error(JSON.stringify(r.issues));
  return r.value;
}

interface Gltf {
  nodes: { name: string; mesh?: number; children?: number[] }[];
  meshes: { name: string; primitives: { attributes: { POSITION: number } }[] }[];
  accessors: { min?: number[]; max?: number[] }[];
}

function readGltf(file: string): Gltf {
  const buffer = readFileSync(join(__dirname, "../../../../public/models/clickbed", file));
  return JSON.parse(buffer.subarray(20, 20 + buffer.readUInt32LE(12)).toString("utf8"));
}

/** Bounds of a named mesh in millimetres (model frame: x along the bed, y up, z out of the wall). */
function meshBoundsMm(gltf: Gltf, name: string) {
  const mesh = gltf.meshes.find((m) => m.name === name);
  if (!mesh) return null;
  const { min, max } = gltf.accessors[mesh.primitives[0].attributes.POSITION];
  return { min: min!.map((v) => v * 1000), max: max!.map((v) => v * 1000) };
}

describe("mattress in the 3D bed", () => {
  it("is shown exactly when the configuration includes it", () => {
    expect(bedNodeVisible("unfolded:mattress", "unfolded", true)).toBe(true);
    expect(bedNodeVisible("unfolded:mattress", "unfolded", false)).toBe(false);
    // The state nodes still follow the displayed state; other meshes are untouched.
    expect(bedNodeVisible("unfolded", "folded", true)).toBe(false);
    expect(bedNodeVisible("folded", "folded", true)).toBe(true);
    expect(bedNodeVisible("unfolded:body", "unfolded", false)).toBeNull();
  });

  for (const product of BED_PRODUCTS) {
    it(`${product.typeId}: uses the supplied mattress, sized like the mattress size and lying in the unfolded bed`, () => {
      const type = getFurnitureType(product.typeId);
      for (const size of getBedOptions(product.productId).sizes) {
        const model = getBedModel(product.typeId, size.key)!;
        const gltf = readGltf(model.file);
        const bounds = meshBoundsMm(gltf, "unfolded:mattress");
        expect(bounds, size.key).not.toBeNull();
        const [widthCm, lengthCm] = size.key.split("x").map(Number);
        const length = bounds!.max[0] - bounds!.min[0];
        const width = bounds!.max[2] - bounds!.min[2];
        const height = bounds!.max[1] - bounds!.min[1];
        // The supplied mattress matches the ordered size (within 3 %) and the published HM 200 mm (within 15 %).
        expect(Math.abs(width - widthCm * 10) / (widthCm * 10), `${size.key} width ${width}`).toBeLessThan(0.03);
        expect(Math.abs(length - lengthCm * 10) / (lengthCm * 10), `${size.key} length ${length}`).toBeLessThan(0.03);
        expect(Math.abs(height - 200) / 200, `${size.key} height ${height}`).toBeLessThan(0.15);
        // It lies inside the unfolded bed's volume used for collisions (positioned on the frame).
        const config = { ...(type.createDefault() as BedConfiguration), size: size.key };
        const boxes = type.collisionBoxes(config, "unfolded");
        const top = Math.max(...boxes.map((b) => b.position.y + b.dimensions.height));
        const reach = Math.max(...boxes.map((b) => b.position.z + b.dimensions.depth));
        expect(bounds!.max[1]).toBeLessThanOrEqual(top + 0.5);
        expect(bounds!.max[2]).toBeLessThanOrEqual(reach + 0.5);
        expect(bounds!.min[1]).toBeGreaterThan(150); // above the floor, on the bed frame
      }
    });

    it(`${product.typeId}: the mattress belongs to the moving (unfolded) bed node, not the room`, () => {
      const gltf = readGltf(getBedModel(product.typeId, "140x200")!.file);
      const index = gltf.nodes.findIndex((n) => n.name === "unfolded:mattress");
      const parent = gltf.nodes.find((n) => n.children?.includes(index));
      expect(parent?.name).toBe("unfolded");
      expect(gltf.nodes.some((n) => n.name === "folded:mattress")).toBe(false);
    });
  }
});

describe("mattress selection per bed", () => {
  function twoBeds(): Arrangement {
    let a: Arrangement = { room: { ...DEFAULT_ROOM, width: 6000 }, modules: [] };
    a = unwrap(addModule(a, "clickbed-o")).arrangement;
    a = unwrap(addModule(a, "clickbed-o")).arrangement;
    const first = a.modules[0].configuration as BedConfiguration;
    return unwrap(updateModuleConfiguration(a, "module-1", { ...first, mattress: true, firmness: "H4" })).arrangement;
  }

  it("is independent for each bed instance", () => {
    const a = twoBeds();
    const [first, second] = a.modules.map((m) => m.configuration as BedConfiguration);
    expect([first.mattress, second.mattress]).toEqual([true, false]);
    expect(bedNodeVisible("unfolded:mattress", "unfolded", first.mattress)).toBe(true);
    expect(bedNodeVisible("unfolded:mattress", "unfolded", second.mattress)).toBe(false);
  });

  it("persists in saved configurations and in the order data (WooCommerce mattress field)", () => {
    const a = twoBeds();
    const reloaded = unwrap(importArrangementJson(exportArrangementJson(a)));
    expect(reloaded.modules.map((m) => (m.configuration as BedConfiguration).mattress)).toEqual([true, false]);
    const order = unwrap(buildOrder(reloaded));
    const fields = order.modules.map((m) => (m.items[0].kind === "product-options" ? m.items[0].fields : {}));
    const options = getBedOptions(4000);
    const mattressField = options.sizes.find((s) => s.key === "140x200")!.mattressField!;
    expect(fields[0][mattressField]).toBe(options.mattress!.values.tak);
    expect(fields[0][options.firmness!.field]).toBe("H4_1");
    expect(fields[1][mattressField]).toBe(options.mattress!.values.nie);
    expect(order.modules[0].summary.find((r) => r.labelKey === "summary.mattress")?.value).toBe("Velora Silver H4");
  });
});
