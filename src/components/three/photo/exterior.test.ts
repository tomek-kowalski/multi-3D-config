import { Box3, BoxGeometry, Mesh, MeshStandardMaterial, PerspectiveCamera, PlaneGeometry, Quaternion, Raycaster, Scene, Vector2, Vector3 } from "three";
import { describe, expect, it } from "vitest";
import { knobProfile } from "../HandleMesh";
import { floorUv, writeFloorMetreUvs, writeRoomFloorUvs } from "../materials/physicalUv";
import { addWindowExteriors, EXTERIOR, exteriorPixels, windowApertures } from "./exterior";

/** A wall at z = 0 (room towards +z) with a 1.2 × 1.4 m window pane whose centre is at (2, 1.6, 0). */
function room(): { scene: Scene; wall: Mesh; glass: Mesh } {
  const scene = new Scene();
  // As buildPhotoScene creates them: the world transform in `matrix`, matrixAutoUpdate off, identity TRS.
  const glass = new Mesh(new BoxGeometry(1, 1, 1), new MeshStandardMaterial());
  glass.matrixAutoUpdate = false;
  glass.matrix.compose(new Vector3(2, 1.6, 0), new Quaternion(), new Vector3(1.2, 1.4, 0.006));
  glass.userData.photo = { role: "glass", wall: "back" };
  scene.add(glass);
  // Wall plane with the window hole approximated by four quads around it.
  const wall = new Mesh(new PlaneGeometry(1, 1), new MeshStandardMaterial());
  wall.userData.photo = { role: "wall", wall: "back" };
  return { scene, wall, glass };
}

function camera(x: number, y: number, z: number) {
  const c = new PerspectiveCamera(40, 16 / 9, 0.05, 200);
  c.position.set(x, y, z);
  c.lookAt(2, 1.4, 0);
  c.updateMatrixWorld();
  return c;
}

describe("window exterior (photos)", () => {
  it("adds one panel per visible window, far behind the glazing, only with a camera", () => {
    const { scene } = room();
    expect(addWindowExteriors(new Scene(), camera(2, 1.5, 4))).toHaveLength(0);
    const before = scene.children[0].matrix.clone();
    const panels = addWindowExteriors(scene, camera(2.5, 1.5, 4));
    expect(panels).toHaveLength(1);
    // The glazing itself is left exactly where the photo scene placed it.
    expect(scene.children[0].matrix.equals(before)).toBe(true);
    const box = new Box3().setFromObject(panels[0]);
    expect(box.min.z).toBeCloseTo(-EXTERIOR.distanceM, 3);
    expect(box.max.z).toBeCloseTo(-EXTERIOR.distanceM, 3);
    // Inside a closer far plane (the rasterizer clips beyond it): nearer, never beyond 60 % of far.
    const near = camera(2.5, 1.5, 4);
    near.far = 20;
    const [closer] = addWindowExteriors(room().scene, near);
    const z = new Box3().setFromObject(closer).min.z;
    expect(z).toBeGreaterThan(-20 * 0.6);
    expect(z).toBeLessThanOrEqual(-EXTERIOR.minDistanceM);
    expect(panels[0].userData.photo).toEqual({ role: "exterior" });
    expect(panels[0].castShadow).toBe(false);
  });

  it("is exactly what the camera sees through the window: every panel point lies on a ray through the aperture", () => {
    for (const eye of [new Vector3(2, 1.5, 4), new Vector3(0.3, 2.4, 3), new Vector3(4, 0.8, 1.5)]) {
      const { scene } = room();
      const [panel] = addWindowExteriors(scene, camera(eye.x, eye.y, eye.z));
      const pos = panel.geometry.getAttribute("position");
      const margin = 1 + EXTERIOR.margin * 2 + 1e-6;
      for (let i = 0; i < pos.count; i++) {
        const p = new Vector3().fromBufferAttribute(pos, i);
        // Where the ray eye → panel corner crosses the window plane (z = 0).
        const t = eye.z / (eye.z - p.z);
        const q = eye.clone().lerp(p, t);
        // (+1 cm: the pane's own 6 mm thickness enlarges its projected outline slightly.)
        expect(Math.abs(q.x - 2)).toBeLessThanOrEqual((1.2 / 2) * margin + 0.01);
        expect(Math.abs(q.y - 1.6)).toBeLessThanOrEqual((1.4 / 2) * margin + 0.01);
      }
      // And a ray through the window centre hits the panel.
      const ray = new Raycaster(eye, new Vector3(2, 1.6, 0).sub(eye).normalize());
      expect(ray.intersectObject(panel).length).toBe(1);
    }
  });

  it("groups the panes of one window; separate windows get separate, non-coplanar panels", () => {
    const scene = new Scene();
    for (const [x, name] of [
      [1.7, "a"],
      [2.3, "b"],
      [5, "c"],
    ] as const) {
      const pane = new Mesh(new BoxGeometry(1, 1, 1));
      pane.matrixAutoUpdate = false;
      pane.matrix.compose(new Vector3(x, 1.6, 0), new Quaternion(), new Vector3(0.58, 1.3, 0.006));
      pane.name = name;
      pane.userData.photo = { role: "glass" };
      scene.add(pane);
    }
    const eye = new Vector3(3, 1.5, 4);
    expect(windowApertures(scene, eye)).toHaveLength(2);
    const panels = addWindowExteriors(scene, camera(3, 1.5, 4));
    expect(panels).toHaveLength(2);
    const z = panels.map((p) => new Box3().setFromObject(p).min.z);
    expect(Math.abs(z[0] - z[1])).toBeGreaterThan(0.1);
  });

  it("is a deterministic, seamless daytime image: sky above the horizon, ground below, low saturation", () => {
    const started = performance.now();
    const a = exteriorPixels();
    console.info(`exterior image generated in ${(performance.now() - started).toFixed(0)} ms (node)`);
    const b = exteriorPixels();
    const checksum = (d: Uint8Array) => d.reduce((h, v, i) => (h * 31 + v * (i % 7 + 1)) >>> 0, 7);
    expect(checksum(a)).toBe(checksum(b));
    const W = 1024;
    const H = 512;
    const px = (x: number, y: number) => [a[(y * W + x) * 4], a[(y * W + x) * 4 + 1], a[(y * W + x) * 4 + 2]];
    const mean = (y0: number, y1: number) => {
      const s = [0, 0, 0];
      let n = 0;
      for (let y = y0; y < y1; y++) {
        for (let x = 0; x < W; x += 4) {
          px(x, y).forEach((v, i) => (s[i] += v));
          n++;
        }
      }
      return s.map((v) => v / n);
    };
    const sky = mean(Math.round(H * 0.8), H);
    const ground = mean(0, Math.round(H * 0.3));
    expect(sky[2]).toBeGreaterThan(sky[0]); // blue sky
    expect(ground[1]).toBeGreaterThan(ground[2]); // green/straw ground
    // No strong blue cast: the sky's blue is within ~1.7× its red even at the zenith.
    expect(sky[2] / sky[0]).toBeLessThan(1.8);
    // Horizontal repeat is seamless (first and last columns agree closely).
    let diff = 0;
    for (let y = 0; y < H; y++) for (let c = 0; c < 3; c++) diff += Math.abs(px(0, y)[c] - px(W - 1, y)[c]);
    expect(diff / (H * 3)).toBeLessThan(6);
  });
});

describe("hardware and door realism", () => {
  it("the turned knob keeps the catalog's diameter and projection exactly", () => {
    const profile = knobProfile(32, 28);
    expect(Math.max(...profile.map((p) => p.x)) * 2).toBe(32);
    expect(Math.max(...profile.map((p) => p.y))).toBe(28);
    expect(Math.min(...profile.map((p) => p.y))).toBe(0);
    // Neck as before (half the diameter), domed face closing on the axis.
    expect(profile[0]).toEqual(new Vector2(8, 0));
    expect(profile[profile.length - 1]).toEqual(new Vector2(0, 28));
  });

  it("the doorway floor continues the room floor's UVs without a seam, for both plank axes", () => {
    for (const axis of ["x", "z"] as const) {
      const floor = new PlaneGeometry(4, 3, 4, 3);
      writeFloorMetreUvs(floor, 4, 3, axis);
      // A floor vertex on the back wall line (room z = 0) at room x = 1.
      const pos = floor.getAttribute("position");
      const uv = floor.getAttribute("uv");
      let found = false;
      for (let i = 0; i < pos.count; i++) {
        const x = pos.getX(i) + 2;
        const z = 1.5 - pos.getY(i);
        if (Math.abs(x - 1) < 1e-9 && Math.abs(z) < 1e-9) {
          expect([uv.getX(i), uv.getY(i)]).toEqual(floorUv(1, 0, axis));
          found = true;
        }
      }
      expect(found).toBe(true);
      const doorway = new PlaneGeometry(1, 1);
      doorway.setAttribute("position", new (pos.constructor as typeof import("three").BufferAttribute)(new Float32Array([1, 0, 0, 1.9, 0, 0, 1.9, 0, -0.048, 1, 0, -0.048]), 3));
      writeRoomFloorUvs(doorway, axis);
      const d = doorway.getAttribute("uv");
      expect([d.getX(0), d.getY(0)]).toEqual(floorUv(1, 0, axis));
    }
  });
});
