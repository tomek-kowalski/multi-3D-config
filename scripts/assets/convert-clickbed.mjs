/**
 * Converts the supplied ClickBed OBJ models into web-ready GLB files and a geometry manifest.
 *
 * Usage (from the repository root):
 *   node scripts/assets/convert-clickbed.mjs "<path to 'Modele 3D łóżka Transforms'>"
 *
 * Verified structure of the supplied OBJ files (Blender 2.93 export, Y up, units = meters):
 * - every file contains the same bed twice, side by side along X: once folded (the platform is
 *   vertical inside the carcass) and once unfolded (the platform lies on the floor in front of it);
 * - the front faces +Z, the wall side is at the minimum Z;
 * - the files carry a single placeholder material ("None", grey) and no textures, so materials are
 *   assigned here by component, from the object names (see SLOT_RULES).
 *
 * Output:
 * - public/models/clickbed/<model>/<size>.glb: nodes "folded" and "unfolded", each with up to four meshes
 *   named "<state>:<slot>" using the materials "body", "front", "mattress" and "hardware". Each state is
 *   translated so the origin is the back-left-bottom corner of its carcass shell, so both states
 *   share the module's local frame (X right, Y up, Z towards the room, millimetres in the domain).
 * - src/domain/beds/data/clickbedModels.json: per model/size/state the measured bounds in millimetres.
 *
 * The OBJ geometry is not modified apart from that translation; proportions stay exactly as supplied.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { BufferAttribute, BufferGeometry, Box3, Vector3 } from "three";
import { OBJLoader } from "three/addons/loaders/OBJLoader.js";
import { mergeGeometries, mergeVertices } from "three/addons/utils/BufferGeometryUtils.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const SOURCE = process.argv[2];
if (!SOURCE) {
  console.error('Usage: node scripts/assets/convert-clickbed.mjs "<path to Modele 3D łóżka Transforms>"');
  process.exit(1);
}

/** Folder and file of every product size. Only sizes the shop sells are converted (O also has a 100x200 file). */
const MODELS = [
  {
    id: "clickbed-o",
    dir: "12_Click Bed O",
    file: (size) => `Click_Bec_O_${size}.obj`,
    sizes: ["90x200", "120x200", "140x200", "160x200", "180x200"],
  },
  {
    id: "clickbed-o-classico",
    dir: "17_Click Bed O Classico",
    file: (size) => `Click_Bed_O_Classico_${size}.obj`,
    sizes: ["140x200", "160x200", "180x200"],
  },
  {
    id: "clickbed-o-desk",
    dir: "16_Click Bed O Desk",
    file: (size) => `Click_Bed_O_Desk_${size}.obj`,
    sizes: ["140x200", "160x200", "180x200"],
  },
];

/**
 * Component → material slot, from the object names (identified from per-object bounds and
 * orthographic renders of every model; see docs/clickbed-assets.md):
 * - body: carcass (Box2035, Box021), back panel (Box2032), desk top (Box1003);
 * - front: front panel (Box2047, Box873) and the zero-thickness front planes of ClickBed O;
 * - mattress: Meridiani_Bed…, mattress…;
 * - hardware: everything else (bed frame/platform, slats, gas-strut mechanism, legs, lock, handle).
 */
function slotOf(name, size) {
  const base = name.split(/[._]/)[0];
  if (/^(Meridiani|mattress)/i.test(base)) return "mattress";
  if (["Box2035", "Box2032", "Box021", "Box1003"].includes(base)) return "body";
  if (["Box2047", "Box873"].includes(base)) return "front";
  if (base === "Plane" && Math.min(size.x, size.y, size.z) < 0.0005) return "front";
  return "hardware";
}

const SLOT_MATERIALS = {
  body: { color: [0.8, 0.8, 0.8, 1], metallic: 0, roughness: 0.7 },
  front: { color: [0.85, 0.85, 0.85, 1], metallic: 0, roughness: 0.6 },
  mattress: { color: [0.9, 0.89, 0.86, 1], metallic: 0, roughness: 0.95 },
  hardware: { color: [0.55, 0.56, 0.58, 1], metallic: 0.5, roughness: 0.45 },
};
const SLOTS = Object.keys(SLOT_MATERIALS);
const STATES = ["folded", "unfolded"];
/** Hinges and rails sit up to ~1 cm in front of the carcass; geometry beyond 2 cm counts as extension. */
const EXTENSION_MARGIN_M = 0.02;

/** Planar UVs in metres along the two axes of each triangle's dominant plane (for decor swatches). */
function boxProjectUvs(geometry) {
  const pos = geometry.getAttribute("position");
  const uv = new Float32Array(pos.count * 2);
  const a = new Vector3();
  const b = new Vector3();
  const c = new Vector3();
  for (let i = 0; i < pos.count; i += 3) {
    a.fromBufferAttribute(pos, i);
    b.fromBufferAttribute(pos, i + 1);
    c.fromBufferAttribute(pos, i + 2);
    const n = new Vector3().crossVectors(b.clone().sub(a), c.clone().sub(a));
    const ax = Math.abs(n.x);
    const ay = Math.abs(n.y);
    const az = Math.abs(n.z);
    for (let k = 0; k < 3; k++) {
      const x = pos.getX(i + k);
      const y = pos.getY(i + k);
      const z = pos.getZ(i + k);
      // Grain runs along the longest panel direction (X) on fronts/tops, vertically on sides.
      const [u, v] = az >= ax && az >= ay ? [x, y] : ay >= ax ? [x, z] : [z, y];
      uv[(i + k) * 2] = u;
      uv[(i + k) * 2 + 1] = v;
    }
  }
  geometry.setAttribute("uv", new BufferAttribute(uv, 2));
}

function boundsMm(box) {
  const mm = (v) => Math.round(v * 1000);
  return {
    min: { x: mm(box.min.x), y: mm(box.min.y), z: mm(box.min.z) },
    size: { width: mm(box.max.x - box.min.x), height: mm(box.max.y - box.min.y), depth: mm(box.max.z - box.min.z) },
  };
}

/** Minimal glTF 2.0 binary writer: positions, normals, uvs, uint32 indices, one material per slot. */
function writeGlb(states, outFile) {
  const chunks = [];
  let byteLength = 0;
  const bufferViews = [];
  const accessors = [];
  const push = (typed, target) => {
    const bytes = Buffer.from(typed.buffer, typed.byteOffset, typed.byteLength);
    const pad = (4 - (byteLength % 4)) % 4;
    if (pad) {
      chunks.push(Buffer.alloc(pad));
      byteLength += pad;
    }
    bufferViews.push({ buffer: 0, byteOffset: byteLength, byteLength: bytes.length, target });
    chunks.push(bytes);
    byteLength += bytes.length;
    return bufferViews.length - 1;
  };
  const materials = SLOTS.map((slot) => ({
    name: slot,
    pbrMetallicRoughness: {
      baseColorFactor: SLOT_MATERIALS[slot].color,
      metallicFactor: SLOT_MATERIALS[slot].metallic,
      roughnessFactor: SLOT_MATERIALS[slot].roughness,
    },
    doubleSided: true,
  }));
  const meshes = [];
  const nodes = [];
  const stateNodes = [];
  for (const state of STATES) {
    const children = [];
    for (const slot of SLOTS) {
      const geometry = states[state][slot];
      if (!geometry) continue;
      const position = geometry.getAttribute("position");
      const box = new Box3().setFromBufferAttribute(position);
      const attributes = {};
      accessors.push({
        bufferView: push(position.array, 34962),
        componentType: 5126,
        count: position.count,
        type: "VEC3",
        min: box.min.toArray(),
        max: box.max.toArray(),
      });
      attributes.POSITION = accessors.length - 1;
      accessors.push({ bufferView: push(geometry.getAttribute("normal").array, 34962), componentType: 5126, count: position.count, type: "VEC3" });
      attributes.NORMAL = accessors.length - 1;
      accessors.push({ bufferView: push(geometry.getAttribute("uv").array, 34962), componentType: 5126, count: position.count, type: "VEC2" });
      attributes.TEXCOORD_0 = accessors.length - 1;
      const index = Uint32Array.from(geometry.getIndex().array);
      accessors.push({ bufferView: push(index, 34963), componentType: 5125, count: index.length, type: "SCALAR" });
      meshes.push({
        name: `${state}:${slot}`,
        primitives: [{ attributes, indices: accessors.length - 1, material: SLOTS.indexOf(slot) }],
      });
      nodes.push({ name: `${state}:${slot}`, mesh: meshes.length - 1 });
      children.push(nodes.length - 1);
    }
    nodes.push({ name: state, children });
    stateNodes.push(nodes.length - 1);
  }
  const gltf = {
    asset: { version: "2.0", generator: "multi-3D-config convert-clickbed.mjs" },
    scene: 0,
    scenes: [{ nodes: stateNodes }],
    nodes,
    meshes,
    materials,
    accessors,
    bufferViews,
    buffers: [{ byteLength }],
  };
  let json = Buffer.from(JSON.stringify(gltf));
  json = Buffer.concat([json, Buffer.alloc((4 - (json.length % 4)) % 4, 0x20)]);
  let bin = Buffer.concat(chunks);
  bin = Buffer.concat([bin, Buffer.alloc((4 - (bin.length % 4)) % 4)]);
  const header = Buffer.alloc(12);
  header.writeUInt32LE(0x46546c67, 0);
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(12 + 8 + json.length + 8 + bin.length, 8);
  const chunkHeader = (length, type) => {
    const h = Buffer.alloc(8);
    h.writeUInt32LE(length, 0);
    h.writeUInt32LE(type, 4);
    return h;
  };
  mkdirSync(dirname(outFile), { recursive: true });
  writeFileSync(outFile, Buffer.concat([header, chunkHeader(json.length, 0x4e4f534a), json, chunkHeader(bin.length, 0x004e4942), bin]));
}

const manifest = { source: "lib/Modele 3D łóżka Transforms (supplied OBJ, Blender 2.93 export)", unit: "mm", models: {} };

for (const model of MODELS) {
  manifest.models[model.id] = { folder: model.dir, sizes: {} };
  for (const size of model.sizes) {
    const path = join(SOURCE, model.dir, model.file(size));
    // `l` records are bare polyline edges (no surface). The Desk files have four inside the mattress
    // object, which makes OBJLoader turn the whole object into LineSegments and drop its faces.
    const source = readFileSync(path, "utf8")
      .split(/\r?\n/)
      .filter((line) => !line.startsWith("l "))
      .join("\n");
    const group = new OBJLoader().parse(source);
    const objects = [];
    group.traverse((child) => {
      if (!child.isMesh) return;
      const box = new Box3().setFromBufferAttribute(child.geometry.getAttribute("position"));
      objects.push({ name: child.name, geometry: child.geometry, box, center: box.getCenter(new Vector3()) });
    });
    const xs = objects.map((o) => o.center.x);
    const split = (Math.min(...xs) + Math.max(...xs)) / 2;
    const copies = [objects.filter((o) => o.center.x < split), objects.filter((o) => o.center.x >= split)].map((parts) => {
      const box = new Box3();
      for (const p of parts) box.union(p.box);
      return { parts, box };
    });
    // The folded copy is the shallower one (the platform stands inside the carcass).
    copies.sort((a, b) => a.box.max.z - a.box.min.z - (b.box.max.z - b.box.min.z));
    const result = {};
    const entry = { file: `${model.id}/${size}.glb`, objects: {}, states: {} };
    STATES.forEach((state, i) => {
      const { parts } = copies[i];
      const bodyBox = new Box3();
      const carcassBox = new Box3();
      for (const p of parts) {
        p.slot = slotOf(p.name, p.box.getSize(new Vector3()));
        if (p.slot === "body") bodyBox.union(p.box);
        // The carcass shell alone (no back panel, desk top or rail): the module's footprint.
        if (["Box2035", "Box021"].includes(p.name.split(/[._]/)[0])) carcassBox.union(p.box);
      }
      const offset = carcassBox.min.clone().negate();
      const fullBox = new Box3();
      result[state] = {};
      for (const slot of SLOTS) {
        const geometries = parts
          .filter((p) => p.slot === slot)
          .map((p) => {
            const g = new BufferGeometry();
            g.setAttribute("position", p.geometry.getAttribute("position").clone());
            if (p.geometry.getAttribute("normal")) g.setAttribute("normal", p.geometry.getAttribute("normal").clone());
            else g.computeVertexNormals();
            g.translate(offset.x, offset.y, offset.z);
            return g;
          });
        if (geometries.length === 0) continue;
        const merged = mergeGeometries(geometries);
        boxProjectUvs(merged);
        const indexed = mergeVertices(merged, 1e-5);
        fullBox.union(new Box3().setFromBufferAttribute(indexed.getAttribute("position")));
        result[state][slot] = indexed;
      }
      // Geometry standing in front of the carcass (the unfolded bed, or the deployed desk), measured
      // per vertex: some parts (e.g. the leg frame) also have a few vertices at the top of the front.
      const extensionBox = new Box3();
      const limitZ = carcassBox.max.z + EXTENSION_MARGIN_M;
      const v = new Vector3();
      for (const p of parts) {
        const position = p.geometry.getAttribute("position");
        for (let i = 0; i < position.count; i++) {
          v.fromBufferAttribute(position, i);
          if (v.z > limitZ) extensionBox.expandByPoint(v);
        }
      }
      entry.objects[state] = parts.map((p) => ({ name: p.name, slot: p.slot }));
      entry.states[state] = {
        carcass: boundsMm(carcassBox.clone().translate(offset)),
        body: boundsMm(bodyBox.clone().translate(offset)),
        overall: boundsMm(fullBox),
        extension: extensionBox.isEmpty() ? null : boundsMm(extensionBox.clone().translate(offset)),
        triangles: SLOTS.reduce((n, s) => n + (result[state][s] ? result[state][s].getIndex().count / 3 : 0), 0),
      };
    });
    writeGlb(result, join(ROOT, "public/models/clickbed", entry.file));
    manifest.models[model.id].sizes[size] = entry;
    const f = entry.states.folded;
    const u = entry.states.unfolded;
    console.log(
      `${model.id} ${size}: folded body ${f.carcass.size.width}×${f.carcass.size.height}×${f.carcass.size.depth}, overall ${f.overall.size.width}×${f.overall.size.height}×${f.overall.size.depth}` +
        ` | unfolded overall ${u.overall.size.width}×${u.overall.size.height}×${u.overall.size.depth} (z from ${u.overall.min.z}) | tris ${f.triangles}+${u.triangles}`,
    );
  }
}

writeFileSync(join(ROOT, "src/domain/beds/data/clickbedModels.json"), JSON.stringify(manifest, null, 1) + "\n");
