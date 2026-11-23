import {
  Box3,
  Color,
  Mesh,
  RectAreaLight,
  Scene,
  Vector3,
  type BufferGeometry,
  type Material,
  type Matrix4,
  type MeshPhysicalMaterial,
  type Object3D,
  type Texture,
} from "three";
import type { WallId } from "@/domain/room/types";
import { photoMaterial, type PhotoDecor } from "./photoMaterials";
import { readPhotoTag, type PhotoTag } from "./tags";

/** One mesh of the photo: an independent copy of a tagged, visible mesh of the live scene. */
export interface SnapshotItem {
  readonly name: string;
  readonly tag: PhotoTag;
  readonly geometry: BufferGeometry;
  readonly matrix: Matrix4;
  readonly material: MeshPhysicalMaterial;
}

/**
 * The configured scene frozen at one moment: geometry, transforms, colours and decors are copied, so
 * all photos of one request show exactly the same configuration even if the customer keeps editing
 * while it renders, and nothing in the live view is changed by rendering.
 */
export interface SceneSnapshot {
  readonly items: readonly SnapshotItem[];
  /** Models still loading (their placeholder is in the scene instead of the furniture). */
  readonly loading: number;
  /** Bounds of everything in the snapshot, metres. */
  readonly bounds: Box3;
  /** World-space bounds of the drawn furniture geometry only (empty when there is none). */
  readonly furnitureBounds: Box3;
  dispose(): void;
}

const FURNITURE_ROLES = new Set(["board", "metal", "dark", "fabric"]);

/** World-space bounding box of a geometry's vertices under a matrix (exact for rotated parts). */
function worldBox(geometry: BufferGeometry, matrix: Matrix4): Box3 {
  const position = geometry.getAttribute("position");
  const box = new Box3();
  const v = new Vector3();
  for (let i = 0; i < position.count; i++) box.expandByPoint(v.fromBufferAttribute(position, i).applyMatrix4(matrix));
  return box;
}

/**
 * Copies every visible tagged mesh of the live scene (see tags.ts). Untagged objects — outlines,
 * selection and collision volumes, docking ghosts, highlights, lights — are never part of a photo.
 */
export function takeSnapshot(root: Object3D): SceneSnapshot {
  root.updateMatrixWorld(true);
  const items: SnapshotItem[] = [];
  const materials = new Map<Material, MeshPhysicalMaterial>();
  let loading = 0;
  const bounds = new Box3();
  const furnitureBounds = new Box3();
  root.traverseVisible((object) => {
    if (!(object instanceof Mesh)) return;
    const tag = readPhotoTag(object.userData);
    if (!tag) return;
    if (tag.role === "loading") {
      loading++;
      return;
    }
    const source = Array.isArray(object.material) ? object.material[0] : object.material;
    if (!source) return;
    let material = materials.get(source);
    if (!material) {
      material = photoMaterial(tag.role, source);
      materials.set(source, material);
    }
    const geometry = (object.geometry as BufferGeometry).clone();
    const matrix = object.matrixWorld.clone();
    // Exact world bounds of the transformed vertices (a rotated part's local box would overestimate).
    const box = worldBox(geometry, matrix);
    bounds.union(box);
    if (FURNITURE_ROLES.has(tag.role)) furnitureBounds.union(box);
    items.push({ name: object.name, tag, geometry, matrix, material });
  });
  const owned = new Set<Texture>();
  return {
    items,
    loading,
    bounds,
    furnitureBounds,
    dispose() {
      for (const item of items) item.geometry.dispose();
      for (const material of materials.values()) {
        if (material.map && material.userData.ownsMap) owned.add(material.map);
        material.dispose();
      }
      owned.forEach((t) => t.dispose());
    },
  };
}

/**
 * Replaces the preview decor images by the full-resolution catalog images (same orientation —
 * grain normalized by sample_decor_swatches.py — and the same placement on the panel). A decor whose
 * HD image cannot be loaded keeps the preview image, so a photo never loses its decor.
 */
export async function applyHdDecors(snapshot: SceneSnapshot, load: (url: string) => Promise<Texture>): Promise<number> {
  const byFile = new Map<string, Promise<Texture | null>>();
  let upgraded = 0;
  const materials = new Set(snapshot.items.map((i) => i.material));
  for (const material of materials) {
    const decor = material.userData.decor as PhotoDecor | null | undefined;
    const base = material.map;
    if (!decor?.texture || !base) continue;
    let pending = byFile.get(decor.texture);
    if (!pending) {
      pending = load(`/textures/decors/hd/${decor.texture}`).then(
        (t) => t,
        () => null,
      );
      byFile.set(decor.texture, pending);
    }
    const hd = await pending;
    if (!hd) continue;
    const texture = hd.clone();
    texture.colorSpace = base.colorSpace;
    texture.wrapS = base.wrapS;
    texture.wrapT = base.wrapT;
    texture.repeat.copy(base.repeat);
    texture.offset.copy(base.offset);
    texture.rotation = base.rotation;
    texture.center.copy(base.center);
    texture.anisotropy = 8;
    texture.updateMatrix();
    texture.needsUpdate = true;
    material.map = texture;
    material.userData.ownsMap = true;
    material.needsUpdate = true;
    upgraded++;
  }
  return upgraded;
}

const NO_SHADOW_ROLES = new Set(["wall", "floor", "frame", "glass", "sill", "leaf", "handle"]);

/** Studio backdrop seen behind the cut-away room (no horizon, no distracting background). */
export const BACKDROP_COLOR = "#F2F1EE";

/**
 * The photo scene for one view: the snapshot without the walls (and their windows and doors) that the
 * camera stands behind, on a neutral backdrop, lit by the HDRI environment and a large soft area light
 * above the room (a ceiling softbox), which gives soft contact shadows.
 */
export function buildPhotoScene(
  snapshot: SceneSnapshot,
  hiddenWalls: readonly WallId[],
  environment: Texture | null,
  lighting: { environmentIntensity: number; areaIntensity: number } = { environmentIntensity: 0.85, areaIntensity: 3.2 },
): Scene {
  const scene = new Scene();
  scene.background = new Color(BACKDROP_COLOR);
  scene.environment = environment;
  scene.environmentIntensity = lighting.environmentIntensity;
  const hidden = new Set(hiddenWalls);
  for (const item of snapshot.items) {
    if (item.tag.wall && hidden.has(item.tag.wall)) continue;
    const mesh = new Mesh(item.geometry, item.material);
    mesh.name = item.name;
    mesh.matrixAutoUpdate = false;
    mesh.matrix.copy(item.matrix);
    // Window and door parts never cast shadows (as in the configurator); walls and floor receive only.
    mesh.castShadow = !NO_SHADOW_ROLES.has(item.tag.role);
    mesh.receiveShadow = true;
    mesh.userData.photo = item.tag;
    scene.add(mesh);
  }
  const size = snapshot.bounds.isEmpty() ? new Vector3(4, 2.6, 3.5) : snapshot.bounds.getSize(new Vector3());
  const center = snapshot.bounds.isEmpty() ? new Vector3(2, 1.3, 1.75) : snapshot.bounds.getCenter(new Vector3());
  const area = new RectAreaLight("#fffaf2", lighting.areaIntensity, Math.max(1, size.x * 0.7), Math.max(1, size.z * 0.7));
  area.name = "photo:softbox";
  area.position.set(center.x, center.y + size.y / 2 + 0.6, center.z + size.z * 0.15);
  area.lookAt(center.x, 0, center.z);
  scene.add(area);
  scene.updateMatrixWorld(true);
  return scene;
}
