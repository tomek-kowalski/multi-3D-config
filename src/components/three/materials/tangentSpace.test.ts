import { BoxGeometry, BufferGeometry, CylinderGeometry, PlaneGeometry, Vector2, Vector3 } from "three";
import { describe, expect, it } from "vitest";
import { maxMetricUvError, partMapping, unitBoxWithMetreUvs, writeBoxMetreUvs, writeCylinderMetreUvs, writeFloorMetreUvs } from "./physicalUv";

/**
 * Tangent-space normal maps must bend the surface the same way in every pipeline. For each triangle we
 * compare, against the analytic UV gradients (dP/du, dP/dv):
 * - raster without tangent attributes: three r186 getTangentFrame() (normalmap_pars_fragment), here with
 *   two triangle edges standing in for the screen derivatives;
 * - path tracer: BufferGeometry.computeTangents() + bitangent = cross(n, t) * w
 *   (three-gpu-pathtracer get_surface_record_function).
 * A synthetic tangent-space sample (+X, +Y) must map to +dP/du and +dP/dv in both, on mirrored faces too.
 */

interface Frame {
  t: Vector3;
  b: Vector3;
  n: Vector3;
}

function triangles(g: BufferGeometry) {
  const index = g.index!;
  const out: number[][] = [];
  for (let i = 0; i < index.count; i += 3) out.push([index.getX(i), index.getX(i + 1), index.getX(i + 2)]);
  return out;
}

function vertex(g: BufferGeometry, i: number) {
  const p = g.getAttribute("position");
  const uv = g.getAttribute("uv");
  const n = g.getAttribute("normal");
  return { p: new Vector3(p.getX(i), p.getY(i), p.getZ(i)), uv: new Vector2(uv.getX(i), uv.getY(i)), n: new Vector3(n.getX(i), n.getY(i), n.getZ(i)) };
}

/** Analytic dP/du, dP/dv of a triangle (null when the UVs are degenerate). */
function gradients(a: ReturnType<typeof vertex>, b: ReturnType<typeof vertex>, c: ReturnType<typeof vertex>) {
  const e1 = b.p.clone().sub(a.p);
  const e2 = c.p.clone().sub(a.p);
  const d1 = b.uv.clone().sub(a.uv);
  const d2 = c.uv.clone().sub(a.uv);
  const det = d1.x * d2.y - d2.x * d1.y;
  if (Math.abs(det) < 1e-12) return null;
  const dPdu = e1.clone().multiplyScalar(d2.y).sub(e2.clone().multiplyScalar(d1.y)).divideScalar(det);
  const dPdv = e2.clone().multiplyScalar(d1.x).sub(e1.clone().multiplyScalar(d2.x)).divideScalar(det);
  return { dPdu, dPdv };
}

/** three's getTangentFrame with q0/q1 = two edges ordered counter-clockwise around the normal. */
function rasterFrame(a: ReturnType<typeof vertex>, b: ReturnType<typeof vertex>, c: ReturnType<typeof vertex>, n: Vector3): Frame {
  let q0 = b.p.clone().sub(a.p);
  let q1 = c.p.clone().sub(a.p);
  let st0 = b.uv.clone().sub(a.uv);
  let st1 = c.uv.clone().sub(a.uv);
  if (q0.clone().cross(q1).dot(n) < 0) [q0, q1, st0, st1] = [q1, q0, st1, st0];
  const q1perp = q1.clone().cross(n);
  const q0perp = n.clone().cross(q0);
  const t = q1perp.clone().multiplyScalar(st0.x).add(q0perp.clone().multiplyScalar(st1.x));
  const bt = q1perp.clone().multiplyScalar(st0.y).add(q0perp.clone().multiplyScalar(st1.y));
  return { t: t.normalize(), b: bt.normalize(), n };
}

function tracerFrame(g: BufferGeometry, i: number): Frame {
  const t4 = g.getAttribute("tangent");
  const n = vertex(g, i).n;
  const t = new Vector3(t4.getX(i), t4.getY(i), t4.getZ(i)).normalize();
  const b = n.clone().cross(t).multiplyScalar(t4.getW(i)).normalize();
  return { t, b, n };
}

/** Checks both frames on every triangle; returns how many faces were mirrored (w < 0). */
function expectParity(g: BufferGeometry, minAlignment = 0.99): number {
  g.computeTangents();
  let mirrored = 0;
  for (const [i, j, k] of triangles(g)) {
    const a = vertex(g, i);
    const b = vertex(g, j);
    const c = vertex(g, k);
    const grad = gradients(a, b, c);
    if (!grad) continue;
    const n = b.p.clone().sub(a.p).cross(c.p.clone().sub(a.p)).normalize();
    if (n.dot(a.n) < 0) n.negate();
    const raster = rasterFrame(a, b, c, n);
    const tracer = tracerFrame(g, i);
    for (const frame of [raster, tracer]) {
      // Orientation and handedness: +X runs with +u and +Y with +v in both pipelines (a mirrored or
      // flipped frame would give a negative dot product).
      expect(frame.t.dot(grad.dPdu.clone().normalize())).toBeGreaterThan(Math.min(minAlignment, 0.5));
      expect(frame.b.dot(grad.dPdv.clone().normalize())).toBeGreaterThan(Math.min(minAlignment, 0.5));
    }
    // Flat parts (default tolerance): the raster frame is exact.
    if (minAlignment >= 0.99) expect(raster.t.dot(grad.dPdu.clone().normalize())).toBeGreaterThan(0.999);
    // The perturbed normal of a +X/+Y tilted sample is the same in both pipelines.
    const sample = new Vector3(0.3, 0.2, 0.93).normalize();
    const world = (f: Frame) => f.t.clone().multiplyScalar(sample.x).add(f.b.clone().multiplyScalar(sample.y)).add(f.n.clone().multiplyScalar(sample.z)).normalize();
    expect(world(raster).dot(world(tracer))).toBeGreaterThan(minAlignment);
    if (g.getAttribute("tangent").getW(i) < 0) mirrored++;
  }
  return mirrored;
}

describe("tangent-space normal parity (M-03 / D-10)", () => {
  it("cabinet panels (unit box, metre UV0 along the grain): raster and tracer agree on every face, mirrored ones included", () => {
    for (const grain of ["x", "y", "z"] as const) {
      const mirrored = expectParity(unitBoxWithMetreUvs([0.45, 0.72, 0.019], grain, [0.1, 0.2]));
      expect(mirrored).toBeGreaterThan(0); // opposite faces share the u direction: handedness flips
    }
  });

  it("hardware boxes, cylinders (bar handles, knobs) and the floor", () => {
    const box = new BoxGeometry(0.14, 0.02, 0.001);
    writeBoxMetreUvs(box, [0.14, 0.02, 0.001], "x");
    expectParity(box);
    const bar = new CylinderGeometry(0.006, 0.006, 0.16, 16);
    writeCylinderMetreUvs(bar, 0.16);
    // Smooth per-vertex tangents vs. flat face gradients differ by at most half a segment (11.25°).
    expectParity(bar, Math.cos(Math.PI / 16) - 1e-3);
    const knob = new CylinderGeometry(0.016, 0.008, 0.028, 24);
    writeCylinderMetreUvs(knob, 0.028);
    // A tapered knob: smoothed per-vertex frames tilt with the cone as well.
    // (Before the mean-radius fix its UVs were sheared: up to 60° between frame and gradient.)
    expectParity(knob, Math.cos(Math.PI / 24) - 0.02);
    const floor = new PlaneGeometry(4, 3.5);
    writeFloorMetreUvs(floor, 4, 3.5);
    expectParity(floor);
  });

  it("generated hardware UVs are metric: |ΔUV| equals the physical length", () => {
    const box = new BoxGeometry(0.14, 0.02, 0.003);
    writeBoxMetreUvs(box, [0.14, 0.02, 0.003], "x");
    expect(maxMetricUvError(box)).toBeLessThan(1e-6);
    // Cylinder side: u along the axis is exact; v is the arc length at the vertex radius (the chord of a
    // 16-sided prism is shorter than its arc by < 1 %).
    const bar = new CylinderGeometry(0.006, 0.006, 0.16, 16, 1, true);
    writeCylinderMetreUvs(bar, 0.16);
    expect(maxMetricUvError(bar)).toBeLessThan(0.01);
  });

  it("records the mapping actually generated (no single u/v axis claimed for a box)", () => {
    expect(partMapping("box", "y", [0.1, 0.2])).toEqual({ kind: "part-metres", convention: "box", grainAxis: "y", phaseM: [0.1, 0.2] });
    expect(partMapping("cylinder", "y")).toEqual({ kind: "part-metres", convention: "cylinder", grainAxis: "y", phaseM: [0, 0] });
  });
});
