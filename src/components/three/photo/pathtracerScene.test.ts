import { readFileSync } from "node:fs";
import { join } from "node:path";
import { BoxGeometry, Group, Mesh, MeshPhysicalMaterial, MeshStandardMaterial, PlaneGeometry, type Object3D } from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { PathTracingSceneGenerator } from "three-gpu-pathtracer";
import { describe, expect, it } from "vitest";
import { getBedModel } from "@/domain/beds/catalog";
import { materialRegistry } from "@/domain/materials";
import { PHOTO_CAPABILITIES, VIEWPORT_CONSTRAINED } from "../materials/materialQuality";
import { createSourceCache, createTextureResources } from "../materials/textureResources";
import { applyBedMaterials, applyBedVisibility, BED_FIXED_BINDING, bedDecorBinding, prepareBedScene } from "../modules/BedModel";

/** Decoded decor images stand-in (node has no image decoder): sized like the HD swatches. */
const fakeImages = createSourceCache(async () => ({ width: 406, height: 370 }));
import { buildPhotoScene, takeSnapshot } from "./photoScene";
import { photoTag } from "./tags";

async function loadBed(): Promise<Object3D> {
  const buffer = readFileSync(join(__dirname, "../../../../public/models/clickbed", getBedModel("clickbed-o", "140x200")!.file));
  return (await new GLTFLoader().parseAsync(buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength), "")).scene;
}

/** A live scene like the app's: a bed with a wood decor, a cabinet panel, two walls and the floor. */
async function liveScene() {
  const root = new Group();
  const { root: bed, sources } = prepareBedScene(await loadBed());
  applyBedVisibility(bed, "unfolded", true);
  // The bed's materials come from the shared factory, as in the app (bound slots, real decor entry).
  const runtime = {
    registry: materialRegistry,
    capabilities: { ...PHOTO_CAPABILITIES, mode: "viewport" as const, supportsTransmission: false },
    quality: VIEWPORT_CONSTRAINED,
    textures: createTextureResources({ sources: fakeImages }),
  };
  const decorSet = applyBedMaterials(bed, sources, bedDecorBinding(4000, { decorCategory: "standard", frontDecor: "K001-PW", bodyDecor: "K001-PW" }), runtime);
  applyBedMaterials(bed, sources, BED_FIXED_BINDING, runtime);
  await decorSet.ready;
  const redecorate = (decorId: string) => applyBedMaterials(bed, sources, bedDecorBinding(4000, { decorCategory: "standard", frontDecor: decorId, bodyDecor: decorId }), runtime);
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
  return { root, redecorate, back, floor };
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
    const snapshot = takeSnapshot(root, { textures: createTextureResources({ sources: fakeImages }) });
    await snapshot.ready;
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
    const { root, redecorate, back, floor } = await liveScene();
    const scope = () => ({ textures: createTextureResources({ sources: fakeImages }) });
    const before = takeSnapshot(root, scope());
    await before.ready;
    const wallColor = (s: ReturnType<typeof takeSnapshot>, role: string) =>
      s.items.filter((i) => i.tag.role === role).map((i) => [i.material.color.getHexString(), i.material.map]);
    const walls = wallColor(before, "wall");
    const floors = wallColor(before, "floor");
    const boardImages = (s: ReturnType<typeof takeSnapshot>) => new Set(s.items.filter((i) => i.tag.role === "board" && i.material.map).map((i) => i.material.map!.name));
    // The customer picks another decor for the bed.
    redecorate("K005-PW");
    const after = takeSnapshot(root, scope());
    await after.ready;
    expect(wallColor(after, "wall")).toEqual(walls);
    expect(wallColor(after, "floor")).toEqual(floors);
    expect([...boardImages(before)]).toEqual(["decor:K001-PW.jpg"]);
    expect([...boardImages(after)]).toEqual(["decor:K005-PW.jpg"]);
    // The live room materials were never touched by either snapshot.
    expect((back.material as MeshStandardMaterial).map).toBeNull();
    expect((floor.material as MeshStandardMaterial).color.getHexString()).toBe("b79d7c");
    before.dispose();
    after.dispose();
  });
});
