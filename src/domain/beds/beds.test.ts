import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { getFurnitureType } from "../modules/registry";
import { bedFormFields, BED_TYPES, type BedConfiguration } from "./bedType";
import { BED_PRODUCTS, findDecor, getBedModel, getBedOptions } from "./catalog";
import { BED_SPECS, maxSpec } from "./specs";

const PUBLIC = join(__dirname, "../../../public");

function readGlbJson(file: string) {
  const buffer = readFileSync(join(PUBLIC, "models/clickbed", file));
  expect(buffer.readUInt32LE(0)).toBe(0x46546c67); // "glTF"
  const length = buffer.readUInt32LE(12);
  return JSON.parse(buffer.subarray(20, 20 + length).toString("utf8"));
}

describe("bed assets", () => {
  for (const product of BED_PRODUCTS) {
    const options = getBedOptions(product.productId);
    it(`${product.typeId}: every orderable size has a converted model with both states`, () => {
      for (const size of options.sizes) {
        const model = getBedModel(product.typeId, size.key);
        expect(model, size.key).not.toBeNull();
        const gltf = readGlbJson(model!.file);
        const names = gltf.nodes.map((n: { name: string }) => n.name);
        expect(names).toContain("folded");
        expect(names).toContain("unfolded");
        expect(names).toContain("folded:body");
        expect(names).toContain("folded:front");
        expect(gltf.materials.map((m: { name: string }) => m.name)).toEqual(["body", "front", "mattress", "hardware"]);
      }
    });

    it(`${product.typeId}: model proportions agree with the published dimensions`, () => {
      for (const size of options.sizes) {
        const model = getBedModel(product.typeId, size.key)!;
        const spec = BED_SPECS[product.typeId][size.key];
        // Width within 1 % (Classico model: 2180 vs 2162 published) and folded height within 6 % (Desk model:
        // 1500 vs 1589) of the published value — see docs/clickbed-assets.md.
        expect(Math.abs(model.states.folded.carcass.size.width - maxSpec(spec.W)) / maxSpec(spec.W)).toBeLessThan(0.01);
        expect(Math.abs(model.states.folded.carcass.size.height - maxSpec(spec.H)) / maxSpec(spec.H)).toBeLessThan(0.06);
      }
    });
  }

  it("ships a preview texture for every decor swatch it references", () => {
    for (const product of BED_PRODUCTS) {
      for (const category of getBedOptions(product.productId).categories) {
        for (const decor of category.decors) {
          if (decor.swatch) expect(existsSync(join(PUBLIC, "textures/decors", decor.swatch.texture)), decor.swatch.texture).toBe(true);
        }
      }
    }
  });
});

describe("bed product options", () => {
  it("offers exactly the sizes and decor categories of each product page", () => {
    const sizes = (id: number) => getBedOptions(id).sizes.map((s) => s.label);
    const categories = (id: number) => getBedOptions(id).categories.map((c) => c.label);
    expect(sizes(4000)).toEqual(["90 x 200", "120 x 200", "140 x 200", "160 x 200", "180 x 200"]);
    expect(sizes(10759)).toEqual(["140 x 200", "160 x 200", "180 x 200"]);
    expect(sizes(4184)).toEqual(["140 x 200", "160 x 200", "180 x 200"]);
    expect(categories(4000)).toEqual(["Standard", "Color", "Contempo", "Trends", "Avant-garde", "Metal"]);
    expect(categories(10759)).toEqual(["Standard", "Color", "Contempo"]);
    expect(categories(4184)).toEqual(["Standard", "Color", "Contempo", "Trends", "Avant-garde", "Metal"]);
  });

  it("offers each product only its own add-ons", () => {
    const addons = (id: number) => getBedOptions(id).addons.map((a) => a.id);
    expect(addons(4000)).toEqual(["shelf", "led"]);
    expect(addons(10759)).toEqual(["electricOpening", "led", "extraLock"]);
    expect(addons(4184)).toEqual(["led"]);
  });

  it("rejects options a product does not support", () => {
    const classico = getFurnitureType("clickbed-o-classico");
    const base = classico.createDefault() as BedConfiguration;
    expect(classico.validate(base)).toEqual([]);
    expect(classico.validate({ ...base, decorCategory: "metal", frontDecor: "AL01", bodyDecor: "AL01" }).map((i) => i.code)).toContain("bed.unknown_category");
    expect(classico.validate({ ...base, size: "90x200" }).map((i) => i.code)).toContain("bed.unknown_size");
    expect(classico.validate({ ...base, addons: { ...base.addons, shelf: true } }).map((i) => i.code)).toContain("bed.addon_not_offered");
    expect(classico.validate({ ...base, frontDecor: "0101-PE" }).map((i) => i.code)).toContain("bed.decor_not_in_category");
  });

  it("requires a firmness exactly when the mattress is ordered", () => {
    const o = getFurnitureType("clickbed-o");
    const base = o.createDefault() as BedConfiguration;
    expect(o.validate({ ...base, mattress: true }).map((i) => i.code)).toEqual(["bed.firmness_required"]);
    expect(o.validate({ ...base, mattress: true, firmness: "H3" })).toEqual([]);
    expect(o.validate({ ...base, firmness: "H3" }).map((i) => i.code)).toEqual(["bed.firmness_without_mattress"]);
  });
});

describe("colour and decor selection", () => {
  it("selects front and body decors independently within a category", () => {
    const options = getBedOptions(4000);
    const config: BedConfiguration = {
      ...(getFurnitureType("clickbed-o").createDefault() as BedConfiguration),
      decorCategory: "color",
      frontDecor: "0190-PE",
      bodyDecor: "8681-SU",
    };
    expect(getFurnitureType("clickbed-o").validate(config)).toEqual([]);
    const front = findDecor(options, "color", "0190-PE")!;
    expect(front.name).toBe("Black");
    expect(front.swatch?.hex).toMatch(/^#[0-9A-F]{6}$/);
  });

  it("maps the configuration to the exact fields the shop's product form posts", () => {
    const options = getBedOptions(4000);
    const config: BedConfiguration = {
      size: "160x200",
      decorCategory: "color",
      frontDecor: "0190-PE",
      bodyDecor: "8681-SU",
      mattress: true,
      firmness: "H4",
      addons: { shelf: true, led: false },
    };
    const fields = bedFormFields(options, config);
    expect(fields).toEqual({
      ok: true,
      value: {
        tmcp_select_0: "160 x 200_3",
        tmcp_select_4: "Color_1",
        tmcp_radio_8: "0190 PE Black_15",
        tmcp_radio_9: "8681 SU Brilliant White_0",
        tmcp_select_21: "Tak_1",
        tmcp_select_23: "H4_1",
        tmcp_select_24: "Tak_1",
        tmcp_select_25: "Nie_0",
      },
    });
  });
});

describe("bed spatial volumes", () => {
  it("covers both the published dimensions and the 3D model in every state", () => {
    for (const type of BED_TYPES) {
      const options = getBedOptions((type.productReference(type.createDefault()) as { productId: number }).productId);
      for (const size of options.sizes) {
        const config = { ...type.createDefault(), size: size.key };
        const spec = BED_SPECS[type.id][size.key];
        const model = getBedModel(type.id, size.key)!;
        const fp = type.footprint(config);
        expect(fp.width).toBeGreaterThanOrEqual(maxSpec(spec.W));
        expect(fp.depth).toBeGreaterThanOrEqual(maxSpec(spec.D));
        const unfolded = type.collisionBoxes(config, "unfolded");
        const reach = Math.max(...unfolded.map((b) => b.position.z + b.dimensions.depth));
        expect(reach).toBeGreaterThanOrEqual(maxSpec(spec.DU));
        expect(reach).toBeGreaterThanOrEqual(model.states.unfolded.overall.size.depth);
        const [envelope] = type.operationEnvelope(config)!;
        for (const b of [...unfolded, ...type.collisionBoxes(config, "folded")]) {
          expect(b.position.z + b.dimensions.depth).toBeLessThanOrEqual(envelope.dimensions.depth);
          expect(b.position.y + b.dimensions.height).toBeLessThanOrEqual(envelope.dimensions.height);
        }
      }
    }
  });

  it("keeps the unfolded bed low so it fits under a window", () => {
    const o = getFurnitureType("clickbed-o");
    const [, bed] = o.collisionBoxes(o.createDefault(), "unfolded");
    expect(bed.dimensions.height).toBeLessThan(500);
  });

  it("reserves the Desk's deployed desk in the folded state", () => {
    const desk = getFurnitureType("clickbed-o-desk");
    const folded = desk.collisionBoxes(desk.createDefault(), "folded");
    expect(folded).toHaveLength(2);
    expect(folded[1].dimensions.depth).toBeGreaterThanOrEqual(530);
    expect(folded[1].position.y + folded[1].dimensions.height).toBeGreaterThanOrEqual(720);
  });
});
