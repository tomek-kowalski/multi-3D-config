/**
 * TEST-ONLY: GPU normal-map parity with the real Phase 4 maps (docs/phase4-pbr-asset-inventory.md §7).
 *
 * Every object carries a registered material with a real normal map (laminate floor — strong plank
 * grooves — and the walnut veneer) on a different kind of UV0: parametric panel faces (front, opposite,
 * vertical grain), the floor UV generator with planks along z, a rotated box, and imported glTF boxes
 * with and without TANGENT vectors (and with tangents generated after loading). A CONTROL panel uses the
 * same map with normalScale −1 (registered here, test-only): it must read inverted in every renderer, which
 * proves the check fails when relief is inverted. A white sphere is the light-side probe.
 *
 * Method (renderer-agnostic): the scene is rendered twice with the raking light at +d and −d (d = world
 * x or y). The difference image D carries the relief term n_t · (±d); for a correct tangent frame it is
 * proportional to P = nx (T·d) + ny (B·d), where (nx, ny) is the map texel under the pixel (found through
 * a UV pass) and T = ∂P/∂u, B = ∂P/∂v are the surface's own UV directions (normal-map +X along +u, +Y
 * along +v: OpenGL convention). D is regressed on the mean image first (exposure/albedo), then the
 * partial correlation r(D, P) is reported per object: r > 0 → relief lit from the correct side; r < 0 →
 * inverted.
 *
 * Registration: photo renderers jitter and filter the image, so the photo is first aligned with the UV
 * pass — the integer pixel shift that maximizes the correlation between the photo's mean image and the
 * objects' own albedo (looked up through the UV pass) is applied before measuring relief. (Without it,
 * a one-pixel offset decorrelates the 2 mm plank grooves and makes the sign depend on the position.)
 */
import { useThree } from "@react-three/fiber";
import { useEffect, useState } from "react";
import {
  BoxGeometry,
  DirectionalLight,
  EquirectangularReflectionMapping,
  FloatType,
  Group,
  LinearSRGBColorSpace,
  Mesh,
  MeshStandardMaterial,
  PerspectiveCamera,
  PlaneGeometry,
  RGBAFormat,
  ShaderMaterial,
  SphereGeometry,
  Vector2,
  Vector3,
  WebGLRenderTarget,
  type BufferGeometry,
  type Camera,
  type Material,
  type Object3D,
  type Scene,
  type Texture,
  type WebGLRenderer,
} from "three";
import { GLTFExporter } from "three/examples/jsm/exporters/GLTFExporter.js";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { materialRegistry } from "@/domain/materials";
import { cabinetFinishSelection, floorMaterialRegistryId } from "@/domain/materials/bindings";
import type { MappingSpec, MaterialSelection, MeshMaterialBinding, TextureAsset } from "@/domain/materials/contracts";
import { halfFloatEnvironment } from "@/components/three/materials/hdriSource";
import { useMaterialRuntime } from "@/components/three/materials/MaterialRuntime";
import { attachMaterialBinding, createSlotMaterials, installMaterials, type SlotMaterialSet } from "@/components/three/materials/materialSlots";
import { partMapping, unitBoxWithMetreUvs, writeFloorMetreUvs } from "@/components/three/materials/physicalUv";
import { createPathTracedBackend, createRasterBackend } from "@/components/three/photo/backends";
import { chooseRenderMode, probeGpu } from "@/components/three/photo/capabilities";
import { renderPhotoViews } from "@/components/three/photo/photoEngine";
import { buildPhotoScene, takeSnapshot } from "@/components/three/photo/photoScene";
import { resolvePhotoSettings } from "@/components/three/photo/photoSettings";
import { photoTag } from "@/components/three/photo/tags";

/** Name of the deliberately inverted control object (expected r < 0 everywhere). */
export const CONTROL = "CONTROL inverted relief (normalScale -1)";
export const PROBE = "probe sphere";
const LAMINATE = floorMaterialRegistryId("laminate");
const INVERTED = "lab/inverted-laminate";

// Test-only registry data: the laminate floor material with its relief inverted.
{
  const laminate = materialRegistry.resolve({ kind: "registered", id: LAMINATE });
  if (laminate.source === "registry" && laminate.color.kind === "map") {
    materialRegistry.register({
      surfaces: [{ ...laminate.surface, id: "lab/inverted-laminate-surface", normalScale: [-1, -1] }],
      materials: [
        {
          id: INVERTED,
          category: laminate.category,
          color: laminate.color,
          surfaceProfileId: "lab/inverted-laminate-surface",
          finishProfileId: laminate.finish.id,
          provenance: "TEST ONLY: deliberately inverted relief",
        },
      ],
    });
  }
}

interface ParityObject {
  readonly id: number;
  readonly name: string;
  readonly mesh: Mesh;
  readonly selection: MaterialSelection;
}

export const parity: { objects: ParityObject[]; light: DirectionalLight | null; camera: PerspectiveCamera | null } = { objects: [], light: null, camera: null };
export const PARITY_OBJECTS = 12;

const CAMERA_Z = 3.1;
const S = 0.45;
const COLUMNS = [-0.93, -0.31, 0.31, 0.93];
const ROWS = [0.6, 0, -0.6];
/** Raking angle of the light from the surface plane (degrees above grazing: 20°). */
const RAKE = (70 * Math.PI) / 180;

function lightDirection(axis: "x" | "y", sign: 1 | -1): Vector3 {
  const d = axis === "x" ? new Vector3(1, 0, 0) : new Vector3(0, 1, 0);
  return d.multiplyScalar(sign * Math.sin(RAKE)).add(new Vector3(0, 0, Math.cos(RAKE))).normalize();
}

function exportImport(geometry: BufferGeometry): Promise<Mesh> {
  const mesh = new Mesh(geometry, new MeshStandardMaterial());
  return new GLTFExporter()
    .parseAsync(mesh, { binary: true })
    .then((glb) => new GLTFLoader().parseAsync(glb as ArrayBuffer, ""))
    .then((gltf) => gltf.scene.getObjectByProperty("type", "Mesh") as Mesh);
}

/** Geometry facts of each parity object (attributes, groups) for diagnosis. */
export function parityGeometry() {
  return parity.objects.map((o) => ({
    name: o.name,
    attributes: Object.keys(o.mesh.geometry.attributes),
    groups: o.mesh.geometry.groups.length,
  }));
}

export function NormalParity() {
  const runtime = useMaterialRuntime();
  const camera = useThree((s) => s.camera);
  const invalidate = useThree((s) => s.invalidate);
  const [root, setRoot] = useState<Object3D | null>(null);
  useEffect(() => {
    camera.position.set(0, 0, CAMERA_Z);
    camera.lookAt(0, 0, 0);
    camera.updateMatrixWorld();
    let disposed = false;
    const group = new Group();
    const sets: SlotMaterialSet[] = [];
    const objects: ParityObject[] = [];
    const laminate: MaterialSelection = { kind: "registered", id: LAMINATE };
    const slot = (k: number): [number, number] => [COLUMNS[k % 4], ROWS[Math.floor(k / 4)]];
    const add = (k: number, name: string, mesh: Mesh, selection: MaterialSelection, mapping: MappingSpec) => {
      const binding: MeshMaterialBinding = { slots: [{ slotId: "s", selection, mapping, side: "front" }], groups: [] };
      const set = createSlotMaterials(binding, runtime);
      installMaterials(mesh, set, binding);
      attachMaterialBinding(mesh, { binding, authored: {} });
      const id = objects.length + 1;
      mesh.userData = { ...photoTag("board"), parityId: id };
      const [x, y] = slot(k);
      mesh.position.set(x, y, 0);
      sets.push(set);
      objects.push({ id, name, mesh, selection });
      group.add(mesh);
    };
    const panel = (grain: "x" | "y") => {
      const m = new Mesh(unitBoxWithMetreUvs([S, S, 0.02], grain));
      m.scale.set(S, S, 0.02);
      return m;
    };
    const authored: MappingSpec = { kind: "authored-uv0", uvUnits: "normalized", coverageM: [S, S] };
    add(0, "panel front face, grain x", panel("x"), laminate, partMapping("box", "x"));
    const back = panel("x");
    back.rotation.y = Math.PI;
    add(1, "panel opposite face (mirrored)", back, laminate, partMapping("box", "x"));
    add(2, "panel front face, grain y", panel("y"), laminate, partMapping("box", "y"));
    const floorUv = new PlaneGeometry(S, S);
    writeFloorMetreUvs(floorUv, S, S, "z");
    add(3, "floor UVs, planks along z", new Mesh(floorUv), laminate, { kind: "projected-metres", originM: [0, 0, 0], uAxis: [0, 0, 1], vAxis: [-1, 0, 0] });
    add(4, "walnut door (veneer)", panel("y"), cabinetFinishSelection("walnut"), partMapping("box", "y"));
    const rotated = new Mesh(new BoxGeometry(S, S, 0.02));
    rotated.rotation.z = Math.PI;
    add(9, "box rotated 180° about z", rotated, laminate, authored);
    add(8, CONTROL, panel("x"), { kind: "registered", id: INVERTED }, partMapping("box", "x"));
    add(11, PROBE, new Mesh(new SphereGeometry(0.2, 64, 48)), cabinetFinishSelection("white-matte"), partMapping("box", "x"));
    const withTangents = new BoxGeometry(S, S, 0.02);
    withTangents.computeTangents();
    const metre = unitBoxWithMetreUvs([S, S, 0.02], "x");
    Promise.all([exportImport(withTangents), exportImport(new BoxGeometry(S, S, 0.02)), exportImport(metre), exportImport(new BoxGeometry(S, S, 0.02))]).then(
      ([tangents, plain, metreImported, retangent]) => {
        if (disposed) return;
        add(5, `glTF with TANGENT (${tangents.geometry.getAttribute("tangent") ? "present" : "missing"})`, tangents, laminate, authored);
        add(6, `glTF without TANGENT (${plain.geometry.getAttribute("tangent") ? "present" : "absent"})`, plain, laminate, authored);
        metreImported.scale.set(S, S, 0.02);
        add(7, "glTF metre-UV panel", metreImported, laminate, partMapping("box", "x"));
        retangent.geometry.computeTangents();
        add(10, "glTF, tangents generated after loading", retangent, laminate, authored);
        const light = new DirectionalLight("#ffffff", 0);
        group.add(light, light.target);
        parity.objects = objects;
        parity.light = light;
        parity.camera = camera as PerspectiveCamera;
        setRoot(group);
        invalidate();
      },
    );
    return () => {
      disposed = true;
      sets.forEach((s) => s.dispose());
      parity.objects = [];
      parity.light = null;
    };
  }, [runtime, camera, invalidate]);
  return root ? <primitive object={root} /> : null;
}

// ---- Analysis ----

/** World-space unit ∂P/∂u and ∂P/∂v of the object's face most directly facing the camera. */
function uvFrame(mesh: Mesh, toCamera: Vector3): { T: Vector3; B: Vector3 } {
  mesh.updateMatrixWorld(true);
  const g = mesh.geometry;
  const pos = g.getAttribute("position");
  const uv = g.getAttribute("uv");
  const index = g.index;
  const count = index ? index.count : pos.count;
  const at = (k: number) => (index ? index.getX(k) : k);
  let best: { T: Vector3; B: Vector3; facing: number } | null = null;
  for (let t = 0; t < count; t += 3) {
    const p = [0, 1, 2].map((e) => new Vector3(pos.getX(at(t + e)), pos.getY(at(t + e)), pos.getZ(at(t + e))).applyMatrix4(mesh.matrixWorld));
    const w = [0, 1, 2].map((e) => new Vector2(uv.getX(at(t + e)), uv.getY(at(t + e))));
    const e1 = p[1].clone().sub(p[0]);
    const e2 = p[2].clone().sub(p[0]);
    const n = e1.clone().cross(e2).normalize();
    const facing = n.dot(toCamera);
    if (best && facing <= best.facing) continue;
    const du1 = w[1].x - w[0].x;
    const dv1 = w[1].y - w[0].y;
    const du2 = w[2].x - w[0].x;
    const dv2 = w[2].y - w[0].y;
    const r = 1 / (du1 * dv2 - du2 * dv1);
    if (!Number.isFinite(r)) continue;
    const T = e1.clone().multiplyScalar(dv2).sub(e2.clone().multiplyScalar(dv1)).multiplyScalar(r).normalize();
    const B = e2.clone().multiplyScalar(du1).sub(e1.clone().multiplyScalar(du2)).multiplyScalar(r).normalize();
    best = { T, B, facing };
  }
  return best!;
}

/** UV0 and object id per pixel (rows bottom-up), from the given camera. */
function uvPass(gl: WebGLRenderer, scene: Scene, camera: Camera, width: number, height: number): Float32Array {
  const target = new WebGLRenderTarget(width, height, { type: FloatType, format: RGBAFormat });
  const swapped: [Mesh, Material | Material[]][] = [];
  const hidden: Object3D[] = [];
  const ids = new Map(parity.objects.map((o) => [o.mesh, o.id]));
  scene.traverseVisible((o) => {
    if (!(o as Mesh).isMesh) return;
    const mesh = o as Mesh;
    const id = ids.get(mesh);
    if (id === undefined) {
      hidden.push(mesh);
      return;
    }
    swapped.push([mesh, mesh.material]);
    mesh.material = new ShaderMaterial({
      uniforms: { id: { value: id } },
      vertexShader: "varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }",
      fragmentShader: "uniform float id; varying vec2 vUv; void main() { gl_FragColor = vec4(vUv, id, 1.0); }",
    });
  });
  hidden.forEach((o) => (o.visible = false));
  const background = scene.background;
  scene.background = null;
  const clear = gl.getClearAlpha();
  gl.setClearAlpha(0);
  gl.setRenderTarget(target);
  gl.clear();
  gl.render(scene, camera);
  const out = new Float32Array(width * height * 4);
  gl.readRenderTargetPixels(target, 0, 0, width, height, out);
  gl.setRenderTarget(null);
  gl.setClearAlpha(clear);
  scene.background = background;
  hidden.forEach((o) => (o.visible = true));
  for (const [mesh, material] of swapped) {
    (mesh.material as Material).dispose();
    mesh.material = material;
  }
  target.dispose();
  return out;
}

interface Image2D {
  readonly data: Uint8ClampedArray;
  readonly width: number;
  readonly height: number;
}

async function decode(blob: Blob): Promise<Image2D> {
  const bitmap = await createImageBitmap(blob, { colorSpaceConversion: "none", premultiplyAlpha: "none" });
  const canvas = document.createElement("canvas");
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  const ctx = canvas.getContext("2d")!;
  ctx.drawImage(bitmap, 0, 0);
  return { data: ctx.getImageData(0, 0, canvas.width, canvas.height).data, width: canvas.width, height: canvas.height };
}

/** Luminance per pixel, rows bottom-up. */
function luminance(rgba: ArrayLike<number>, width: number, height: number, topDown: boolean): Float32Array {
  const out = new Float32Array(width * height);
  for (let y = 0; y < height; y++) {
    const row = topDown ? height - 1 - y : y;
    for (let x = 0; x < width; x++) {
      const i = (row * width + x) * 4;
      out[y * width + x] = 0.2126 * rgba[i] + 0.7152 * rgba[i + 1] + 0.0722 * rgba[i + 2];
    }
  }
  return out;
}

function pearson(a: number[], b: number[]): number {
  const n = a.length;
  if (n < 10) return Number.NaN;
  const ma = a.reduce((s, v) => s + v, 0) / n;
  const mb = b.reduce((s, v) => s + v, 0) / n;
  let sab = 0;
  let saa = 0;
  let sbb = 0;
  for (let i = 0; i < n; i++) {
    sab += (a[i] - ma) * (b[i] - mb);
    saa += (a[i] - ma) ** 2;
    sbb += (b[i] - mb) ** 2;
  }
  return sab / Math.sqrt(saa * sbb);
}

/** Residual of y after a least-squares fit on x (removes exposure/albedo coupling). */
function residual(y: number[], x: number[]): number[] {
  const n = y.length;
  const mx = x.reduce((s, v) => s + v, 0) / n;
  const my = y.reduce((s, v) => s + v, 0) / n;
  let sxy = 0;
  let sxx = 0;
  for (let i = 0; i < n; i++) {
    sxy += (x[i] - mx) * (y[i] - my);
    sxx += (x[i] - mx) ** 2;
  }
  const k = sxx > 0 ? sxy / sxx : 0;
  return y.map((v, i) => v - my - k * (x[i] - mx));
}

/** The maps an object's material samples (by the tier actually used), with its texture transform. */
interface ObjectMaps {
  readonly normal: Image2D;
  readonly albedo: Image2D;
  readonly matrix: number[];
}
type Maps = Map<number, ObjectMaps>;

function variantUrl(asset: TextureAsset, width: number | null): string {
  const tiers = Object.values(asset.variants).filter((v): v is NonNullable<typeof v> => !!v);
  return (width ? tiers.find((v) => v.width === width) : null)?.url ?? (asset.variants.enhanced ?? asset.variants.standard).url;
}

async function objectMaps(source: "live" | "photo"): Promise<Maps> {
  const maps: Maps = new Map();
  for (const o of parity.objects) {
    const resolved = materialRegistry.resolve(o.selection);
    const normalMap = resolved.surface?.maps.normal;
    if (!normalMap || resolved.color?.kind !== "map") continue;
    const material = o.mesh.material as MeshStandardMaterial;
    const live = material.normalMap as Texture | null;
    if (!live) continue;
    live.updateMatrix();
    const liveWidth = (live.image as { width?: number } | null)?.width ?? null;
    const normalAsset = materialRegistry.getTextureAsset(normalMap.assetId);
    const albedoAsset = materialRegistry.getTextureAsset(resolved.color.map.assetId);
    const liveAlbedoWidth = ((material.map as Texture | null)?.image as { width?: number } | null)?.width ?? null;
    const [normal, albedo] = await Promise.all([
      fetch(variantUrl(normalAsset, source === "live" ? liveWidth : null)).then((r) => r.blob()).then(decode),
      fetch(variantUrl(albedoAsset, source === "live" ? liveAlbedoWidth : null)).then((r) => r.blob()).then(decode),
    ]);
    maps.set(o.id, { normal, albedo, matrix: [...live.matrix.elements] });
  }
  return maps;
}

/** Texel of an image at UV (texture transform, wrapped; v = 1 is the image's first row). */
function texel(image: Image2D, m: number[], u: number, v: number): number {
  const tu = m[0] * u + m[3] * v + m[6];
  const tv = m[1] * u + m[4] * v + m[7];
  const ix = Math.min(image.width - 1, Math.floor((tu - Math.floor(tu)) * image.width));
  const iy = Math.min(image.height - 1, Math.floor((1 - (tv - Math.floor(tv))) * image.height));
  return (iy * image.width + ix) * 4;
}

/** Integer pixel shift (dx, dy) aligning a rendered image with the UV pass, from the albedo pattern. */
function registration(mean: Float32Array, uv: Float32Array, width: number, height: number, maps: Maps): [number, number] {
  let best: [number, number] = [0, 0];
  let bestScore = -Infinity;
  for (let dy = -3; dy <= 3; dy++) {
    for (let dx = -3; dx <= 3; dx++) {
      let score = 0;
      for (const o of parity.objects) {
        const m = maps.get(o.id);
        if (!m) continue;
        const a: number[] = [];
        const b: number[] = [];
        for (let y = 4; y < height - 4; y++) {
          for (let x = 4; x < width - 4; x++) {
            const q = (y + dy) * width + (x + dx);
            if (Math.round(uv[q * 4 + 2]) !== o.id) continue;
            const k = texel(m.albedo, m.matrix, uv[q * 4], uv[q * 4 + 1]);
            a.push(mean[y * width + x]);
            b.push(0.2126 * m.albedo.data[k] + 0.7152 * m.albedo.data[k + 1] + 0.0722 * m.albedo.data[k + 2]);
          }
        }
        const r = pearson(a, b);
        if (Number.isFinite(r)) score += r;
      }
      if (score > bestScore) {
        bestScore = score;
        best = [dx, dy];
      }
    }
  }
  return best;
}

function analyse(plus: Float32Array, minus: Float32Array, uv: Float32Array, width: number, height: number, axis: "x" | "y", maps: Maps, camera: Camera, shift: [number, number]) {
  const d = axis === "x" ? new Vector3(1, 0, 0) : new Vector3(0, 1, 0);
  const result: Record<string, number> = {};
  const [dx, dy] = shift;
  for (const o of parity.objects) {
    const toCamera = camera.position.clone().sub(o.mesh.getWorldPosition(new Vector3())).normalize();
    const { T, B } = uvFrame(o.mesh, toCamera);
    const D: number[] = [];
    const M: number[] = [];
    const P: number[] = [];
    const screen: number[] = [];
    const m = maps.get(o.id);
    for (let y = 4; y < height - 4; y++) {
      for (let x = 4; x < width - 4; x++) {
        const p = y * width + x;
        const q = (y + dy) * width + (x + dx);
        if (Math.round(uv[q * 4 + 2]) !== o.id) continue;
        // Interior pixels only (no silhouette mixing).
        if ([q - 1, q + 1, q - width, q + width].some((n) => Math.round(uv[n * 4 + 2]) !== o.id)) continue;
        D.push(plus[p] - minus[p]);
        M.push((plus[p] + minus[p]) / 2);
        screen.push(axis === "x" ? x : y);
        if (m) {
          const k = texel(m.normal, m.matrix, uv[q * 4], uv[q * 4 + 1]);
          const nx = (m.normal.data[k] / 255) * 2 - 1;
          const ny = (m.normal.data[k + 1] / 255) * 2 - 1;
          P.push(nx * T.dot(d) + ny * B.dot(d));
        }
      }
    }
    result[o.name] = m ? pearson(residual(D, M), P) : pearson(D, screen);
  }
  return result;
}

/** Viewport: the live canvas with the lab's own raking light (everything else identical in ±). */
export async function viewportParity(gl: WebGLRenderer, scene: Scene) {
  const camera = parity.camera!;
  const light = parity.light!;
  const size = gl.getDrawingBufferSize(new Vector2());
  const uv = uvPass(gl, scene, camera, size.x, size.y);
  const shots: Record<string, Float32Array> = {};
  for (const axis of ["x", "y"] as const) {
    for (const sign of [1, -1] as const) {
      light.intensity = 3;
      light.position.copy(lightDirection(axis, sign).multiplyScalar(6));
      light.target.position.set(0, 0, 0);
      light.updateMatrixWorld();
      light.target.updateMatrixWorld();
      gl.render(scene, camera);
      const ctx = gl.getContext();
      const px = new Uint8Array(size.x * size.y * 4);
      ctx.readPixels(0, 0, size.x, size.y, ctx.RGBA, ctx.UNSIGNED_BYTE, px);
      shots[`${axis}${sign}`] = luminance(px, size.x, size.y, false);
    }
  }
  light.intensity = 0;
  const maps = await objectMaps("live");
  const mean = shots["x1"].map((v, i) => (v + shots["x-1"][i]) / 2);
  const shift = registration(mean, uv, size.x, size.y, maps);
  return {
    shift,
    x: analyse(shots["x1"], shots["x-1"], uv, size.x, size.y, "x", maps, camera, shift),
    y: analyse(shots["y1"], shots["y-1"], uv, size.x, size.y, "y", maps, camera, shift),
    normalMapSizes: Object.fromEntries([...maps.entries()].map(([id, n]) => [parity.objects[id - 1].name, n.normal.width])),
  };
}

/** Equirectangular environment: dim neutral sky plus one bright patch towards `direction` (three's convention). */
function patchEnvironment(direction: Vector3) {
  const w = 256;
  const h = 128;
  const rgba = new Float32Array(w * h * 4);
  const dir = new Vector3();
  for (let j = 0; j < h; j++) {
    for (let i = 0; i < w; i++) {
      const phi = ((i + 0.5) / w - 0.5) * 2 * Math.PI;
      const theta = ((j + 0.5) / h - 0.5) * Math.PI;
      dir.set(Math.cos(theta) * Math.cos(phi), Math.sin(theta), Math.cos(theta) * Math.sin(phi));
      const angle = Math.acos(Math.min(1, Math.max(-1, dir.dot(direction))));
      const v = 0.15 + 60 * Math.exp(-((angle / 0.18) ** 2));
      const k = (j * w + i) * 4;
      rgba[k] = rgba[k + 1] = rgba[k + 2] = v;
      rgba[k + 3] = 1;
    }
  }
  const texture = halfFloatEnvironment(rgba, w, h, "parity-patch");
  texture.mapping = EquirectangularReflectionMapping;
  texture.colorSpace = LinearSRGBColorSpace;
  texture.needsUpdate = true;
  return texture;
}

/** Fast raster or path tracer: the photo pipeline with a raking environment patch at ±d. */
export async function photoParity(gl: WebGLRenderer, scene: Scene, mode: "fast" | "standard", denoise: boolean, axes: readonly ("x" | "y")[] = ["x", "y"]) {
  const width = 400;
  const height = 250;
  const camera = new PerspectiveCamera(40, width / height, 0.05, 100);
  camera.position.set(0, 0, CAMERA_Z);
  camera.lookAt(0, 0, 0);
  camera.updateMatrixWorld();
  const uv = uvPass(gl, scene, camera, width, height);
  const settings = resolvePhotoSettings({ quality: mode, width, height, denoise });
  const shots: Record<string, Float32Array> = {};
  const meta: Record<string, unknown> = {};
  for (const axis of axes) {
    for (const sign of [1, -1] as const) {
      const environment = patchEnvironment(lightDirection(axis, sign));
      const snapshot = takeSnapshot(scene);
      await snapshot.ready;
      const view = { id: "front-right", camera: { position: camera.position.toArray(), target: [0, 0, 0], fov: 40 }, hiddenWalls: [] };
      const [photo] = await renderPhotoViews([view as never], settings, {
        choice: chooseRenderMode(probeGpu()),
        createBackend: (m, s) => (m === "pathtraced" ? createPathTracedBackend(s, environment) : createRasterBackend(s, environment)),
        buildView: () => ({ scene: buildPhotoScene(snapshot, [], environment), camera: camera.clone() }),
        now: () => performance.now(),
        nextFrame: () => new Promise((r) => requestAnimationFrame(() => r())),
      });
      meta[`${axis}${sign}`] = { mode: photo.mode, samples: photo.samples, reductions: photo.reductions };
      const image = await decode(photo.blob);
      shots[`${axis}${sign}`] = luminance(image.data, image.width, image.height, true);
      snapshot.dispose();
      environment.dispose();
    }
  }
  const maps = await objectMaps("photo");
  const first = axes[0];
  const mean = shots[`${first}1`].map((v, i) => (v + shots[`${first}-1`][i]) / 2);
  const shift = registration(mean, uv, width, height, maps);
  const out: Record<string, unknown> = { meta, shift };
  for (const axis of axes) out[axis] = analyse(shots[`${axis}1`], shots[`${axis}-1`], uv, width, height, axis, maps, camera, shift);
  return out;
}
