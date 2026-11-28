import { PlaneGeometry } from "three";
import { describe, expect, it } from "vitest";
import { buildFurniture } from "@/domain/geometry/buildFurniture";
import { DEFAULT_CABINET } from "@/domain/furniture/defaults";
import { PANEL_GRAIN } from "../PanelMesh";
import { faceUAxis, maxMetricUvError, patternOffsetM, unitBoxWithMetreUvs, writeFloorMetreUvs, type SizeM } from "./physicalUv";

/** UV of the vertex of a unit box nearest to (x, y, z) on the face with the given normal. */
function uvAt(size: SizeM, grain: "x" | "y" | "z", normal: [number, number, number], corner: [number, number, number]) {
  const g = unitBoxWithMetreUvs(size, grain);
  const pos = g.getAttribute("position");
  const nrm = g.getAttribute("normal");
  const uv = g.getAttribute("uv");
  for (let i = 0; i < pos.count; i++) {
    if (nrm.getX(i) === normal[0] && nrm.getY(i) === normal[1] && nrm.getZ(i) === normal[2] && pos.getX(i) === corner[0] && pos.getY(i) === corner[1] && pos.getZ(i) === corner[2]) {
      return [uv.getX(i), uv.getY(i)];
    }
  }
  throw new Error("vertex not found");
}

describe("physical UV0", () => {
  it("is metric on every face of a scaled panel: |ΔUV| equals the physical length", () => {
    for (const size of [
      [0.018, 1.8, 0.5],
      [0.8, 0.018, 0.5],
      [0.45, 0.7, 0.019],
      [2.4, 0.08, 0.018],
    ] as SizeM[]) {
      expect(maxMetricUvError(unitBoxWithMetreUvs(size, "y"), size)).toBeLessThan(1e-6);
      expect(maxMetricUvError(unitBoxWithMetreUvs(size, "x"), size)).toBeLessThan(1e-6);
    }
  });

  it("keeps the grain direction when a door's width crosses its height (no aspect heuristic)", () => {
    // Front face (normal +z) of a tall and of a wide door: u always runs along y (vertical grain).
    for (const size of [
      [0.45, 1.2, 0.019],
      [1.2, 0.45, 0.019],
    ] as SizeM[]) {
      const bottom = uvAt(size, "y", [0, 0, 1], [-0.5, -0.5, 0.5]);
      const top = uvAt(size, "y", [0, 0, 1], [-0.5, 0.5, 0.5]);
      expect(top[0] - bottom[0]).toBeCloseTo(size[1], 6); // u grows with height
      expect(top[1] - bottom[1]).toBeCloseTo(0, 6);
    }
  });

  it("resizing changes the UV extent, not the texture's physical size (stable derivative)", () => {
    const small = uvAt([0.4, 0.6, 0.018], "y", [0, 0, 1], [-0.5, 0.5, 0.5]);
    const large = uvAt([0.4, 1.8, 0.018], "y", [0, 0, 1], [-0.5, 0.5, 0.5]);
    // The lower-left origin is fixed, so the top edge's u is the height in metres in both sizes.
    expect(small[0]).toBeCloseTo(0.6, 6);
    expect(large[0]).toBeCloseTo(1.8, 6);
  });

  it("edges run along their length (as edge banding), shelves and drawer fronts horizontally, sides vertically", () => {
    expect(faceUAxis("y", "y", [0.018, 1.8, 0.5])).toBe("z"); // top edge of a side panel: along the depth
    expect(faceUAxis("z", "y", [0.018, 1.8, 0.5])).toBe("y"); // front edge of a side panel: along the height
    expect(PANEL_GRAIN["left-side"]).toBe("y");
    expect(PANEL_GRAIN.door).toBe("y");
    expect(PANEL_GRAIN.shelf).toBe("x");
    expect(PANEL_GRAIN["drawer-front"]).toBe("x");
    // Every panel type of the cabinet builder has a grain axis.
    for (const panel of buildFurniture({ ...DEFAULT_CABINET }).panels) expect(PANEL_GRAIN[panel.type]).toBeDefined();
  });

  it("gives each part a stable pattern phase (same id → same offset, across rebuilds and resizes)", () => {
    expect(patternOffsetM("cabinet:left-side")).toEqual(patternOffsetM("cabinet:left-side"));
    expect(patternOffsetM("cabinet:left-side")).not.toEqual(patternOffsetM("cabinet:right-side"));
    for (const v of patternOffsetM("x")) expect(v).toBeGreaterThanOrEqual(0);
  });

  it("floor UVs are room-local metres from the fixed back-left corner (growing the room never moves the pattern)", () => {
    const small = new PlaneGeometry(4, 3.5);
    writeFloorMetreUvs(small, 4, 3.5);
    const large = new PlaneGeometry(6, 5);
    writeFloorMetreUvs(large, 6, 5);
    const corner = (g: PlaneGeometry) => {
      const uv = g.getAttribute("uv");
      const pos = g.getAttribute("position");
      // Vertex 0 of a PlaneGeometry is its (-w/2, +h/2) corner: the room's back-left corner after the floor rotation.
      return [pos.getX(0), pos.getY(0), uv.getX(0), uv.getY(0)];
    };
    expect(corner(small).slice(2)).toEqual([0, 0]);
    expect(corner(large).slice(2)).toEqual([0, 0]);
    expect(maxMetricUvError(small)).toBeLessThan(1e-6);
  });
});
