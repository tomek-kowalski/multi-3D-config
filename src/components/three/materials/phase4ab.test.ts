import { BoxGeometry, Color, Mesh, MeshPhysicalMaterial, PlaneGeometry, Scene, Texture, type MeshStandardMaterial } from "three";
import { describe, expect, it } from "vitest";
import { materialRegistry, pbrTextureAssets } from "@/domain/materials";
import { decorTextureAssets } from "@/domain/materials/textures";
import {
  bedDecorSelection,
  cabinetFinishSelection,
  configuredColor,
  floorMaterialRegistryId,
  ROOM_WALL_TEMPLATE,
} from "@/domain/materials/bindings";
import type { MappingSpec, MaterialQualityProfile, MaterialSelection, RendererCapabilities } from "@/domain/materials/contracts";
import { fitTraceLayers } from "../photo/backends";
import { calibrationGain, createPbrMaterial, mapScalar } from "./createPbrMaterial";
import { PHOTO_CAPABILITIES, PHOTO_PROFILE, VIEWPORT_CONSTRAINED, VIEWPORT_STANDARD } from "./materialQuality";
import { maxMetricUvError, writeFloorMetreUvs } from "./physicalUv";
import { createSourceCache, createTextureResources } from "./textureResources";

const VIEWPORT: RendererCapabilities = { ...PHOTO_CAPABILITIES, mode: "viewport", maxAnisotropy: 16, supportsTransmission: false };
const BOX: MappingSpec = { kind: "part-metres", convention: "box", grainAxis: "y", phaseM: [0, 0] };
const FLOOR: MappingSpec = { kind: "projected-metres", originM: [0, 0, 0], uAxis: [1, 0, 0], vAxis: [0, 0, 1] };
const MIB = 1024 * 1024;

/** Pixel size of every registered image variant by URL (the fake loader returns images of that size). */
const SIZES = new Map<string, { width: number; height: number }>();
for (const asset of [...pbrTextureAssets(), ...decorTextureAssets()]) {
  for (const v of Object.values(asset.variants)) if (v) SIZES.set(v.url, { width: v.width, height: v.height });
}

function scope(quality: MaterialQualityProfile, budget = { maxResidentBytes: quality.maxResidentTextureBytes, maxIdleBytes: quality.maxIdleTextureBytes }) {
  const urls: string[] = [];
  const textures = createTextureResources({ budget, sources: createSourceCache(async (url) => (urls.push(url), SIZES.get(url) ?? { width: 8, height: 8 })) });
  const build = (selection: MaterialSelection, mapping: MappingSpec = BOX, capabilities: RendererCapabilities = VIEWPORT) =>
    createPbrMaterial({ resolved: materialRegistry.resolve(selection), side: "front", mapping, capabilities, quality, textures, registry: materialRegistry, authored: null });
  return { textures, urls, build };
}

const linear = (hex: string) => {
  const c = new Color(hex);
  return [c.r, c.g, c.b];
};

describe("Phase 4A — calibrated wood finishes", () => {
  it("the calibrated surface's mean equals the catalog colour in linear space; texel ratios (grain contrast) are kept", async () => {
    for (const [id, hex] of [
      ["natural-oak", "#C9A273"],
      ["sonoma-oak", "#B89469"],
      ["walnut", "#67452F"],
    ] as const) {
      const { build } = scope(VIEWPORT_CONSTRAINED);
      const instance = build(cabinetFinishSelection(id));
      // Before the image arrives: the catalog colour itself.
      expect(instance.material.color.getHexString()).toBe(new Color(hex).getHexString());
      await instance.ready;
      const m = instance.material;
      expect(m.map).not.toBeNull();
      const mean = m.userData.meanLinearAlbedo as number[];
      linear(hex).forEach((c, i) => expect(mean[i]).toBeCloseTo(c, 6));
      // A per-channel linear gain below 1: no channel is pushed above the image's own range.
      expect(Math.max(m.color.r, m.color.g, m.color.b)).toBeLessThan(1);
      // The material's mean roughness stays the catalog finish's (map mean × scalar).
      const asset = materialRegistry.getTextureAsset((materialRegistry.resolve(cabinetFinishSelection(id)) as { surface: { maps: { roughness: { assetId: string } } } }).surface.maps.roughness.assetId);
      expect(m.roughness * asset.statistics!.meanValue!).toBeCloseTo(materialRegistry.getFinishProfile(`finish/cabinet-${id}`).roughness, 6);
      instance.dispose();
    }
  });

  it("calibration is a pure gain: target / measured mean, independent of the colour's sRGB encoding", () => {
    const asset = materialRegistry.getTextureAsset("pbr:walnut_veneer_02/baseColor");
    const gain = calibrationGain(asset, "#67452F")!;
    const mean = asset.statistics!.meanLinearRgb!;
    linear("#67452F").forEach((c, i) => expect([gain.r, gain.g, gain.b][i] * mean[i]).toBeCloseTo(c, 9));
    expect(calibrationGain({ ...asset, statistics: undefined }, "#67452F")).toBeNull();
    expect(mapScalar(0.5, { ...asset, statistics: { meanValue: 0.25 } })).toBe(2);
    expect(mapScalar(0.5, { ...asset, statistics: undefined })).toBe(0.5);
  });

  it("other catalog finishes stay solid colours without maps", async () => {
    const { build, urls } = scope(VIEWPORT_CONSTRAINED);
    const white = build(cabinetFinishSelection("white-matte"));
    await white.ready;
    expect(white.material.map).toBeNull();
    expect(white.material.normalMap).toBeNull();
    expect(urls).toEqual([]);
  });
});

describe("Phase 4A/4B — texture budgets of a representative room", () => {
  // Three wood finishes (each on several parts), white boards, walls in light/dark/saturated colours,
  // a textured floor and a ClickBed with manufacturer decors on front and body.
  const ROOM: [MaterialSelection, MappingSpec][] = [
    [cabinetFinishSelection("natural-oak"), BOX],
    [cabinetFinishSelection("natural-oak"), BOX],
    [cabinetFinishSelection("sonoma-oak"), BOX],
    [cabinetFinishSelection("sonoma-oak"), BOX],
    [cabinetFinishSelection("walnut"), BOX],
    [cabinetFinishSelection("walnut"), BOX],
    [cabinetFinishSelection("white-matte"), BOX],
    [configuredColor(ROOM_WALL_TEMPLATE, "#F2EFE9"), FLOOR],
    [configuredColor(ROOM_WALL_TEMPLATE, "#2B2B2E"), FLOOR],
    [configuredColor(ROOM_WALL_TEMPLATE, "#1F5FA8"), FLOOR],
    [configuredColor(ROOM_WALL_TEMPLATE, "#C24A2C"), FLOOR],
    [{ kind: "registered", id: floorMaterialRegistryId("herringbone-parquet") }, FLOOR],
    [bedDecorSelection(4000, "standard", "K001-PW"), BOX],
    [bedDecorSelection(4000, "standard", "K019-PW"), BOX],
    [bedDecorSelection(4000, "contempo", "K349-RT"), BOX],
  ];

  async function buildRoom(quality: MaterialQualityProfile, capabilities: RendererCapabilities = VIEWPORT) {
    const s = scope(quality);
    const instances = ROOM.map(([selection, mapping]) => s.build(selection, mapping, capabilities));
    await Promise.all(instances.map((i) => i.ready));
    return { ...s, instances };
  }

  it("UHD 620 (constrained, 32 MiB): everything fits at the standard tier — no map is dropped, materials share textures", async () => {
    const { textures, instances, urls } = await buildRoom(VIEWPORT_CONSTRAINED);
    const stats = textures.stats();
    // Measured with the real image sizes: a minimal scene would prove nothing.
    expect(stats.activeBytes).toBeGreaterThan(20 * MIB);
    expect(stats.activeBytes).toBeLessThanOrEqual(32 * MIB);
    expect(instances.flatMap((i) => i.issues).filter((i) => i.startsWith("budget"))).toEqual([]);
    // Standard tiers only (1K colour, 512 normals, 256 roughness); never a 2K image.
    expect(urls.some((u) => u.includes("_2k") || u.includes("normal_1k") || u.includes("roughness_1k"))).toBe(false);
    // One texture per (image, use): shared by every part with the same finish.
    expect(instances[0].material.map).toBe(instances[1].material.map);
    expect(instances[7].material.normalMap).toBe(instances[9].material.normalMap);
    for (const i of [0, 2, 4, 11]) {
      const m = instances[i].material;
      expect(m.map && m.normalMap && m.roughnessMap, `material ${i}`).toBeTruthy();
    }
    console.info(`constrained room: ${(stats.activeBytes / MIB).toFixed(1)} MiB active, ${new Set(urls).size} images`);
  });

  it("discrete GPU (standard, 128 MiB): 1K normal/roughness, 1K colour — no 2K image in the viewport", async () => {
    const { textures, urls, instances } = await buildRoom(VIEWPORT_STANDARD);
    expect(textures.stats().activeBytes).toBeLessThanOrEqual(128 * MIB);
    expect(urls.some((u) => u.includes("_2k"))).toBe(false);
    expect(urls.some((u) => u.includes("normal_1k"))).toBe(true);
    expect(instances.flatMap((i) => i.issues).filter((i) => i.startsWith("budget"))).toEqual([]);
  });

  it("photo profile: enhanced tiers (2K colour) within 256 MiB, and the path tracer's layer budget holds the room", async () => {
    const { textures, urls, instances } = await buildRoom(PHOTO_PROFILE, PHOTO_CAPABILITIES);
    expect(textures.stats().activeBytes).toBeLessThanOrEqual(256 * MIB);
    expect(urls).toContain("/textures/pbr/herringbone_parquet/albedo_2k.jpg");
    const scene = new Scene();
    for (const i of instances) scene.add(new Mesh(new BoxGeometry(), i.material));
    const fit = fitTraceLayers(scene, 16);
    expect(fit.layers).toBeLessThanOrEqual(16);
    // Base colours are never dropped to meet the layer budget.
    scene.children.forEach((mesh, i) => {
      if (instances[i].material.map) expect(((mesh as Mesh).material as MeshStandardMaterial).map).toBe(instances[i].material.map);
    });
    console.info(`photo room: ${(textures.stats().activeBytes / MIB).toFixed(1)} MiB, trace layers ${fit.layers} (dropped: ${fit.dropped.join(", ") || "none"})`);
  });

  it("reduction under a tight budget is deterministic and never drops a base colour", async () => {
    const tight = { maxResidentBytes: 20 * MIB, maxIdleBytes: 0 };
    const run = async () => {
      const s = scope(VIEWPORT_CONSTRAINED, tight);
      const instances = ROOM.map(([selection, mapping]) => s.build(selection, mapping));
      await Promise.all(instances.map((i) => i.ready));
      return instances.map((i) => ({ map: !!i.material.map, normal: !!i.material.normalMap, rough: !!i.material.roughnessMap, issues: i.issues.join(",") }));
    };
    const a = await run();
    const b = await run();
    expect(a).toEqual(b);
    for (const [i, [selection]] of ROOM.entries()) {
      const resolved = materialRegistry.resolve(selection);
      if (resolved.color?.kind === "map") expect(a[i].map, `base colour ${i}`).toBe(true);
    }
    expect(a.some((r) => r.issues.includes("budget-reduced"))).toBe(true);
  });
});

describe("Phase 4 — path-tracer map budget keeps calibrated scalars meaningful", () => {
  it("dropping a roughness map restores the finish's own roughness on the per-view copy", async () => {
    const { build } = scope(PHOTO_PROFILE);
    const instance = build({ kind: "registered", id: floorMaterialRegistryId("herringbone-parquet") }, FLOOR, PHOTO_CAPABILITIES);
    await instance.ready;
    const m = instance.material as MeshPhysicalMaterial;
    expect(m.roughness).toBeCloseTo(0.32 / 0.0965, 3); // finish / map mean while the map is used
    const scene = new Scene();
    scene.add(new Mesh(new PlaneGeometry(), m));
    // Six distinct textures needed (3 here + 3 extra dummies) with room for only two: roughness, then normal maps go.
    for (let k = 0; k < 3; k++) {
      const extra = new Mesh(new BoxGeometry(), m.clone());
      (extra.material as MeshStandardMaterial).map = new Texture();
      scene.add(extra);
    }
    const fit = fitTraceLayers(scene, 4);
    expect(fit.dropped).toContain("roughnessMap");
    const copy = (scene.children[0] as Mesh).material as MeshPhysicalMaterial;
    expect(copy).not.toBe(m);
    expect(copy.roughnessMap).toBeNull();
    expect(copy.roughness).toBe(0.32);
    // The live material is untouched.
    expect(m.roughnessMap).not.toBeNull();
    instance.dispose();
  });
});

describe("Phase 4B — floor UVs along the plank axis", () => {
  const uvOf = (g: PlaneGeometry, i: number) => [g.getAttribute("uv").getX(i), g.getAttribute("uv").getY(i)];
  const plane = (W: number, D: number, axis: "x" | "z") => {
    const g = new PlaneGeometry(W, D, 2, 2);
    writeFloorMetreUvs(g, W, D, axis);
    return g;
  };

  it("metric in both axes; 'z' is the 'x' layout rotated by 90° (not mirrored)", () => {
    for (const axis of ["x", "z"] as const) expect(maxMetricUvError(plane(4.2, 3.1, axis))).toBeLessThan(1e-6);
    const gx = plane(4, 3, "x");
    const gz = plane(4, 3, "z");
    const pos = gx.getAttribute("position");
    for (let i = 0; i < pos.count; i++) {
      const [ux, vx] = uvOf(gx, i);
      const [uz, vz] = uvOf(gz, i);
      expect(uz).toBeCloseTo(vx, 9);
      expect(vz).toBeCloseTo(-ux, 9);
    }
    // Orientation: the UV triangle winding matches the geometry's (positive determinant) for both axes.
    for (const g of [gx, gz]) {
      const idx = g.index!;
      const p = g.getAttribute("position");
      const [a, b, c] = [idx.getX(0), idx.getX(1), idx.getX(2)];
      const cross = (x1: number, y1: number, x2: number, y2: number) => x1 * y2 - y1 * x2;
      const geo = cross(p.getX(b) - p.getX(a), p.getY(b) - p.getY(a), p.getX(c) - p.getX(a), p.getY(c) - p.getY(a));
      const [ua, va] = uvOf(g, a);
      const [ub, vb] = uvOf(g, b);
      const [uc, vc] = uvOf(g, c);
      // Floor plane: v grows towards +z (front) = −y of the plane, so the UV winding is opposite to the plane's.
      expect(Math.sign(cross(ub - ua, vb - va, uc - ua, vc - va))).toBe(-Math.sign(geo));
    }
  });

  it("resizing the room keeps the pattern fixed at the back-left corner for both axes", () => {
    for (const axis of ["x", "z"] as const) {
      const small = plane(3, 3, axis);
      const large = plane(5, 4, axis);
      // The back-left corner (plane x = −W/2, y = +D/2) has UV (0, 0) in every size.
      const corner = (g: PlaneGeometry, W: number, D: number) => {
        const p = g.getAttribute("position");
        for (let i = 0; i < p.count; i++) if (Math.abs(p.getX(i) + W / 2) < 1e-9 && Math.abs(p.getY(i) - D / 2) < 1e-9) return uvOf(g, i);
        throw new Error("corner not found");
      };
      expect(corner(small, 3, 3).map((v) => Math.abs(v))).toEqual([0, 0]);
      expect(corner(large, 5, 4).map((v) => Math.abs(v))).toEqual([0, 0]);
    }
  });
});
