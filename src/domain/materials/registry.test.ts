import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { BED_PRODUCTS, getBedOptions } from "../beds/catalog";
import { MATERIAL_CATALOG } from "../furniture/materials";
import { HARDWARE_FINISHES } from "../hardware/catalog";
import {
  BED_DECOR_NAMESPACE,
  bedDecorSelection,
  CABINET_WOOD_TEXTURES,
  cabinetFinishSelection,
  configuredColor,
  decorFinishProfileId,
  hardwareFinishSelection,
  MATERIAL_CATEGORIES,
  materialRegistry,
  MaterialResolutionError,
  createMaterialRegistry,
  MATERIAL_SEED,
  REGISTERED,
  resolveTextureTransform,
  ROOM_FLOOR_TEMPLATE,
  ROOM_WALL_TEMPLATE,
  selectionKey,
  UNAVAILABLE_PREVIEW_HEX,
} from "./index";

const optionsJson = JSON.parse(readFileSync(join(__dirname, "../beds/data/clickbedOptions.json"), "utf8")) as {
  products: { productId: number; categories: { id: string; decors: { id: string; swatch: { texture: string } | null }[] }[] }[];
};

describe("universal material registry", () => {
  it("is internally consistent (profiles, assets, colour spaces, coverage, categories)", () => {
    expect(materialRegistry.validate()).toEqual([]);
    expect(MATERIAL_CATEGORIES).toEqual(["wood", "laminate", "veneer", "lacquer", "textile", "leather", "metal", "plastic", "glass", "stone", "ceramic", "concrete", "paint"]);
  });

  it("resolves every existing cabinet finish ID to its unchanged catalog colour and roughness", () => {
    for (const m of MATERIAL_CATALOG) {
      const r = materialRegistry.resolve(cabinetFinishSelection(m.id));
      expect(r.source).toBe("registry");
      if (r.source !== "registry") continue;
      expect(r.finish.roughness).toBe(m.roughness);
      expect(r.availability).toBe("available");
      const set = CABINET_WOOD_TEXTURES[m.id];
      if (!set) {
        expect(r.color).toEqual({ kind: "solid", srgbHex: m.color });
        continue;
      }
      // Wood finishes (Phase 4A): a generic image calibrated to the unchanged catalog colour, never a decor.
      expect(r.color).toMatchObject({ kind: "map", meanSrgbHex: m.color, calibration: { kind: "match-mean-linear", targetSrgbHex: m.color } });
      expect(r.decor).toBeUndefined();
      expect(r.surface.sharing).toEqual({ kind: "decor-registered", registrationId: `pbr:${set}` });
    }
    expect(Object.keys(CABINET_WOOD_TEXTURES).sort()).toEqual(["natural-oak", "sonoma-oak", "walnut"]);
  });

  it("resolves every hardware finish; bare metals are metallic, coatings dielectric", () => {
    for (const f of HARDWARE_FINISHES) {
      const r = materialRegistry.resolve(hardwareFinishSelection(f.id));
      expect(r.color).toEqual({ kind: "solid", srgbHex: f.color });
      const metal = ["chrome", "brushed-steel", "brass"].includes(f.id);
      expect(r.finish!.metalness).toBe(metal ? 1 : 0);
    }
  });

  it("resolves all 551 ClickBed decor entries: 413 with their exact existing swatch URL, 138 explicitly unavailable", () => {
    let withSwatch = 0;
    let unavailable = 0;
    const urls = new Set<string>();
    for (const product of optionsJson.products) {
      for (const category of product.categories) {
        for (const decor of category.decors) {
          const r = materialRegistry.resolve(bedDecorSelection(product.productId, category.id, decor.id));
          expect(r.decor?.id).toBe(decor.id);
          if (decor.swatch) {
            withSwatch++;
            expect(r.availability).toBe("available");
            expect(r.color?.kind).toBe("map");
            if (r.color?.kind !== "map") continue;
            const asset = materialRegistry.getTextureAsset(r.color.map.assetId);
            // The existing URLs are preserved exactly (both tiers of the same file).
            expect(asset.variants.standard.url).toBe(`/textures/decors/${decor.swatch.texture}`);
            expect(asset.variants.enhanced?.url).toBe(`/textures/decors/hd/${decor.swatch.texture}`);
            expect(asset.colorSpace).toBe("srgb");
            urls.add(asset.variants.standard.url);
          } else {
            unavailable++;
            expect(r.availability).toBe("missing-authorized-swatch");
            expect(r.color).toEqual({ kind: "unavailable", reason: "no-authorized-swatch" });
            expect(r.decor?.sourceMatch).toBe("missing");
          }
        }
      }
    }
    expect(withSwatch + unavailable).toBe(551);
    expect(withSwatch).toBe(413);
    expect(unavailable).toBe(138);
    expect(urls.size).toBe(127);
    // Every referenced swatch exists on disk in both tiers.
    for (const url of urls) {
      expect(() => readFileSync(join(__dirname, "../../../public", url))).not.toThrow();
      expect(() => readFileSync(join(__dirname, "../../../public", url.replace("/decors/", "/decors/hd/")))).not.toThrow();
    }
  });

  it("records provenance: exact vs same-code alternate structure, and the legacy coverage assumption", () => {
    const options = getBedOptions(BED_PRODUCTS[0].productId);
    const all = options.categories.flatMap((c) => c.decors.map((d) => ({ c, d })));
    const alternate = all.find(({ d }) => d.swatch?.match === "code")!;
    const r = materialRegistry.resolve(bedDecorSelection(options.productId, alternate.c.id, alternate.d.id));
    expect(r.decor).toMatchObject({ sourceMatch: "same-code-alternate-structure", coverageEvidence: "legacy-assumption" });
    // The selected structure (not the borrowed swatch's) decides the finish.
    expect(r.finish?.id).toBe(decorFinishProfileId(alternate.d));
  });

  it("classifies decor finishes by structure: MG/AG gloss lacquer with clear coat, AL metal foil, others satin board", () => {
    expect(decorFinishProfileId({ code: "7045", structure: "AG" })).toBe("finish/lacquer-high-gloss");
    expect(decorFinishProfileId({ code: "0190", structure: "MG" })).toBe("finish/lacquer-high-gloss");
    expect(decorFinishProfileId({ code: "AL01", structure: "" })).toBe("finish/metal-foil-satin");
    expect(decorFinishProfileId({ code: "K003", structure: "PW" })).toBe("finish/board-satin");
    expect(materialRegistry.getFinishProfile("finish/lacquer-high-gloss").clearcoat).toEqual({ amount: 1, roughness: 0.04 });
  });

  it("resolves configured colours through role templates without changing the colour", () => {
    const wall = materialRegistry.resolve(configuredColor(ROOM_WALL_TEMPLATE, "#d9d4cc"));
    expect(wall.color).toEqual({ kind: "solid", srgbHex: "#D9D4CC" });
    expect(wall.finish?.id).toBe("finish/paint-matte");
    expect(materialRegistry.resolve(configuredColor(ROOM_FLOOR_TEMPLATE, "#C8B49A")).finish?.roughness).toBe(0.7);
    expect(() => materialRegistry.resolve(configuredColor(ROOM_WALL_TEMPLATE, "red"))).toThrow(MaterialResolutionError);
    expect(() => materialRegistry.resolve({ kind: "registered", id: ROOM_WALL_TEMPLATE })).toThrow(MaterialResolutionError);
  });

  it("resolves authored materials with only the named overrides", () => {
    const plain = materialRegistry.resolve({ kind: "authored" });
    expect(plain).toMatchObject({ source: "authored", availability: "available" });
    expect(plain.finish).toBeUndefined();
    expect(plain.color).toBeUndefined();
    const finishOnly = materialRegistry.resolve({ kind: "authored", overrides: { finishProfileId: "finish/textile-ticking" } });
    expect(finishOnly.finish?.maxLinearAlbedo).toBe(0.72);
    expect(finishOnly.color).toBeUndefined(); // authored colour kept
    const recoloured = materialRegistry.resolve({ kind: "authored", overrides: { baseColor: bedDecorSelection(4000, "standard", "8361-SN") } });
    expect(recoloured.availability).toBe("missing-authorized-swatch");
  });

  it("never substitutes: unknown selections fail instead of resolving to another decor", () => {
    expect(() => materialRegistry.resolve(bedDecorSelection(4000, "standard", "NOPE"))).toThrow(MaterialResolutionError);
    expect(() => materialRegistry.resolve({ kind: "legacy", namespace: BED_DECOR_NAMESPACE, key: ["99999", "standard", "K003-PW"] })).toThrow(MaterialResolutionError);
    expect(() => materialRegistry.resolve({ kind: "registered", id: "nope" })).toThrow(MaterialResolutionError);
    expect(UNAVAILABLE_PREVIEW_HEX).toBe("#B9B6B0");
  });

  it("gives equal selections equal keys and a revision that changes with the data", () => {
    expect(selectionKey(cabinetFinishSelection("walnut"))).toBe(selectionKey(cabinetFinishSelection("walnut")));
    expect(selectionKey(configuredColor(ROOM_WALL_TEMPLATE, "#ABCDEF"))).toBe(selectionKey(configuredColor(ROOM_WALL_TEMPLATE, "#abcdef")));
    const registry = createMaterialRegistry(MATERIAL_SEED);
    expect(registry.revision).toBe(materialRegistry.revision);
    registry.register({ finishes: [{ id: "finish/test", roughness: 0.5, metalness: 0, specularIntensity: 1 }] });
    expect(registry.revision).not.toBe(materialRegistry.revision);
  });

  it("validates new registrations (unknown profiles, bad colour spaces, missing coverage)", () => {
    const registry = createMaterialRegistry(MATERIAL_SEED);
    const issues = registry.register({
      textures: [
        {
          id: "test:normal",
          semantic: "normal",
          colorSpace: "srgb",
          variants: { standard: { url: "/x.png", width: 512, height: 512, format: "png" } },
          provenance: "test",
        },
      ],
      surfaces: [{ id: "surface/test", category: "leather", sharing: { kind: "universal-isotropic" }, maps: { normal: { assetId: "test:normal", alignment: { kind: "surface-repeat", coverageM: [0, 0.1], directional: false } } }, normalScale: [1, 1] }],
      materials: [{ id: "test/x", category: "leather", color: { kind: "solid", srgbHex: "#123456" }, surfaceProfileId: "surface/none", finishProfileId: "finish/none", provenance: "test" }],
    });
    expect(issues.some((i) => i.includes("colour space"))).toBe(true);
    expect(issues.some((i) => i.includes("positive physical coverage"))).toBe(true);
    expect(issues.some((i) => i.includes("unknown finish"))).toBe(true);
    expect(issues.some((i) => i.includes("unknown surface"))).toBe(true);
  });

  it("derives the sampler repeat from the geometry's mapping and the map's physical coverage", () => {
    const alignment = { kind: "surface-repeat", coverageM: [0.6, 0.6], directional: true } as const;
    expect(resolveTextureTransform({ kind: "authored-uv0", uvUnits: "metres" }, alignment)?.repeat).toEqual([1 / 0.6, 1 / 0.6]);
    expect(resolveTextureTransform({ kind: "projected-metres", originM: [0, 0, 0], uAxis: [0, 1, 0], vAxis: [1, 0, 0] }, alignment)?.repeat).toEqual([1 / 0.6, 1 / 0.6]);
    // Normalized UVs spanning 1.2 × 0.3 m show the 0.6 m tile twice by half.
    expect(resolveTextureTransform({ kind: "authored-uv0", uvUnits: "normalized", coverageM: [1.2, 0.3] }, alignment)?.repeat).toEqual([2, 0.5]);
    expect(resolveTextureTransform({ kind: "authored-uv0", uvUnits: "normalized" }, alignment)).toBeNull();
    expect(resolveTextureTransform(undefined, alignment)).toBeNull();
  });

  it("registers the room's glass, handle and recess materials", () => {
    expect(materialRegistry.resolve({ kind: "registered", id: REGISTERED.glass }).finish?.transmission).toMatchObject({ ior: 1.5, proxy: { opacity: 0.45 } });
    expect(materialRegistry.resolve({ kind: "registered", id: REGISTERED.doorHandle }).finish?.metalness).toBe(1);
    expect(materialRegistry.resolve({ kind: "registered", id: REGISTERED.recessShadow }).color).toEqual({ kind: "solid", srgbHex: "#1B1B1B" });
  });
});
