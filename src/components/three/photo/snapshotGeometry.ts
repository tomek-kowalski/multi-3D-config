import { BufferAttribute, BufferGeometry, Vector3, type InterleavedBufferAttribute, type Material, type Mesh } from "three";

/**
 * What the live renderer actually draws of a mesh, so a photo copies exactly that (three r186
 * WebGLRenderer rules):
 * - the geometry's drawRange limits every draw;
 * - a single material draws the whole (draw-ranged) geometry and ignores groups;
 * - a material array draws each group with materials[group.materialIndex] — and nothing at all when the
 *   geometry has no groups;
 * - an invisible material (`visible === false`) draws nothing.
 * Missing material indices and arrays without groups are reported, never replaced by material 0.
 */
export interface RenderedRange {
  readonly start: number;
  readonly count: number;
  /** Index into the mesh's material array (0 for a single material). */
  readonly materialIndex: number;
  /** True when the range is the whole geometry drawn with one material (no split needed). */
  readonly whole: boolean;
}

export function renderedRanges(geometry: BufferGeometry, material: Material | Material[], name = "mesh"): { ranges: RenderedRange[]; issues: string[] } {
  const total = geometry.index ? geometry.index.count : (geometry.getAttribute("position")?.count ?? 0);
  const drawStart = Math.max(0, geometry.drawRange.start);
  const drawEnd = Math.min(total, geometry.drawRange.start + (Number.isFinite(geometry.drawRange.count) ? geometry.drawRange.count : total));
  const issues: string[] = [];
  const clip = (start: number, count: number) => {
    const s = Math.max(start, drawStart);
    const e = Math.min(start + count, drawEnd);
    return e > s ? { start: s, count: e - s } : null;
  };
  if (!Array.isArray(material)) {
    if (!material.visible) return { ranges: [], issues };
    const range = clip(0, total);
    if (!range) return { ranges: [], issues };
    return { ranges: [{ ...range, materialIndex: 0, whole: range.start === 0 && range.count === total }], issues };
  }
  if (geometry.groups.length === 0) {
    issues.push(`${name}: material array without geometry groups draws nothing`);
    return { ranges: [], issues };
  }
  const ranges: RenderedRange[] = [];
  for (const group of geometry.groups) {
    const index = group.materialIndex ?? 0;
    const m = material[index];
    if (!m) {
      issues.push(`${name}: group ${group.start}+${group.count} uses missing material index ${index}`);
      continue;
    }
    if (!m.visible) continue;
    const range = clip(group.start, group.count);
    if (range) ranges.push({ ...range, materialIndex: index, whole: false });
  }
  return { ranges, issues };
}

type AnyAttribute = BufferAttribute | InterleavedBufferAttribute;

/**
 * A compact geometry holding only the vertices one range references (indexed or not): no vertex data is
 * shared with, or duplicated beyond, what the range draws, so per-range copies in the path tracer cost no
 * more than the original. Attributes keep their item size and normalization; morph attributes are not
 * copied (deformation is baked beforehand, see bakeDeformation).
 */
export function extractRange(source: BufferGeometry, start: number, count: number): BufferGeometry {
  const index = source.index;
  const remap = new Map<number, number>();
  const order: number[] = [];
  const indices = new Uint32Array(count);
  for (let i = 0; i < count; i++) {
    const vertex = index ? index.getX(start + i) : start + i;
    let mapped = remap.get(vertex);
    if (mapped === undefined) {
      mapped = order.length;
      remap.set(vertex, mapped);
      order.push(vertex);
    }
    indices[i] = mapped;
  }
  const geometry = new BufferGeometry();
  for (const [name, attribute] of Object.entries(source.attributes) as [string, AnyAttribute][]) {
    const size = attribute.itemSize;
    const ArrayType = (attribute.array as Float32Array).constructor as Float32ArrayConstructor;
    const array = new ArrayType(order.length * size);
    for (let v = 0; v < order.length; v++) {
      for (let c = 0; c < size; c++) array[v * size + c] = attribute.getComponent(order[v], c);
    }
    geometry.setAttribute(name, new BufferAttribute(array, size, attribute.normalized));
  }
  geometry.setIndex(new BufferAttribute(indices, 1));
  return geometry;
}

/** Whether the live mesh is deformed (active morph targets or skinning). */
export function isDeformed(mesh: Mesh): boolean {
  const skinned = (mesh as Mesh & { isSkinnedMesh?: boolean }).isSkinnedMesh === true;
  const morphed = !!mesh.morphTargetInfluences?.some((w) => w !== 0) && Object.keys(mesh.geometry.morphAttributes).length > 0;
  return skinned || morphed;
}

/**
 * A static copy of a deformed mesh's geometry as currently drawn: positions through three's own
 * Mesh.getVertexPosition (morph targets + skinning), normals from the morph normal targets when present,
 * otherwise recomputed from the deformed positions. Groups, draw range, index and every other attribute
 * are kept; morph attributes are dropped (baked).
 */
export function bakeDeformation(mesh: Mesh): BufferGeometry {
  const source = mesh.geometry as BufferGeometry;
  const baked = source.clone();
  baked.morphAttributes = {};
  const position = source.getAttribute("position");
  const out = new Float32Array(position.count * 3);
  const v = new Vector3();
  for (let i = 0; i < position.count; i++) {
    mesh.getVertexPosition(i, v);
    out.set([v.x, v.y, v.z], i * 3);
  }
  baked.setAttribute("position", new BufferAttribute(out, 3));
  const normal = source.getAttribute("normal");
  const morphNormals = source.morphAttributes.normal;
  const influences = mesh.morphTargetInfluences ?? [];
  const skinned = (mesh as Mesh & { isSkinnedMesh?: boolean }).isSkinnedMesh === true;
  if (normal && morphNormals && !skinned) {
    const n = new Float32Array(normal.count * 3);
    const relative = source.morphTargetsRelative;
    for (let i = 0; i < normal.count; i++) {
      const base = [normal.getX(i), normal.getY(i), normal.getZ(i)];
      const result = [...base];
      morphNormals.forEach((target, t) => {
        const w = influences[t] ?? 0;
        if (!w) return;
        const delta = [target.getX(i), target.getY(i), target.getZ(i)];
        for (let c = 0; c < 3; c++) result[c] += relative ? delta[c] * w : (delta[c] - base[c]) * w;
      });
      const length = Math.hypot(result[0], result[1], result[2]) || 1;
      n.set([result[0] / length, result[1] / length, result[2] / length], i * 3);
    }
    baked.setAttribute("normal", new BufferAttribute(n, 3));
  } else if (normal) {
    baked.deleteAttribute("normal");
    baked.computeVertexNormals();
  }
  return baked;
}
