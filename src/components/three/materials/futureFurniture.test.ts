import { DataTexture, MeshPhysicalMaterial, Scene } from "three";
import { PathTracingSceneGenerator } from "three-gpu-pathtracer";
import { describe, expect, it } from "vitest";
import { isFurnitureTypeId, listFurnitureTypes } from "@/domain/modules/registry";
import { buildPhotoScene, takeSnapshot } from "../photo/photoScene";
import { buildFixture, FIXTURE_TYPE_ID, fixtureRegistry } from "./futureFurniture.fixture";
import { PHOTO_CAPABILITIES, VIEWPORT_CONSTRAINED } from "./materialQuality";
import { createSourceCache, createTextureResources } from "./textureResources";

const textures = () => createTextureResources({ sources: createSourceCache(async () => ({ width: 8, height: 8 })) });

describe("future furniture acceptance fixture (not in the production catalog)", () => {
  it("is not part of the production furniture catalog", () => {
    expect(isFurnitureTypeId(FIXTURE_TYPE_ID)).toBe(false);
    expect(listFurnitureTypes().some((t) => t.id === FIXTURE_TYPE_ID)).toBe(false);
  });

  it("renders in the viewport through the shared slot API: registered, new-category and authored materials", async () => {
    const registry = fixtureRegistry();
    const runtime = { registry, capabilities: { ...PHOTO_CAPABILITIES, mode: "viewport" as const, supportsTransmission: false }, quality: VIEWPORT_CONSTRAINED, textures: textures() };
    const { root, sets } = buildFixture(runtime);
    await Promise.all(sets.map((s) => s.ready));
    const byName = Object.fromEntries(root.children.map((m) => [m.name, m as unknown as { material: MeshPhysicalMaterial | MeshPhysicalMaterial[] }]));
    // Seat: one mesh, two slots on six geometry groups.
    const seat = byName.seat.material as MeshPhysicalMaterial[];
    expect(seat).toHaveLength(6);
    expect(new Set(seat.map((m) => m.color.getHexString())).size).toBe(2);
    // Upholstery: textile profile (sheen) on a registered colour.
    expect(seat[2].sheen).toBeGreaterThan(0);
    // Leather: a category no current product uses, defined as data only.
    expect((byName.backrest.material as MeshPhysicalMaterial).roughness).toBe(0.55);
    // Existing hardware finish and glass proxy.
    expect((byName.frame.material as MeshPhysicalMaterial).metalness).toBe(1);
    expect((byName["table-top"].material as MeshPhysicalMaterial).transparent).toBe(true);
    // Authored shell: embedded textures kept, finish overridden.
    const shell = byName.shell.material as MeshPhysicalMaterial;
    expect(shell.map).toBeInstanceOf(DataTexture);
    expect(shell.normalMap).toBeInstanceOf(DataTexture);
    expect(shell.roughness).toBe(0.55);
    expect(sets.flatMap((s) => s.issues())).toEqual(["transmission-fallback"]);
  });

  it("renders in both photo backends' snapshot and in the path tracer, without any fixture-specific renderer code", async () => {
    const registry = fixtureRegistry();
    const runtime = { registry, capabilities: { ...PHOTO_CAPABILITIES, mode: "viewport" as const, supportsTransmission: false }, quality: VIEWPORT_CONSTRAINED, textures: textures() };
    const { root } = buildFixture(runtime);
    const scene = new Scene();
    scene.add(root);
    const snapshot = takeSnapshot(scene, { registry, textures: textures() });
    await snapshot.ready;
    // Four single-material parts + the seat's six geometry groups.
    expect(snapshot.items).toHaveLength(10);
    expect(snapshot.items.filter((i) => i.name.startsWith("seat#")).map((i) => i.group?.materialIndex)).toEqual([0, 1, 2, 3, 4, 5]);
    const glass = snapshot.items.find((i) => i.name === "table-top")!.material;
    expect(glass).toMatchObject({ transmission: 1, transparent: false }); // real glass in the photo
    const shell = snapshot.items.find((i) => i.name === "shell")!.material;
    expect(shell.map).toBeInstanceOf(DataTexture);
    expect(shell.normalMap).toBeInstanceOf(DataTexture);
    const photo = buildPhotoScene(snapshot, [], null);
    const generated = new PathTracingSceneGenerator(photo).generate();
    const materials = generated.materials as MeshPhysicalMaterial[];
    // Every distinct fixture appearance reaches the tracer (upholstery, leather ×2 users, steel, glass, shell).
    expect(new Set(materials.map((m) => m.color.getHexString())).size).toBeGreaterThanOrEqual(5);
    expect(snapshot.diagnostics()).toEqual({ unavailable: [], failed: [] });
    snapshot.dispose();
  });
});
