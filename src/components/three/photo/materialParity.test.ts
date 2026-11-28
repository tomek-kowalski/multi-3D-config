import { readFileSync } from "node:fs";
import { join } from "node:path";
import { BoxGeometry, Group, Mesh, MeshPhysicalMaterial, MeshStandardMaterial, Scene, Texture, type Object3D } from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { PathTracingSceneGenerator } from "three-gpu-pathtracer";
import { describe, expect, it } from "vitest";
import { getBedModel } from "@/domain/beds/catalog";
import { materialRegistry } from "@/domain/materials";
import { cabinetFinishSelection } from "@/domain/materials/bindings";
import type { MeshMaterialBinding } from "@/domain/materials/contracts";
import { PHOTO_CAPABILITIES, VIEWPORT_CONSTRAINED } from "../materials/materialQuality";
import { attachMaterialBinding, createSlotMaterials, installMaterials } from "../materials/materialSlots";
import { createSourceCache, createTextureResources } from "../materials/textureResources";
import { applyBedMaterials, applyBedVisibility, bedMaterialBinding, prepareBedScene } from "../modules/BedModel";
import { fitTraceLayers } from "./backends";
import { buildPhotoScene, sceneTextures, takeSnapshot } from "./photoScene";
import { settingsKey, DEFAULT_PHOTO_SETTINGS } from "./photoSettings";
import { photoTag } from "./tags";

const liveRuntime = () => ({
  registry: materialRegistry,
  capabilities: { ...PHOTO_CAPABILITIES, mode: "viewport" as const, supportsTransmission: false },
  quality: VIEWPORT_CONSTRAINED,
  textures: createTextureResources({ sources: createSourceCache(async () => ({ width: 256, height: 256 })) }),
});
const photoTextures = () => createTextureResources({ sources: createSourceCache(async () => ({ width: 406, height: 370 })) });

async function loadBed(): Promise<Object3D> {
  const buffer = readFileSync(join(__dirname, "../../../../public/models/clickbed", getBedModel("clickbed-o", "140x200")!.file));
  return (await new GLTFLoader().parseAsync(buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength), "")).scene;
}

const BANDED: MeshMaterialBinding = {
  slots: [
    { slotId: "face", selection: cabinetFinishSelection("walnut"), side: "front" },
    { slotId: "edge", selection: cabinetFinishSelection("white-matte"), side: "front" },
  ],
  groups: [0, 1, 2, 3].map((i) => ({ materialIndex: i, slotId: "edge" })).concat([4, 5].map((i) => ({ materialIndex: i, slotId: "face" }))),
};

describe("material parity between the viewport and both photo backends", () => {
  it("captures multi-material meshes with every group's own material, down to the path tracer's triangles", async () => {
    const scene = new Scene();
    const mesh = new Mesh(new BoxGeometry(0.4, 0.7, 0.019), new MeshStandardMaterial());
    mesh.userData = photoTag("board");
    const live = createSlotMaterials(BANDED, liveRuntime());
    installMaterials(mesh, live, BANDED);
    attachMaterialBinding(mesh, { binding: BANDED, authored: {} });
    scene.add(mesh);
    const snapshot = takeSnapshot(scene, { textures: photoTextures() });
    await snapshot.ready;
    // One item per geometry group, each with its group's range and material (BoxGeometry: 6 faces × 6 indices).
    expect(snapshot.items.map((i) => i.group)).toEqual([0, 1, 2, 3, 4, 5].map((g) => ({ start: g * 6, count: 6, materialIndex: g })));
    expect(snapshot.items.map((i) => (i.material.color.getHexString() === "67452f" ? "face" : "edge"))).toEqual(["edge", "edge", "edge", "edge", "face", "face"]);
    // Each group item holds only the vertices it draws (a box face: 4), so per-group copies in the path
    // tracer cost no more than the original mesh.
    expect(snapshot.items.map((i) => i.geometry.getAttribute("position").count)).toEqual([4, 4, 4, 4, 4, 4]);
    const photo = buildPhotoScene(snapshot, [], null);
    const result = new PathTracingSceneGenerator(photo).generate();
    const materials = result.materials as MeshPhysicalMaterial[];
    const index = result.geometry.getAttribute("materialIndex");
    const colours = new Set<string>();
    for (let v = 0; v < index.count; v++) colours.add(materials[index.getX(v)].color.getHexString());
    // Both slot colours reach the tracer's triangles: nothing was flattened to material 0.
    expect([...colours].sort()).toEqual([live.bySlot.get("face")!.material.color.getHexString(), live.bySlot.get("edge")!.material.color.getHexString()].sort());
    snapshot.dispose();
    live.dispose();
  });

  it("freezes the selection: re-binding the live mesh after the snapshot never changes the photo", async () => {
    const scene = new Scene();
    const mesh = new Mesh(new BoxGeometry(), new MeshStandardMaterial());
    mesh.userData = photoTag("board");
    const binding: MeshMaterialBinding = { slots: [{ slotId: "panel", selection: cabinetFinishSelection("walnut"), side: "front" }], groups: [] };
    attachMaterialBinding(mesh, { binding, authored: {} });
    scene.add(mesh);
    const snapshot = takeSnapshot(scene, { textures: photoTextures() });
    attachMaterialBinding(mesh, { binding: { ...binding, slots: [{ ...binding.slots[0], selection: cabinetFinishSelection("white-matte") }] }, authored: {} });
    await snapshot.ready;
    expect(snapshot.items[0].material.color.getHexString()).toBe("67452f");
    snapshot.dispose();
  });

  it("beds: viewport and photo materials agree slot by slot; same decor shares one texture, different decors do not", async () => {
    const make = async (front: string, body: string) => {
      const { root, sources } = prepareBedScene(await loadBed());
      const set = applyBedMaterials(root, sources, bedMaterialBinding(4000, { decorCategory: "standard", frontDecor: front, bodyDecor: body }), liveRuntime());
      applyBedVisibility(root, "unfolded", true);
      await set.ready;
      return { root, set };
    };
    const same = await make("K003-PW", "K003-PW");
    const different = await make("K003-PW", "K005-PW");
    const group = new Group();
    group.add(same.root, different.root);
    const snapshot = takeSnapshot(group, { textures: photoTextures() });
    await snapshot.ready;
    const scene = buildPhotoScene(snapshot, [], null);
    // K003 (shared by three slots across two beds) and K005: exactly two texture layers.
    expect(sceneTextures(scene).size).toBe(2);
    // Live and photo agree on every scalar of every slot (the photo is physical, the live view standard).
    for (const [slot, instance] of same.set.bySlot) {
      const photo = snapshot.items.find((i) => i.material.userData.materialId === instance.resolved.id && instance.material.color.getHex() === i.material.color.getHex());
      expect(photo, slot).toBeDefined();
      expect(photo!.material.roughness).toBe(instance.material.roughness);
      expect(photo!.material.metalness).toBe(instance.material.metalness);
    }
    snapshot.dispose();
    same.set.dispose();
    different.set.dispose();
  });

  it("counts path-tracer layers from real texture identity and reduces optional maps before giving up", () => {
    const scene = new Scene();
    const shared = new Texture();
    const normal = new Texture();
    const a = new MeshPhysicalMaterial({ map: shared, normalMap: normal });
    const b = new MeshPhysicalMaterial({ map: shared });
    scene.add(new Mesh(new BoxGeometry(), a), new Mesh(new BoxGeometry(), b));
    expect(sceneTextures(scene).size).toBe(2);
    expect(fitTraceLayers(scene, 2)).toEqual({ layers: 2, dropped: [], copies: [] });
    const fitted = fitTraceLayers(scene, 1);
    // Only maps actually removed are reported; one per-view copy of the one affected material.
    expect(fitted.layers).toBe(1);
    expect(fitted.dropped).toEqual(["normalMap"]);
    expect(fitted.copies).toHaveLength(1);
    // The decor colour image is never dropped, and the original (snapshot) material is untouched.
    expect(a.normalMap).toBe(normal);
    expect(fitTraceLayers(scene, 0).layers).toBe(1);
  });

  it("includes the renderer version and material catalog revision in the photo cache identity", () => {
    expect(settingsKey(DEFAULT_PHOTO_SETTINGS)).toContain(materialRegistry.revision);
    expect(settingsKey(DEFAULT_PHOTO_SETTINGS).startsWith("5|")).toBe(true);
  });
});
