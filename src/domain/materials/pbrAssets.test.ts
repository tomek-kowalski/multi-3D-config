import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MATERIAL_CATALOG } from "../furniture/materials";
import { FLOOR_MATERIAL_IDS } from "../room/types";
import manifest from "./data/pbrTextures.json";
import {
  CABINET_WOOD_TEXTURES,
  cabinetFinishSelection,
  configuredColor,
  createMaterialRegistry,
  floorMaterialRegistryId,
  MATERIAL_SEED,
  materialRegistry,
  pbrTextureAssets,
  ROOM_FLOOR_TEMPLATE,
  ROOM_WALL_TEMPLATE,
  type TextureAsset,
} from "./index";

const PUBLIC = join(__dirname, "../../../public");

/** Pixel size of a PNG (IHDR) or JPEG (first SOF marker). */
function imageSize(bytes: Buffer): [number, number] {
  if (bytes.readUInt32BE(0) === 0x89504e47) return [bytes.readUInt32BE(16), bytes.readUInt32BE(20)];
  let i = 2;
  while (i < bytes.length) {
    const marker = bytes.readUInt16BE(i);
    const length = bytes.readUInt16BE(i + 2);
    if (marker >= 0xffc0 && marker <= 0xffcf && ![0xffc4, 0xffc8, 0xffcc].includes(marker)) return [bytes.readUInt16BE(i + 7), bytes.readUInt16BE(i + 5)];
    i += 2 + length;
  }
  throw new Error("no SOF marker");
}

type Sets = Record<string, { coverageM: number[]; physicalSizeMm: number[]; files: Record<string, { width: number; height: number; bytes: number; md5: string }> }>;
const SETS = (manifest as unknown as { assets: Sets }).assets;

describe("Phase 4A/4B generic PBR assets", () => {
  it("ships exactly the seven approved sets, each file matching its recorded checksum, size and dimensions", () => {
    expect(Object.keys(SETS).sort()).toEqual(
      ["herringbone_parquet", "laminate_floor_03", "oak_veneer_02", "oak_veneer_03", "walnut_veneer_02", "white_plaster_02", "wood_floor"].sort(),
    );
    for (const [set, info] of Object.entries(SETS)) {
      // Physical coverage equals the source's documented physical size (square, seamless tiles).
      expect(info.coverageM.map((m) => Math.round(m * 1000))).toEqual(info.physicalSizeMm);
      for (const [file, f] of Object.entries(info.files)) {
        const bytes = readFileSync(join(PUBLIC, "textures/pbr", set, file));
        expect(bytes.length, `${set}/${file}`).toBe(f.bytes);
        expect(createHash("md5").update(bytes).digest("hex"), `${set}/${file}`).toBe(f.md5);
        expect(imageSize(bytes), `${set}/${file}`).toEqual([f.width, f.height]);
      }
    }
    expect(existsSync(join(PUBLIC, "textures/pbr/LICENSE.md"))).toBe(true);
  });

  it("registers tiers by semantic: sRGB JPEG colour (1K/2K), lossless PNG data maps (512/1K normals, 256/1K roughness)", () => {
    const assets = pbrTextureAssets();
    const bySemantic = (s: TextureAsset["semantic"]) => assets.filter((a) => a.semantic === s);
    expect(bySemantic("baseColor")).toHaveLength(6); // plaster has no colour map: the wall colour is configured
    expect(bySemantic("normal")).toHaveLength(7);
    expect(bySemantic("roughness")).toHaveLength(7);
    for (const a of assets) {
      const edge = (tier: "standard" | "enhanced") => a.variants[tier]!.width;
      if (a.semantic === "baseColor") {
        expect(a).toMatchObject({ colorSpace: "srgb", variants: { standard: { format: "jpeg" }, enhanced: { format: "jpeg" } } });
        expect([edge("standard"), edge("enhanced")]).toEqual([1024, 2048]);
        expect(a.statistics?.meanLinearRgb).toHaveLength(3);
      } else {
        expect(a).toMatchObject({ colorSpace: "data", variants: { standard: { format: "png" }, enhanced: { format: "png" } } });
        expect([edge("standard"), edge("enhanced")]).toEqual(a.semantic === "normal" ? [512, 1024] : [256, 1024]);
      }
      if (a.semantic === "roughness") expect(a.statistics?.meanValue).toBeGreaterThan(0);
      expect(a.provenance).toMatch(/^Generic texture \(not a manufacturer decor\): Poly Haven .* CC0 1\.0/);
    }
    expect(materialRegistry.validate()).toEqual([]);
  });

  it("wood finishes keep their IDs and catalog colours; the three generic veneers are calibrated to them", () => {
    expect(CABINET_WOOD_TEXTURES).toEqual({ "natural-oak": "oak_veneer_02", "sonoma-oak": "oak_veneer_03", walnut: "walnut_veneer_02" });
    expect(MATERIAL_CATALOG.filter((m) => ["natural-oak", "sonoma-oak", "walnut"].includes(m.id)).map((m) => m.color)).toEqual(["#C9A273", "#B89469", "#67452F"]);
    for (const id of ["natural-oak", "sonoma-oak", "walnut"] as const) {
      const r = materialRegistry.resolve(cabinetFinishSelection(id));
      expect(r.label).toBe(`cabinet/${id}`);
      expect(r.decor).toBeUndefined(); // never presented as a manufacturer decor
    }
  });

  it("rejects a calibrated colour whose image has no measured mean, and maps out of register with the print", () => {
    const registry = createMaterialRegistry(MATERIAL_SEED);
    const [albedo] = pbrTextureAssets().filter((a) => a.id === "pbr:oak_veneer_02/baseColor");
    const issues = registry.register({
      textures: [{ ...albedo, id: "test/no-stats", statistics: undefined }],
      materials: [
        {
          id: "test/uncalibratable",
          category: "veneer",
          color: {
            kind: "map",
            map: { assetId: "test/no-stats", alignment: { kind: "decor-registered", registrationId: "pbr:oak_veneer_02", coverageM: [1, 1], phaseM: [0, 0] } },
            meanSrgbHex: "#C9A273",
            calibration: { kind: "match-mean-linear", targetSrgbHex: "#C9A273" },
          },
          surfaceProfileId: "surface/pbr-oak_veneer_02",
          finishProfileId: "finish/board-satin",
          provenance: "test",
        },
        {
          id: "test/out-of-register",
          category: "veneer",
          color: {
            kind: "map",
            map: { assetId: "pbr:oak_veneer_02/baseColor", alignment: { kind: "decor-registered", registrationId: "pbr:oak_veneer_02", coverageM: [1, 1], phaseM: [0.3, 0] } },
            meanSrgbHex: "#C9A273",
          },
          surfaceProfileId: "surface/pbr-oak_veneer_02",
          finishProfileId: "finish/board-satin",
          provenance: "test",
        },
        {
          id: "test/solid-on-registered-relief",
          category: "veneer",
          color: { kind: "solid", srgbHex: "#C9A273" },
          surfaceProfileId: "surface/pbr-oak_veneer_02",
          finishProfileId: "finish/board-satin",
          provenance: "test",
        },
      ],
    });
    expect(issues.some((i) => i.startsWith("test/uncalibratable: calibrated colour needs"))).toBe(true);
    expect(issues.some((i) => i.startsWith("test/out-of-register:") && i.includes("not in register"))).toBe(true);
    expect(issues.some((i) => i.startsWith("test/solid-on-registered-relief:"))).toBe(true);
  });

  it("walls: plaster relief and sheen on the wall profile only; the configured colour stays the colour", () => {
    const wall = materialRegistry.resolve(configuredColor(ROOM_WALL_TEMPLATE, "#2F4A6B"));
    expect(wall.color).toEqual({ kind: "solid", srgbHex: "#2F4A6B" });
    expect(wall.surface?.maps.normal?.assetId).toBe("pbr:white_plaster_02/normal");
    expect(wall.surface?.maps.roughness?.assetId).toBe("pbr:white_plaster_02/roughness");
    expect(wall.surface?.normalScale[0]).toBeGreaterThan(0);
    expect(wall.surface?.normalScale[0]).toBeLessThan(1); // softened under paint
    // The colour floor is unchanged (no maps): floor materials are separate registered materials.
    const floor = materialRegistry.resolve(configuredColor(ROOM_FLOOR_TEMPLATE, "#B79D7C"));
    expect(floor.surface?.maps).toEqual({});
  });

  it("offers exactly three floor materials, each with its own colour, relief and gloss", () => {
    expect(FLOOR_MATERIAL_IDS).toEqual(["wood-planks", "laminate", "herringbone-parquet"]);
    const roughness: number[] = [];
    for (const id of FLOOR_MATERIAL_IDS) {
      const r = materialRegistry.resolve({ kind: "registered", id: floorMaterialRegistryId(id) });
      expect(r.color?.kind).toBe("map");
      expect(r.color?.kind === "map" && r.color.calibration).toBeFalsy();
      expect(r.surface?.maps.normal).toBeDefined();
      expect(r.surface?.maps.roughness).toBeDefined();
      roughness.push(r.finish!.roughness);
    }
    // Material-specific reflections, never mirror-like.
    expect(roughness.every((v) => v >= 0.3 && v <= 0.6)).toBe(true);
  });
});
