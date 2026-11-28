import { BoxGeometry, DataTexture, Group, Mesh, MeshStandardMaterial, RGBAFormat, SRGBColorSpace, type Material } from "three";
import { createMaterialRegistry, MATERIAL_SEED, REGISTERED, hardwareFinishSelection } from "@/domain/materials";
import type { MaterialRegistry, MeshMaterialBinding, RegistryData, SlotId } from "@/domain/materials/contracts";
import { photoTag } from "../photo/tags";
import { attachMaterialBinding, createSlotMaterials, installMaterials, type MaterialRuntime, type SlotMaterialSet } from "./materialSlots";
import { partMapping, unitBoxWithMetreUvs } from "./physicalUv";

/**
 * TEST FIXTURE — a furniture type that is NOT in the production catalog (never registered in
 * src/domain/modules/registry.ts): an upholstered lounge chair with a side table. It integrates with
 * the universal material system purely by supplying geometry, material slots, mapping metadata and
 * registered or authored materials — no texture loader, material factory, lighting or photo code of
 * its own, and no change to those shared modules.
 *
 * - seat: one mesh with two slots on geometry groups (upholstery faces, leather piping on the edges);
 * - backrest: a new material category (leather) registered as data;
 * - frame: an existing registered hardware finish (brushed steel);
 * - side table top: the registered clear glass;
 * - shell: an imported (glTF-like) part with embedded PBR textures, kept as authored with a selective
 *   finish override (mode 3), UVs normalized with a documented physical span.
 */
export const FIXTURE_TYPE_ID = "fixture-lounge-chair";

/** Registry data the new type brings with it (no texture files: solid colours and existing profiles). */
export const FIXTURE_REGISTRY_DATA: RegistryData = {
  surfaces: [{ id: "surface/fixture-leather", category: "leather", sharing: { kind: "universal-isotropic" }, maps: {}, normalScale: [1, 1] }],
  materials: [
    { id: "fixture/upholstery-sand", category: "textile", color: { kind: "solid", srgbHex: "#B8A88E" }, surfaceProfileId: "surface/textile", finishProfileId: "finish/textile-upholstery", provenance: "test fixture" },
    { id: "fixture/leather-cognac", category: "leather", color: { kind: "solid", srgbHex: "#8A4B2A" }, surfaceProfileId: "surface/fixture-leather", finishProfileId: "finish/leather-semi-matte", provenance: "test fixture" },
  ],
};

/** A registry copy with the fixture's data (the production registry is never extended by the fixture). */
export function fixtureRegistry(): MaterialRegistry {
  const registry = createMaterialRegistry(MATERIAL_SEED);
  const issues = registry.register(FIXTURE_REGISTRY_DATA);
  if (issues.length > 0) throw new Error(issues.join("; "));
  return registry;
}

/** The imported shell's authored material: embedded colour and normal textures (as GLTFLoader yields). */
export function authoredShellMaterial(): MeshStandardMaterial {
  const albedo = new DataTexture(new Uint8Array([200, 180, 160, 255, 190, 170, 150, 255, 210, 190, 170, 255, 180, 160, 140, 255]), 2, 2, RGBAFormat);
  albedo.colorSpace = SRGBColorSpace;
  albedo.needsUpdate = true;
  const normal = new DataTexture(new Uint8Array([128, 128, 255, 255, 130, 126, 255, 255, 126, 130, 255, 255, 128, 128, 255, 255]), 2, 2, RGBAFormat);
  normal.needsUpdate = true;
  const material = new MeshStandardMaterial({ name: "shell", map: albedo, normalMap: normal, roughness: 0.8, metalness: 0 });
  return material;
}

interface FixturePart {
  readonly mesh: Mesh;
  readonly binding: MeshMaterialBinding;
  readonly authored: Readonly<Record<SlotId, Material | null>>;
}

/** Geometry + slot bindings + mapping of every part (what the type's module renderer would declare). */
export function fixtureParts(): FixturePart[] {
  const part = (name: string, size: readonly [number, number, number], position: readonly [number, number, number], binding: MeshMaterialBinding, authored: Record<SlotId, Material | null> = {}, geometry = unitBoxWithMetreUvs(size, "x")) => {
    const mesh = new Mesh(geometry);
    mesh.name = name;
    mesh.scale.set(...size);
    mesh.position.set(...position);
    mesh.userData = photoTag("board");
    return { mesh, binding, authored };
  };
  const seat: MeshMaterialBinding = {
    slots: [
      { slotId: "upholstery", selection: { kind: "registered", id: "fixture/upholstery-sand" }, mapping: partMapping("box", "x"), side: "front" },
      { slotId: "piping", selection: { kind: "registered", id: "fixture/leather-cognac" }, mapping: partMapping("box", "x"), side: "front" },
    ],
    // BoxGeometry groups: ±x, ±y, ±z faces → piping on the sides and front/back, upholstery on top/bottom.
    groups: [
      { materialIndex: 0, slotId: "piping" },
      { materialIndex: 1, slotId: "piping" },
      { materialIndex: 2, slotId: "upholstery" },
      { materialIndex: 3, slotId: "upholstery" },
      { materialIndex: 4, slotId: "piping" },
      { materialIndex: 5, slotId: "piping" },
    ],
  };
  const shellGeometry = new BoxGeometry(1, 1, 1); // authored, normalized UV0 per face
  return [
    part("seat", [0.7, 0.14, 0.65], [0.35, 0.38, 0.33], seat),
    part("backrest", [0.7, 0.5, 0.1], [0.35, 0.7, 0.05], { slots: [{ slotId: "leather", selection: { kind: "registered", id: "fixture/leather-cognac" }, mapping: partMapping("box", "x"), side: "front" }], groups: [] }),
    part("frame", [0.03, 0.31, 0.03], [0.05, 0.155, 0.6], { slots: [{ slotId: "frame", selection: hardwareFinishSelection("brushed-steel"), side: "front" }], groups: [] }),
    part("table-top", [0.45, 0.008, 0.45], [1.05, 0.5, 0.3], { slots: [{ slotId: "glass", selection: { kind: "registered", id: REGISTERED.glass }, side: "double" }], groups: [] }),
    part(
      "shell",
      [0.74, 0.3, 0.7],
      [0.35, 0.16, 0.35],
      {
        slots: [{ slotId: "shell", selection: { kind: "authored", overrides: { finishProfileId: "finish/leather-semi-matte" } }, mapping: { kind: "authored-uv0", uvUnits: "normalized", coverageM: [0.74, 0.7] }, side: "front" }],
        groups: [],
      },
      { shell: authoredShellMaterial() },
      shellGeometry,
    ),
  ];
}

/** Builds the fixture as the type's module renderer would: through the shared slot API only. */
export function buildFixture(runtime: MaterialRuntime): { root: Group; sets: SlotMaterialSet[] } {
  const root = new Group();
  root.name = FIXTURE_TYPE_ID;
  const sets: SlotMaterialSet[] = [];
  for (const { mesh, binding, authored } of fixtureParts()) {
    const set = createSlotMaterials(binding, runtime, authored);
    installMaterials(mesh, set, binding);
    attachMaterialBinding(mesh, { binding, authored });
    sets.push(set);
    root.add(mesh);
  }
  return { root, sets };
}
