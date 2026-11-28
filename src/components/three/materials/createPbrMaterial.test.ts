import { Color, DataTexture, DoubleSide, MeshPhysicalMaterial, MeshStandardMaterial, RGBAFormat, SRGBColorSpace, Vector2 } from "three";
import { describe, expect, it } from "vitest";
import { createMaterialRegistry, MATERIAL_SEED, materialRegistry } from "@/domain/materials";
import { bedDecorSelection, cabinetFinishSelection, hardwareFinishSelection, REGISTERED, UNAVAILABLE_PREVIEW_HEX } from "@/domain/materials/bindings";
import type { MaterialSelection, RendererCapabilities } from "@/domain/materials/contracts";
import { createPbrMaterial } from "./createPbrMaterial";
import { PHOTO_CAPABILITIES, PHOTO_PROFILE, VIEWPORT_CONSTRAINED, VIEWPORT_STANDARD } from "./materialQuality";
import { createSourceCache, createTextureResources, type ImageLoad } from "./textureResources";

const VIEWPORT: RendererCapabilities = { ...PHOTO_CAPABILITIES, mode: "viewport", maxAnisotropy: 16, supportsTransmission: false };
const METRES = { kind: "authored-uv0", uvUnits: "metres" } as const;

function build(selection: MaterialSelection, options: { load?: ImageLoad; capabilities?: RendererCapabilities; quality?: typeof VIEWPORT_CONSTRAINED; authored?: MeshStandardMaterial; registry?: typeof materialRegistry } = {}) {
  const urls: string[] = [];
  const textures = createTextureResources({
    sources: createSourceCache(options.load ?? (async (url) => (urls.push(url), { width: 256, height: 256 }))),
  });
  const registry = options.registry ?? materialRegistry;
  const instance = createPbrMaterial({
    resolved: registry.resolve(selection),
    side: "front",
    mapping: METRES,
    capabilities: options.capabilities ?? VIEWPORT,
    quality: options.quality ?? VIEWPORT_CONSTRAINED,
    textures,
    registry,
    authored: options.authored ?? null,
  });
  return { instance, textures, urls };
}

describe("shared PBR material factory", () => {
  it("cabinet finishes: exact catalog colour and roughness, standard dielectric response, cheap Standard shader in the viewport", () => {
    const { instance } = build(cabinetFinishSelection("walnut"));
    expect(instance.material).toBeInstanceOf(MeshStandardMaterial);
    expect(instance.material).not.toBeInstanceOf(MeshPhysicalMaterial);
    expect(instance.material.color.getHexString()).toBe(new Color("#67452F").getHexString());
    expect(instance.material).toMatchObject({ roughness: 0.65, metalness: 0, map: null });
    expect(instance.issues).toEqual([]);
  });

  it("the photo profile builds the same appearance as a physical material", () => {
    const live = build(cabinetFinishSelection("walnut")).instance.material;
    const photo = build(cabinetFinishSelection("walnut"), { capabilities: PHOTO_CAPABILITIES, quality: PHOTO_PROFILE }).instance.material;
    expect(photo).toBeInstanceOf(MeshPhysicalMaterial);
    expect(photo.color.equals(live.color)).toBe(true);
    expect([photo.roughness, photo.metalness]).toEqual([live.roughness, live.metalness]);
    expect((photo as MeshPhysicalMaterial).specularIntensity).toBe(1);
  });

  it("gloss decors get the clear-coat lacquer in every renderer (viewport included)", async () => {
    const { instance } = build(bedDecorSelection(4000, "avant-garde", "7045-AG"));
    const m = instance.material as MeshPhysicalMaterial;
    expect(m).toBeInstanceOf(MeshPhysicalMaterial);
    expect(m).toMatchObject({ roughness: 0.12, clearcoat: 1, clearcoatRoughness: 0.04 });
    await instance.ready;
  });

  it("decor images: shown at their physical repeat with capped anisotropy; the same decor's mean colour while loading", async () => {
    let resolveLoad: (v: { width: number; height: number }) => void = () => {};
    const { instance } = build(bedDecorSelection(4000, "standard", "K003-PW"), { load: () => new Promise((r) => (resolveLoad = r)) });
    // Loading: the selected decor's own catalog colour, never a previous or different decor.
    expect(instance.material.map).toBeNull();
    const swatch = materialRegistry.resolve(bedDecorSelection(4000, "standard", "K003-PW")).color;
    expect(swatch?.kind).toBe("map");
    if (swatch?.kind === "map") expect(instance.material.color.getHexString()).toBe(new Color(swatch.meanSrgbHex).getHexString());
    resolveLoad({ width: 406, height: 370 });
    await instance.ready;
    const map = instance.material.map!;
    expect(map.colorSpace).toBe(SRGBColorSpace);
    expect(map.repeat.toArray()).toEqual([1 / 0.6, 1 / 0.6]);
    expect(map.anisotropy).toBe(4); // UHD 620 class: 4× cap
    expect(instance.material.color.getHexString()).toBe("ffffff");
  });

  it("uses the enhanced tier for patterned decors, the standard tier for flat ones and per quality profile", async () => {
    const patterned = build(bedDecorSelection(4000, "standard", "K003-PW"));
    await patterned.instance.ready;
    expect(patterned.urls).toEqual(["/textures/decors/hd/K003-PW.jpg"]);
    const flat = build(bedDecorSelection(4000, "standard", "8685-SM"));
    await flat.instance.ready;
    expect(flat.urls).toEqual(["/textures/decors/8685-SM.jpg"]); // a uniform swatch: HD adds nothing
    const standard = build(bedDecorSelection(4000, "standard", "K003-PW"), { quality: VIEWPORT_STANDARD });
    await standard.instance.ready;
    expect(standard.instance.material.map!.anisotropy).toBe(8);
  });

  it("falls back from the enhanced to the standard image of the same decor; both failing keeps the mean colour and reports it", async () => {
    const fallback = build(bedDecorSelection(4000, "standard", "K003-PW"), {
      load: async (url) => {
        if (url.includes("/hd/")) throw new Error("404");
        return { width: 256, height: 256 };
      },
    });
    await fallback.instance.ready;
    expect(fallback.instance.material.map).not.toBeNull();
    expect(fallback.instance.issues).toContain("enhanced-variant-fallback");
    const failed = build(bedDecorSelection(4000, "standard", "K003-PW"), {
      load: async () => {
        throw new Error("offline");
      },
    });
    await failed.instance.ready;
    expect(failed.instance.material.map).toBeNull();
    expect(failed.instance.issues).toContain("texture-load-failed");
    expect(failed.instance.material.color.getHexString()).not.toBe(new Color(UNAVAILABLE_PREVIEW_HEX).getHexString());
  });

  it("decors without an authorized swatch: the explicit unavailable indicator and issue", () => {
    const { instance, urls } = build(bedDecorSelection(4000, "standard", "8361-SN"));
    expect(instance.material.map).toBeNull();
    expect(instance.material.color.getHexString()).toBe(new Color(UNAVAILABLE_PREVIEW_HEX).getHexString());
    expect(instance.issues).toContain("missing-authorized-swatch");
    expect(urls).toEqual([]);
  });

  it("ignores texture completions after dispose (rapid selection changes)", async () => {
    let resolveLoad: (v: { width: number; height: number }) => void = () => {};
    const { instance, textures } = build(bedDecorSelection(4000, "standard", "K003-PW"), { load: () => new Promise((r) => (resolveLoad = r)) });
    instance.dispose();
    instance.dispose();
    resolveLoad({ width: 8, height: 8 });
    await instance.ready;
    expect(instance.material.map).toBeNull();
    expect(textures.stats().activeLeases).toBe(0);
  });

  it("glass: physical transmission where supported, the documented transparent proxy in the viewport", () => {
    const viewport = build({ kind: "registered", id: REGISTERED.glass }).instance;
    expect(viewport.material).toMatchObject({ transparent: true, opacity: 0.45, depthWrite: false });
    expect(viewport.material.color.getHexString()).toBe(new Color("#A9CBE0").getHexString());
    expect(viewport.issues).toContain("transmission-fallback");
    const photo = build({ kind: "registered", id: REGISTERED.glass }, { capabilities: PHOTO_CAPABILITIES, quality: PHOTO_PROFILE }).instance;
    expect(photo.material).toMatchObject({ transmission: 1, ior: 1.5, thickness: 0.004, transparent: false });
    expect(photo.material.color.getHexString()).toBe(new Color("#F3F8F6").getHexString());
  });

  it("metals are fully metallic with a reflection environment and capped (reported) without one", () => {
    expect(build(hardwareFinishSelection("chrome")).instance.material.metalness).toBe(1);
    const noEnv = build(hardwareFinishSelection("chrome"), { capabilities: { ...VIEWPORT, reflections: false } }).instance;
    expect(noEnv.material.metalness).toBe(0.35);
    expect(noEnv.issues).toContain("reflection-fallback");
  });

  it("authored materials keep every property an override does not name (embedded PBR textures included)", () => {
    const albedo = new DataTexture(new Uint8Array(16), 2, 2, RGBAFormat);
    const normal = new DataTexture(new Uint8Array(16), 2, 2, RGBAFormat);
    const authored = new MeshStandardMaterial({ color: "#E6E3DC", map: albedo, normalMap: normal, normalScale: new Vector2(0.4, 0.4), roughness: 0.9, emissive: "#010203" });
    // Mode 2: the authored material as-is.
    const plain = build({ kind: "authored" }, { authored }).instance.material;
    expect(plain).not.toBe(authored);
    // Scope-owned copies: the same decoded pixels (texture source), their own sampler/transform state.
    expect(plain.map).not.toBe(albedo);
    expect(plain.map!.source).toBe(albedo.source);
    expect(plain.normalMap!.source).toBe(normal.source);
    expect(plain.normalScale.x).toBe(0.4);
    expect(plain.roughness).toBe(0.9);
    // Mode 3: selective override — finish only (textile): maps and emissive stay, scalars and sheen change.
    const fabric = build({ kind: "authored", overrides: { finishProfileId: "finish/textile-ticking" } }, { authored }).instance.material as MeshPhysicalMaterial;
    expect([fabric.map!.source, fabric.normalMap!.source]).toEqual([albedo.source, normal.source]);
    expect(fabric.emissive.getHexString()).toBe(authored.emissive.getHexString());
    expect(fabric).toMatchObject({ roughness: 1, sheen: 0.35 });
    expect(Math.max(fabric.color.r, fabric.color.g, fabric.color.b)).toBeCloseTo(0.72, 5);
    // Colour override: the colour identity of another selection replaces only colour and base map.
    const recoloured = build({ kind: "authored", overrides: { baseColor: cabinetFinishSelection("walnut") } }, { authored }).instance.material;
    expect(recoloured.map).toBeNull();
    expect(recoloured.normalMap!.source).toBe(normal.source);
    expect(recoloured.color.getHexString()).toBe(new Color("#67452F").getHexString());
    // The authored source is never modified.
    expect(authored.color.getHexString()).toBe(new Color("#E6E3DC").getHexString());
  });

  it("surface maps of a profile are applied with their data colour space, and disabled per quality profile", async () => {
    const registry = createMaterialRegistry(MATERIAL_SEED);
    registry.register({
      textures: [{ id: "test:weave-n", semantic: "normal", colorSpace: "data", variants: { standard: { url: "/test/weave_n.png", width: 512, height: 512, format: "png" } }, provenance: "test fixture" }],
      surfaces: [
        {
          id: "surface/test-weave",
          category: "textile",
          sharing: { kind: "universal-isotropic" },
          maps: { normal: { assetId: "test:weave-n", alignment: { kind: "surface-repeat", coverageM: [0.1, 0.1], directional: false } } },
          normalScale: [0.5, 0.5],
        },
      ],
      materials: [{ id: "test/ticking", category: "textile", color: { kind: "solid", srgbHex: "#EEEEEE" }, surfaceProfileId: "surface/test-weave", finishProfileId: "finish/textile-ticking", provenance: "test" }],
    });
    const on = build({ kind: "registered", id: "test/ticking" }, { registry });
    await on.instance.ready;
    expect(on.instance.material.normalMap?.repeat.toArray()).toEqual([10, 10]);
    expect(on.instance.material.normalMap?.colorSpace).toBe("");
    expect(on.instance.material.normalScale.x).toBe(0.5);
    const off = build({ kind: "registered", id: "test/ticking" }, { registry, quality: { ...VIEWPORT_CONSTRAINED, enabledOptionalMaps: new Set() } });
    await off.instance.ready;
    expect(off.instance.material.normalMap).toBeNull();
    expect(off.instance.issues).toContain("optional-map-disabled");
  });

  it("honours the slot side", () => {
    const registry = materialRegistry;
    const textures = createTextureResources();
    const m = createPbrMaterial({ resolved: registry.resolve(cabinetFinishSelection("walnut")), side: "double", capabilities: VIEWPORT, quality: VIEWPORT_CONSTRAINED, textures, registry }).material;
    expect(m.side).toBe(DoubleSide);
  });
});
