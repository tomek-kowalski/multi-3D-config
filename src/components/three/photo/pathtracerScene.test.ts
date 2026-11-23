import { readFileSync } from "node:fs";
import { join } from "node:path";
import { BoxGeometry, Group, Mesh, MeshPhysicalMaterial, MeshStandardMaterial, PlaneGeometry, RepeatWrapping, SRGBColorSpace, Texture, type Object3D } from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { PathTracingSceneGenerator } from "three-gpu-pathtracer";
import { describe, expect, it } from "vitest";
import { getBedModel } from "@/domain/beds/catalog";
import { applyBedVisibility, prepareBedScene, SWATCH_SIZE_M } from "../modules/BedModel";
import { buildPhotoScene, takeSnapshot } from "./photoScene";
import { photoTag } from "./tags";

async function loadBed(): Promise<Object3D> {
  const buffer = readFileSync(join(__dirname, "../../../../public/models/clickbed", getBedModel("clickbed-o", "140x200")!.file));
  return (await new GLTFLoader().parseAsync(buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength), "")).scene;
}

/** A live scene like the app's: a bed with a wood decor, a cabinet panel, two walls and the floor. */
async function liveScene() {
  const root = new Group();
  const { root: bed, materials } = prepareBedScene(await loadBed());
  applyBedVisibility(bed, "unfolded", true);
  const decor = new Texture();
  decor.colorSpace = SRGBColorSpace;
  decor.wrapS = decor.wrapT = RepeatWrapping;
  decor.repeat.set(1 / SWATCH_SIZE_M, 1 / SWATCH_SIZE_M);
  for (const slot of ["front", "body"]) {
    const m = materials.get(slot)!;
    m.map = decor;
    m.color.set("#ffffff");
    m.userData.decor = { texture: "K001-PW.jpg", code: "K001", structure: "PW", swatchSizeM: SWATCH_SIZE_M };
  }
  root.add(bed);
  const panel = new Mesh(new BoxGeometry(), new MeshStandardMaterial({ color: "#67452F", roughness: 0.65 }));
  panel.userData = photoTag("board");
  const back = new Mesh(new PlaneGeometry(4, 2.6), new MeshStandardMaterial({ color: "#D9D4CC", roughness: 0.95 }));
  back.userData = photoTag("wall", "back");
  const left = new Mesh(new PlaneGeometry(3.5, 2.6), new MeshStandardMaterial({ color: "#8FA3B0", roughness: 0.95 }));
  left.userData = photoTag("wall", "left");
  const floor = new Mesh(new PlaneGeometry(4, 3.5), new MeshStandardMaterial({ color: "#B79D7C", roughness: 0.9 }));
  floor.userData = photoTag("floor");
  root.add(panel, back, left, floor);
  return { root, materials, back, floor };
}

/** Role of the material of every triangle in the path tracer's merged geometry. */
function triangleRoles(scene: Object3D) {
  const generator = new PathTracingSceneGenerator(scene);
  const result = generator.generate();
  const { geometry } = result;
  const materials = result.materials as MeshPhysicalMaterial[];
  const materialIndex = geometry.getAttribute("materialIndex");
  const triangles = geometry.index!;
  const roles: string[] = [];
  for (let t = 0; t < triangles.count; t += 3) {
    // All three corners of a triangle must carry the same material.
    const [a, b, c] = [0, 1, 2].map((k) => materialIndex.getX(triangles.getX(t + k)));
    expect(a === b && b === c).toBe(true);
    roles.push(String(materials[a].userData.role));
  }
  return { roles, materials };
}

describe("path tracer scene: room and furniture materials stay separate", () => {
  it("indexes every triangle with its own mesh's material", async () => {
    const { root } = await liveScene();
    const snapshot = takeSnapshot(root);
    const scene = buildPhotoScene(snapshot, [], null);
    const { roles, materials } = triangleRoles(scene);
    // Expected per-role triangle counts, straight from the snapshot meshes.
    const expected = new Map<string, number>();
    for (const item of snapshot.items) {
      const tris = (item.geometry.index?.count ?? item.geometry.getAttribute("position").count) / 3;
      expected.set(item.tag.role, (expected.get(item.tag.role) ?? 0) + tris);
    }
    const actual = new Map<string, number>();
    for (const r of roles) actual.set(r, (actual.get(r) ?? 0) + 1);
    expect(Object.fromEntries([...actual].sort())).toEqual(Object.fromEntries([...expected].sort()));
    // Walls and floor: their own colours, no texture, matt paint; never a furniture material.
    const room = materials.filter((m) => m.userData.role === "wall" || m.userData.role === "floor");
    expect(room.map((m) => `#${m.color.getHexString()}`).sort()).toEqual(["#8fa3b0", "#b79d7c", "#d9d4cc"].sort());
    for (const m of room) {
      expect(m.map).toBeNull();
      expect(m.normalMap ?? null).toBeNull();
      expect(m.roughnessMap ?? null).toBeNull();
      expect(m.roughness).toBeGreaterThanOrEqual(0.7);
    }
    // Furniture keeps its decor.
    expect(materials.filter((m) => m.userData.role === "board" && m.map !== null).length).toBeGreaterThan(0);
    snapshot.dispose();
  });

  it("changing a furniture decor never changes the walls or the floor", async () => {
    const { root, materials, back, floor } = await liveScene();
    const before = takeSnapshot(root);
    const wallColor = (s: ReturnType<typeof takeSnapshot>, role: string) =>
      s.items.filter((i) => i.tag.role === role).map((i) => [i.material.color.getHexString(), i.material.map]);
    const walls = wallColor(before, "wall");
    const floors = wallColor(before, "floor");
    // The customer picks another decor and colour for the bed.
    const other = new Texture();
    materials.get("front")!.map = other;
    materials.get("body")!.color.set("#222222");
    const after = takeSnapshot(root);
    expect(wallColor(after, "wall")).toEqual(walls);
    expect(wallColor(after, "floor")).toEqual(floors);
    expect(after.items.some((i) => i.tag.role === "board" && i.material.map === other)).toBe(true);
    // The live room materials were never touched by either snapshot.
    expect((back.material as MeshStandardMaterial).map).toBeNull();
    expect((floor.material as MeshStandardMaterial).color.getHexString()).toBe("b79d7c");
    before.dispose();
    after.dispose();
  });
});
