import { BufferAttribute, Box3, Vector3 } from "three";

/**
 * Box-projected UVs in metres for one furniture part (one OBJ object), used for the decor textures.
 *
 * Each triangle is projected onto the plane of its dominant normal. Within that plane, `u` runs along
 * the part's longer extent and `v` along the shorter one, so a texture whose grain runs along u
 * (decor swatches are normalized that way, see sample_decor_swatches.py) follows the long dimension of
 * every panel: horizontally on a wide front, vertically on a tall side panel.
 *
 * Returns the in-plane axis chosen as u for each normal axis ("x" | "y" | "z"), for inspection/tests.
 */
export function boxProjectUvs(geometry) {
  const pos = geometry.getAttribute("position");
  const size = new Box3().setFromBufferAttribute(pos).getSize(new Vector3());
  const extent = { x: size.x, y: size.y, z: size.z };
  // For each dominant normal axis, the two in-plane axes ordered [u, v]: longer extent first.
  const planes = {
    x: extent.z >= extent.y ? ["z", "y"] : ["y", "z"],
    y: extent.x >= extent.z ? ["x", "z"] : ["z", "x"],
    z: extent.x >= extent.y ? ["x", "y"] : ["y", "x"],
  };
  const uv = new Float32Array(pos.count * 2);
  const a = new Vector3();
  const b = new Vector3();
  const c = new Vector3();
  const n = new Vector3();
  const p = new Vector3();
  for (let i = 0; i + 2 < pos.count; i += 3) {
    a.fromBufferAttribute(pos, i);
    b.fromBufferAttribute(pos, i + 1);
    c.fromBufferAttribute(pos, i + 2);
    n.crossVectors(b.clone().sub(a), c.clone().sub(a));
    const ax = Math.abs(n.x);
    const ay = Math.abs(n.y);
    const az = Math.abs(n.z);
    const dominant = az >= ax && az >= ay ? "z" : ay >= ax ? "y" : "x";
    const [uAxis, vAxis] = planes[dominant];
    for (let k = 0; k < 3; k++) {
      p.fromBufferAttribute(pos, i + k);
      uv[(i + k) * 2] = p[uAxis];
      uv[(i + k) * 2 + 1] = p[vAxis];
    }
  }
  geometry.setAttribute("uv", new BufferAttribute(uv, 2));
  return planes;
}
