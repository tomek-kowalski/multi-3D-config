import { BoxGeometry, Mesh, MeshStandardMaterial } from "three";
import { describe, expect, it } from "vitest";
import { materialRegistry } from "@/domain/materials";
import { cabinetFinishSelection, hardwareFinishSelection } from "@/domain/materials/bindings";
import type { MeshMaterialBinding } from "@/domain/materials/contracts";
import { PHOTO_CAPABILITIES, VIEWPORT_CONSTRAINED } from "./materialQuality";
import { attachMaterialBinding, createSlotMaterials, detachMaterialBinding, installMaterials, InvalidBindingError, readMaterialBinding, validateBinding } from "./materialSlots";
import { createSourceCache, createTextureResources } from "./textureResources";

const runtime = () => ({
  registry: materialRegistry,
  capabilities: { ...PHOTO_CAPABILITIES, mode: "viewport" as const, supportsTransmission: false },
  quality: VIEWPORT_CONSTRAINED,
  textures: createTextureResources({ sources: createSourceCache(async () => ({ width: 8, height: 8 })) }),
});

/** A box whose six face groups are bound to two slots: faces and edge bands. */
const BANDED: MeshMaterialBinding = {
  slots: [
    { slotId: "face", selection: cabinetFinishSelection("walnut"), side: "front" },
    { slotId: "edge", selection: cabinetFinishSelection("black-matte"), side: "front" },
  ],
  groups: [
    { materialIndex: 0, slotId: "edge" },
    { materialIndex: 1, slotId: "edge" },
    { materialIndex: 2, slotId: "edge" },
    { materialIndex: 3, slotId: "edge" },
    { materialIndex: 4, slotId: "face" },
    { materialIndex: 5, slotId: "face" },
  ],
};

describe("material slots and geometry groups", () => {
  it("builds an ordered material array matching the geometry's group material indices", () => {
    const geometry = new BoxGeometry();
    expect(validateBinding(BANDED, geometry)).toEqual([]);
    const set = createSlotMaterials(BANDED, runtime());
    expect(set.materials).toHaveLength(6);
    const walnut = set.bySlot.get("face")!.material;
    const band = set.bySlot.get("edge")!.material;
    expect(set.materials.map((m) => (m === walnut ? "face" : m === band ? "edge" : "?"))).toEqual(["edge", "edge", "edge", "edge", "face", "face"]);
    const mesh = new Mesh(geometry, new MeshStandardMaterial());
    installMaterials(mesh, set, BANDED);
    expect(Array.isArray(mesh.material)).toBe(true);
    // Geometry groups are untouched (start, count, materialIndex).
    expect(geometry.groups.map((g) => g.materialIndex)).toEqual([0, 1, 2, 3, 4, 5]);
    set.dispose();
  });

  it("single-material meshes use slot 0 without groups", () => {
    const binding: MeshMaterialBinding = { slots: [{ slotId: "handle", selection: hardwareFinishSelection("chrome"), side: "front" }], groups: [] };
    const set = createSlotMaterials(binding, runtime());
    const mesh = new Mesh(new BoxGeometry(), new MeshStandardMaterial());
    installMaterials(mesh, set, binding);
    expect(mesh.material).toBe(set.bySlot.get("handle")!.material);
  });

  it("rejects invalid bindings in development instead of flattening to material 0", () => {
    expect(validateBinding({ slots: [], groups: [] })).toContain("no slots");
    const missing: MeshMaterialBinding = { slots: [BANDED.slots[0]], groups: [{ materialIndex: 0, slotId: "edge" }] };
    expect(validateBinding(missing)).toContain("group 0 uses missing slot edge");
    const gap: MeshMaterialBinding = { slots: BANDED.slots, groups: [{ materialIndex: 0, slotId: "face" }, { materialIndex: 2, slotId: "edge" }] };
    expect(validateBinding(gap)).toContain("material index 1 unbound");
    const tooFew: MeshMaterialBinding = { slots: BANDED.slots, groups: [{ materialIndex: 0, slotId: "face" }] };
    expect(validateBinding(tooFew, new BoxGeometry()).some((i) => i.includes("beyond"))).toBe(true);
    expect(() => createSlotMaterials(missing, runtime())).toThrow(InvalidBindingError);
    expect(() => createSlotMaterials({ slots: [{ slotId: "x", selection: { kind: "registered", id: "nope" }, side: "front" }], groups: [] }, runtime())).toThrow();
  });

  it("records the binding per mesh and survives userData replacement (R3F props)", () => {
    const mesh = new Mesh();
    const frozen = { binding: BANDED, authored: {} };
    attachMaterialBinding(mesh, frozen);
    mesh.userData = { photo: { role: "board" } };
    expect(readMaterialBinding(mesh)).toBe(frozen);
    detachMaterialBinding(mesh, { binding: BANDED, authored: {} }); // another binding: not removed
    expect(readMaterialBinding(mesh)).toBe(frozen);
    detachMaterialBinding(mesh, frozen);
    expect(readMaterialBinding(mesh)).toBeNull();
  });

  it("disposes every slot material and releases its leases", async () => {
    const r = runtime();
    const set = createSlotMaterials(BANDED, r);
    await set.ready;
    let disposed = 0;
    set.bySlot.forEach((i) => i.material.addEventListener("dispose", () => disposed++));
    set.dispose();
    expect(disposed).toBe(2);
    expect(r.textures.stats().activeLeases).toBe(0);
  });
});
