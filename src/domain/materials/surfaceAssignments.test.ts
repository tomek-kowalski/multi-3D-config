import { describe, expect, it } from "vitest";
import { findDecor, getBedOptions } from "../beds/catalog";
import {
  bedDecorSelection,
  configuredColor,
  DOOR_LEAF_TEMPLATE,
  ROOM_FLOOR_TEMPLATE,
  ROOM_WALL_TEMPLATE,
  CLICKBED_DECOR_SOURCE,
  CLICKBED_SURFACE_ASSIGNMENTS,
  createMaterialRegistry,
  decorDefinition,
  MATERIAL_SEED,
  materialRegistry,
  type MaterialMap,
  type RegistryData,
  type SurfaceProfile,
  type TextureAsset,
} from "./index";
import { UNAVAILABLE_FINISH_ID } from "./registry";

/**
 * TEST-ONLY synthetic assets: never registered in the production registry and not manufacturer
 * textures. They exercise the registration rules with the shapes real Phase 4 assets will have.
 */
const png = (id: string, semantic: TextureAsset["semantic"]): TextureAsset => ({
  id,
  semantic,
  colorSpace: semantic === "baseColor" ? "srgb" : "data",
  variants: { standard: { url: `/test-only/${id}.png`, width: 512, height: 512, format: "png" } },
  provenance: "synthetic test asset",
});

const repeatMap = (assetId: string, directional: boolean, coverage: [number, number] = [0.3, 0.3]): MaterialMap => ({
  assetId,
  alignment: { kind: "surface-repeat", coverageM: coverage, directional },
});

function testRegistry(extra: RegistryData) {
  const registry = createMaterialRegistry(MATERIAL_SEED);
  const issues = registry.register({ textures: [png("test:pore-n", "normal"), png("test:pore-r", "roughness")], ...extra });
  return { registry, issues };
}

const K003 = findDecor(getBedOptions(4000), "standard", "K003-PW")!;

describe("data-driven decor surfaces (M-02)", () => {
  it("resolves every ClickBed decor through assignments, preserving all 551 selections", () => {
    let count = 0;
    for (const product of [4000, 10759, 4184]) {
      for (const category of getBedOptions(product).categories) {
        for (const decor of category.decors) {
          const r = materialRegistry.resolve(bedDecorSelection(product, category.id, decor.id));
          expect(r.decor?.id).toBe(decor.id);
          count++;
        }
      }
    }
    expect(count).toBe(551);
    const surfaceOf = (cat: string, id: string) => materialRegistry.resolve(bedDecorSelection(4000, cat, id)).surface?.id;
    expect(surfaceOf("standard", "K003-PW")).toBe("surface/smooth-board");
    expect(surfaceOf("avant-garde", "7045-AG")).toBe("surface/lacquer");
    expect(materialRegistry.validate()).toEqual([]);
    // Every seeded assignment points at a map-free profile: no relief is claimed without assets.
    for (const a of CLICKBED_SURFACE_ASSIGNMENTS) expect(Object.keys(materialRegistry.getSurfaceProfile(a.surfaceProfileId).maps)).toEqual([]);
  });

  it("chooses the most specific rule (decor > code > structure > manufacturer)", () => {
    const flat = (id: string): SurfaceProfile => ({ id, category: "laminate", sharing: { kind: "universal-isotropic" }, maps: {}, normalScale: [1, 1] });
    const { registry, issues } = testRegistry({
      surfaces: [flat("surface/test-pw"), flat("surface/test-k003"), flat("surface/test-code")],
      surfaceAssignments: [
        { id: "t/pw", match: { manufacturer: CLICKBED_DECOR_SOURCE, structure: "PW" }, surfaceProfileId: "surface/test-pw", evidence: "test" },
        { id: "t/code", match: { code: "K003" }, surfaceProfileId: "surface/test-code", evidence: "test" },
        { id: "t/decor", match: { decorId: "K003-PW" }, surfaceProfileId: "surface/test-k003", evidence: "test" },
      ],
    });
    expect(issues).toEqual([]);
    expect(registry.resolve(bedDecorSelection(4000, "standard", "K003-PW")).surface?.id).toBe("surface/test-k003");
    expect(registry.resolve(bedDecorSelection(4000, "standard", "K005-PW")).surface?.id).toBe("surface/test-pw");
  });

  it("accepts verified-structure maps only for the evidenced manufacturer and structure, and directional relief only on directional prints", () => {
    const pw: SurfaceProfile = {
      id: "surface/test-pw-relief",
      category: "laminate",
      sharing: { kind: "verified-structure", manufacturer: CLICKBED_DECOR_SOURCE, structures: ["PW"], evidence: "test" },
      maps: { normal: repeatMap("test:pore-n", true), roughness: repeatMap("test:pore-r", true) },
      normalScale: [1, 1],
    };
    const { registry, issues } = testRegistry({
      surfaces: [pw],
      surfaceAssignments: [
        { id: "t/pw", match: { manufacturer: CLICKBED_DECOR_SOURCE, structure: "PW" }, surfaceProfileId: pw.id, evidence: "test" },
        // Deliberately wrong data: a smooth (SM, uniform) decor pointed at the PW relief.
        { id: "t/wrong", match: { decorId: "8685-SM" }, surfaceProfileId: pw.id, evidence: "test" },
      ],
    });
    expect(issues).toEqual([]);
    const k003 = registry.resolve(bedDecorSelection(4000, "standard", "K003-PW"));
    // K003-PW is a directional (grain) print with structure PW: maps applied.
    expect(decorDefinition(K003).baseColor.kind === "map" && decorDefinition(K003).baseColor).toBeTruthy();
    expect(Object.keys(k003.surface!.maps)).toEqual(["normal", "roughness"]);
    expect(k003.resolutionIssues).toBeUndefined();
    // Other structures keep their own (map-free) profile.
    expect(registry.resolve(bedDecorSelection(4000, "avant-garde", "7045-AG")).surface).toMatchObject({ id: "surface/lacquer", maps: {} });
    // A rule pointing another structure at the PW relief: maps withheld and reported — never borrowed relief.
    const wrong = registry.resolve(bedDecorSelection(4000, "standard", "8685-SM"));
    expect(wrong.surface!.maps).toEqual({});
    expect(wrong.resolutionIssues).toEqual(["incompatible-surface-registration"]);
  });

  it("requires registration identity, coverage and phase for in-register maps", () => {
    const registered = (phase: [number, number], coverage: [number, number] = [0.6, 0.6]): SurfaceProfile => ({
      id: "surface/test-k003-emboss",
      category: "laminate",
      sharing: { kind: "decor-registered", registrationId: "test-reg-1" },
      maps: { normal: { assetId: "test:pore-n", alignment: { kind: "decor-registered", registrationId: "test-reg-1", coverageM: coverage, phaseM: phase } } },
      normalScale: [1, 1],
    });
    const assignment = { id: "t/emb", match: { decorId: "K003-PW" }, surfaceProfileId: "surface/test-k003-emboss", registrationId: "test-reg-1", registrationPhaseM: [0, 0] as const, evidence: "test" };
    const decor = { ...decorDefinition(K003), registrationId: "test-reg-1" };
    const ok = testRegistry({ surfaces: [registered([0, 0])], surfaceAssignments: [assignment] });
    expect(ok.issues).toEqual([]);
    expect(ok.registry.surfaceForDecor(decor, "surface/smooth-board")).toMatchObject({ issues: [] });
    // The decor's print carries no matching registration: withheld.
    expect(ok.registry.surfaceForDecor(decorDefinition(K003), "surface/smooth-board").issues).toEqual(["incompatible-surface-registration"]);
    // Wrong phase or coverage: withheld.
    const phase = testRegistry({ surfaces: [registered([0.1, 0])], surfaceAssignments: [assignment] });
    expect(phase.registry.surfaceForDecor(decor, "surface/smooth-board").issues).toEqual(["incompatible-surface-registration"]);
    const coverage = testRegistry({ surfaces: [registered([0, 0], [0.4, 0.4])], surfaceAssignments: [assignment] });
    expect(coverage.registry.surfaceForDecor(decor, "surface/smooth-board").surface.maps).toEqual({});
    // A registered profile assigned without its registration is a validation error.
    const bad = testRegistry({ surfaces: [registered([0, 0])], surfaceAssignments: [{ ...assignment, registrationId: undefined }] });
    expect(bad.issues.some((i) => i.includes("registered to test-reg-1"))).toBe(true);
  });
});

describe("texture asset validation (D-11)", () => {
  it("rejects lossy data maps, KTX2 (no loader), sRGB data maps and directional universal sharing", () => {
    const jpegNormal: TextureAsset = { ...png("test:jpeg-n", "normal"), variants: { standard: { url: "/x.jpg", width: 512, height: 512, format: "jpeg" } } };
    const ktx: TextureAsset = { ...png("test:ktx", "baseColor"), variants: { standard: { url: "/x.ktx2", width: 512, height: 512, format: "ktx2" } } };
    const srgbRough: TextureAsset = { ...png("test:srgb-r", "roughness"), colorSpace: "srgb" };
    const { issues } = testRegistry({
      textures: [jpegNormal, ktx, srgbRough],
      surfaces: [
        { id: "surface/a", category: "laminate", sharing: { kind: "universal-isotropic" }, maps: { normal: repeatMap("test:jpeg-n", false), roughness: repeatMap("test:srgb-r", false) }, normalScale: [1, 1] },
        { id: "surface/b", category: "metal", sharing: { kind: "universal-isotropic" }, maps: { normal: repeatMap("test:pore-n", true) }, normalScale: [1, 1] },
      ],
      materials: [{ id: "test/ktx", category: "laminate", color: { kind: "map", map: repeatMap("test:ktx", false), meanSrgbHex: "#808080" }, surfaceProfileId: "surface/smooth-board", finishProfileId: "finish/board-satin", provenance: "test" }],
    });
    expect(issues.some((i) => i.includes("lossless PNG, not jpeg"))).toBe(true);
    expect(issues.some((i) => i.includes("KTX2 is not implemented"))).toBe(true);
    expect(issues.some((i) => i.includes("colour space srgb for roughness"))).toBe(true);
    expect(issues.some((i) => i.includes("cannot be shared as universal-isotropic"))).toBe(true);
  });
});

describe("unavailable manufacturer appearance (D-8)", () => {
  it("is a neutral dielectric — no gloss lacquer, no metal foil — for every swatchless decor", () => {
    const options = getBedOptions(4000);
    for (const category of options.categories) {
      for (const decor of category.decors.filter((d) => !d.swatch)) {
        const r = materialRegistry.resolve(bedDecorSelection(4000, category.id, decor.id));
        expect(r.availability).toBe("missing-authorized-swatch");
        expect(r.finish?.id).toBe(UNAVAILABLE_FINISH_ID);
        expect(r.finish?.metalness).toBe(0);
        expect(r.finish?.clearcoat).toBeUndefined();
      }
    }
    // The metal-foil AL decors (all swatchless) are no longer rendered metallic.
    expect(materialRegistry.resolve(bedDecorSelection(4000, "metal", "AL01")).finish?.metalness).toBe(0);
  });
});

describe("room surfaces own their surface profiles (F-3)", () => {
  it("wall and floor microstructure can never reach doors, hardware, boards or decors", () => {
    const wall = materialRegistry.resolve(configuredColor(ROOM_WALL_TEMPLATE, "#F2F0EB"));
    const floor = materialRegistry.resolve(configuredColor(ROOM_FLOOR_TEMPLATE, "#C8B49A"));
    expect(wall.surface?.id).toBe("surface/wall-plaster");
    expect(floor.surface?.id).toBe("surface/floor-covering");
    // No other material, template, hardware finish or decor assignment uses either profile.
    const users = (MATERIAL_SEED.materials ?? []).filter((m) => m.surfaceProfileId === "surface/wall-plaster" || m.surfaceProfileId === "surface/floor-covering");
    expect(users.map((m) => m.id).sort()).toEqual([ROOM_FLOOR_TEMPLATE, ROOM_WALL_TEMPLATE].sort());
    expect(CLICKBED_SURFACE_ASSIGNMENTS.some((a) => a.surfaceProfileId.startsWith("surface/wall") || a.surfaceProfileId.startsWith("surface/floor"))).toBe(false);
    expect(materialRegistry.resolve(configuredColor(DOOR_LEAF_TEMPLATE, "#FFFFFF")).surface?.id).toBe("surface/paint");
    // Configured colours unchanged (saved configurations keep their meaning).
    expect(wall.color).toEqual({ kind: "solid", srgbHex: "#F2F0EB" });
  });
});
