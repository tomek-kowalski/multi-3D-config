import { readFileSync } from "node:fs";
import { join } from "node:path";
import { BoxGeometry, Group, Mesh, MeshStandardMaterial, Vector3, type Object3D } from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { beforeAll, describe, expect, it } from "vitest";
import { addModule, setModuleState, setPlacement } from "@/domain/arrangement/operations";
import type { Arrangement } from "@/domain/arrangement/types";
import { getBedModel } from "@/domain/beds/catalog";
import type { BedConfiguration } from "@/domain/beds/bedType";
import { getFurnitureType } from "@/domain/modules/registry";
import type { ModuleInstance } from "@/domain/modules/types";
import { DEFAULT_ROOM } from "@/domain/room/defaults";
import { applyBedVisibility, prepareBedScene } from "../modules/BedModel";
import { boxCorners, planPhotoViews, projectNdc, type BoxM } from "./photoCamera";
import { takeSnapshot } from "./photoScene";
import { photoTag } from "./tags";

const models = new Map<string, Object3D>();
beforeAll(async () => {
  for (const typeId of ["clickbed-o", "clickbed-o-classico"]) {
    const buffer = readFileSync(join(__dirname, "../../../../public/models/clickbed", getBedModel(typeId, "140x200")!.file));
    const gltf = await new GLTFLoader().parseAsync(buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength), "");
    models.set(typeId, gltf.scene);
  }
});

/**
 * The live scene of an arrangement as ModuleObject draws it: each module positioned and rotated by its
 * placement, its geometry offset by half the footprint; beds from their real models in their current
 * state (with the mattress when selected), cabinets as their panel volumes.
 */
function sceneOf(arrangement: Arrangement, mattress = false): Group {
  const root = new Group();
  for (const m of arrangement.modules) {
    const type = getFurnitureType(m.typeId);
    const footprint = type.footprint(m.configuration);
    const outer = new Group();
    outer.position.set(m.placement.x / 1000, m.placement.y / 1000, m.placement.z / 1000);
    outer.rotation.y = (m.placement.rotationDeg * Math.PI) / 180;
    const inner = new Group();
    inner.position.set(-footprint.width / 2000, 0, -footprint.depth / 2000);
    outer.add(inner);
    if (m.typeId.startsWith("clickbed")) {
      const model = models.get(m.typeId)!;
      const { root: bed } = prepareBedScene(model);
      applyBedVisibility(bed, m.state, mattress);
      inner.add(bed);
    } else {
      for (const b of type.collisionBoxes(m.configuration, m.state)) {
        const mesh = new Mesh(new BoxGeometry(), new MeshStandardMaterial());
        mesh.userData = photoTag("board");
        mesh.scale.set(b.dimensions.width / 1000, b.dimensions.height / 1000, b.dimensions.depth / 1000);
        mesh.position.set((b.position.x + b.dimensions.width / 2) / 1000, (b.position.y + b.dimensions.height / 2) / 1000, (b.position.z + b.dimensions.depth / 2) / 1000);
        inner.add(mesh);
      }
    }
    root.add(outer);
  }
  return root;
}

function build(types: string[], edit: (a: Arrangement) => Arrangement = (a) => a): Arrangement {
  let a: Arrangement = { room: DEFAULT_ROOM, modules: [] };
  for (const t of types) {
    const r = addModule(a, t);
    if (!r.ok) throw new Error(JSON.stringify(r.issues));
    a = r.value.arrangement;
  }
  return edit(a);
}

const unwrap = (r: { ok: true; value: { arrangement: Arrangement } } | { ok: false; issues: readonly unknown[] }) => {
  if (!r.ok) throw new Error(JSON.stringify(r.issues));
  return r.value.arrangement;
};

/** Every drawn furniture vertex (via its exact world box) is inside every view's frame, with the margin. */
function expectFullyFramed(arrangement: Arrangement, mattress = false) {
  const snapshot = takeSnapshot(sceneOf(arrangement, mattress));
  const fb = snapshot.furnitureBounds;
  expect(fb.isEmpty()).toBe(false);
  const drawn: BoxM = { min: fb.min.toArray() as [number, number, number], max: fb.max.toArray() as [number, number, number] };
  const margin = 0.1;
  for (const view of planPhotoViews(arrangement, 3, 16 / 9, { drawn, margin })) {
    let extent = 0;
    for (const corner of boxCorners(drawn)) {
      const ndc = projectNdc(view.camera, corner);
      extent = Math.max(extent, Math.abs(ndc.x), Math.abs(ndc.y));
      expect(ndc.z).toBeGreaterThan(-1);
      expect(ndc.z).toBeLessThan(1);
    }
    // Inside the frame, with free space at the border (projection of the box corners: ≤ 1 − margin + rounding).
    expect(extent).toBeLessThanOrEqual(1 - margin + 1e-6);
    // The camera is in front of everything it frames (never inside the furniture).
    expect(fb.containsPoint(new Vector3(...view.camera.position))).toBe(false);
  }
  snapshot.dispose();
  return drawn;
}

describe("photo framing covers the complete drawn arrangement", () => {
  it("one cabinet", () => expectFullyFramed(build(["cabinet"])));
  it("several cabinets", () => expectFullyFramed(build(["cabinet", "cabinet", "cabinet"])));
  it("a transforming bed, folded and unfolded", () => {
    const folded = build(["clickbed-o"]);
    const closed = expectFullyFramed(folded);
    const open = expectFullyFramed(unwrap(setModuleState(folded, folded.modules[0].id, "unfolded")));
    // The unfolded bed reaches far into the room: the framed volume grows with it.
    expect(open.max[2] - open.min[2]).toBeGreaterThan(closed.max[2] - closed.min[2] + 1);
  });
  it("a bed with the mattress selected", () => {
    const a = build(["clickbed-o"]);
    const unfolded = unwrap(setModuleState(a, a.modules[0].id, "unfolded"));
    const withMattress = expectFullyFramed(unfolded, true);
    const without = expectFullyFramed(unfolded, false);
    expect(withMattress.max[1]).toBeGreaterThanOrEqual(without.max[1]);
  });
  it("a bed and cabinets together", () => expectFullyFramed(build(["clickbed-o-classico", "cabinet", "cabinet"])));
  it("furniture along opposite walls", () =>
    expectFullyFramed(
      build(["cabinet", "cabinet"], (a) => {
        const second = a.modules[1] as ModuleInstance;
        return unwrap(setPlacement(a, second.id, { x: 2000, z: DEFAULT_ROOM.depth - 250, rotationDeg: 180 }));
      }),
    ));
  it("rotated furniture", () =>
    expectFullyFramed(
      build(["clickbed-o", "cabinet"], (a) => unwrap(setPlacement(a, a.modules[1].id, { x: 3700, z: 1500, rotationDeg: 270 }))),
    ));
  it("uses the drawn geometry when a model reaches beyond its collision boxes", () => {
    const a = build(["clickbed-o"]);
    const config = a.modules[0].configuration as BedConfiguration;
    expect(config.mattress).toBe(false);
    const subjectOnly = planPhotoViews(a, 1, 16 / 9)[0].camera;
    const sticking: BoxM = { min: [-0.5, 0, 0], max: [3, 2.6, 1] };
    const withDrawn = planPhotoViews(a, 1, 16 / 9, { drawn: sticking })[0].camera;
    for (const corner of boxCorners(sticking)) {
      const ndc = projectNdc(withDrawn, corner);
      expect(Math.max(Math.abs(ndc.x), Math.abs(ndc.y))).toBeLessThanOrEqual(1);
    }
    expect(withDrawn).not.toEqual(subjectOnly);
  });
});
