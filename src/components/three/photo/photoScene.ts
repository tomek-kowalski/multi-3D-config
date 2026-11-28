import { Box3, Color, Mesh, RectAreaLight, Scene, Vector3, type BufferGeometry, type Camera, type Material, type Matrix4, type MeshPhysicalMaterial, type Object3D, type Texture } from "three";
import { materialRegistry } from "@/domain/materials";
import type { MaterialRegistry } from "@/domain/materials/contracts";
import type { WallId } from "@/domain/room/types";
import { PHOTO_CAPABILITIES, PHOTO_PROFILE } from "../materials/materialQuality";
import { bindingKey, createSlotMaterials, readMaterialBinding, type FrozenMaterialBinding, type SlotMaterialSet } from "../materials/materialSlots";
import type { TextureResources, TextureResourceStats } from "../materials/runtimeContracts";
import { createTextureResources } from "../materials/textureResources";
import { addWindowExteriors } from "./exterior";
import { applyPhotoRolePolicy, photoMaterial } from "./photoMaterials";
import { bakeDeformation, extractRange, isDeformed, renderedRanges } from "./snapshotGeometry";
import { readPhotoTag, type PhotoTag } from "./tags";

/** One mesh of the photo: an independent copy of what a tagged, visible mesh of the live scene draws. */
export interface SnapshotItem {
  readonly name: string;
  readonly tag: PhotoTag;
  readonly geometry: BufferGeometry;
  readonly matrix: Matrix4;
  readonly material: MeshPhysicalMaterial;
  /**
   * Set when the item is one drawn range of a mesh (a geometry group of a multi-material mesh, or a
   * draw-ranged part): its range and material index in the source mesh.
   */
  readonly group?: { readonly start: number; readonly count: number; readonly materialIndex: number };
}

/** Manufacturer appearances a photo could not show as authorized (shown with the result, never hidden). */
export interface AppearanceDiagnostics {
  /** Selected decors without an authorized swatch, e.g. "8361 SN": the image shows the neutral indicator. */
  readonly unavailable: readonly string[];
  /** Authorized images that could not be loaded (the decor's own mean colour is shown instead). */
  readonly failed: readonly string[];
  /** Geometry the live view would not draw as bound (missing material index, array without groups). */
  readonly geometry?: readonly string[];
}

export const NO_APPEARANCE_ISSUES: AppearanceDiagnostics = Object.freeze({ unavailable: [], failed: [] });

/**
 * The configured scene frozen at one moment: geometry, transforms and the material bindings (selection,
 * mapping, groups) are copied, so all photos of one request show exactly the same configuration even if
 * the customer keeps editing while it renders, and nothing in the live view is changed by rendering.
 * Materials are rebuilt by the shared factory from the frozen bindings, with their own textures in this
 * snapshot's resource scope (released by dispose()).
 */
export interface SceneSnapshot {
  readonly items: readonly SnapshotItem[];
  /** Models still loading (their placeholder is in the scene instead of the furniture). */
  readonly loading: number;
  /** Bounds of everything in the snapshot (drawn geometry only), metres. */
  readonly bounds: Box3;
  /** World-space bounds of the drawn furniture geometry only (empty when there is none). */
  readonly furnitureBounds: Box3;
  /** Resolves when every texture of every material is applied (or has definitively failed). */
  readonly ready: Promise<void>;
  diagnostics(): AppearanceDiagnostics;
  textureStats(): TextureResourceStats;
  dispose(): void;
}

const FURNITURE_ROLES = new Set(["board", "metal", "dark", "fabric"]);

/** World-space bounding box of the vertices a geometry draws under a matrix (exact for rotated parts). */
function worldBox(geometry: BufferGeometry, matrix: Matrix4): Box3 {
  const position = geometry.getAttribute("position");
  const index = geometry.index;
  const box = new Box3();
  const v = new Vector3();
  if (index) {
    for (let i = 0; i < index.count; i++) box.expandByPoint(v.fromBufferAttribute(position, index.getX(i)).applyMatrix4(matrix));
  } else {
    for (let i = 0; i < position.count; i++) box.expandByPoint(v.fromBufferAttribute(position, i).applyMatrix4(matrix));
  }
  return box;
}

export interface SnapshotOptions {
  readonly registry?: MaterialRegistry;
  /** Texture scope of the snapshot; by default a new one owned (and freed) by the snapshot. */
  readonly textures?: TextureResources;
}

function frozenKey(frozen: FrozenMaterialBinding, role: string): string {
  const authored = Object.entries(frozen.authored)
    .map(([slot, m]) => `${slot}:${m ? m.uuid : ""}`)
    .join(",");
  return `${role}|${bindingKey(frozen.binding)}|${authored}`;
}

/**
 * Copies what every visible tagged mesh of the live scene draws (see tags.ts and snapshotGeometry.ts):
 * the draw range, each geometry group with its own material, invisible materials skipped, deformed
 * (morphed/skinned) meshes baked as drawn. Untagged objects — outlines, selection and collision volumes,
 * docking ghosts, highlights, lights — are never part of a photo.
 *
 * Each drawn range of a multi-material or draw-ranged mesh becomes its own compact item: the installed
 * path tracer (three-gpu-pathtracer core/utils/mergeGeometries.js) merges one group per mesh over a
 * flattened material list and ignores a mesh's own groups, so this is how every group keeps its material
 * in both photo backends.
 */
export function takeSnapshot(root: Object3D, options: SnapshotOptions = {}): SceneSnapshot {
  root.updateMatrixWorld(true);
  const registry = options.registry ?? materialRegistry;
  const ownsTextures = !options.textures;
  const textures =
    options.textures ??
    createTextureResources({ budget: { maxResidentBytes: PHOTO_PROFILE.maxResidentTextureBytes, maxIdleBytes: PHOTO_PROFILE.maxIdleTextureBytes } });
  const runtime = { registry, capabilities: PHOTO_CAPABILITIES, quality: PHOTO_PROFILE, textures };
  const items: SnapshotItem[] = [];
  const geometryIssues: string[] = [];
  const legacy = new Map<string, MeshPhysicalMaterial>();
  const bound = new Map<string, { set: SlotMaterialSet; materials: MeshPhysicalMaterial[] }>();
  const legacyIds = new WeakMap<Material, number>();
  let nextLegacyId = 0;
  let loading = 0;
  const bounds = new Box3();
  const furnitureBounds = new Box3();
  const visit = (object: Object3D, visitor: (o: Object3D) => void) => {
    // Invisible subtrees and previews (e.g. a docking proposal not yet confirmed) are not part of a photo.
    if (!object.visible || object.userData.photoExclude) return;
    visitor(object);
    for (const child of object.children) visit(child, visitor);
  };
  const legacyMaterial = (role: PhotoTag["role"], source: Material) => {
    // Keyed by source AND role: the conversion depends on the role.
    let id = legacyIds.get(source);
    if (id === undefined) {
      id = nextLegacyId++;
      legacyIds.set(source, id);
    }
    const key = `${role}|${id}`;
    let material = legacy.get(key);
    if (!material) {
      material = photoMaterial(role, source);
      legacy.set(key, material);
    }
    return material;
  };
  visit(root, (object) => {
    if (!(object instanceof Mesh)) return;
    const tag = readPhotoTag(object.userData);
    if (!tag) return;
    if (tag.role === "loading") {
      loading++;
      return;
    }
    const live = object.material as Material | Material[];
    const { ranges, issues } = renderedRanges(object.geometry as BufferGeometry, live, object.name || object.uuid);
    geometryIssues.push(...issues);
    if (ranges.length === 0) return;
    // Photo materials in the live material order (array index = group materialIndex).
    let materials: MeshPhysicalMaterial[];
    const frozen = readMaterialBinding(object);
    if (frozen) {
      const key = frozenKey(frozen, tag.role);
      let entry = bound.get(key);
      if (!entry) {
        const set = createSlotMaterials(frozen.binding, runtime, frozen.authored);
        entry = { set, materials: set.materials.map((m) => applyPhotoRolePolicy(m as MeshPhysicalMaterial, tag.role)) };
        bound.set(key, entry);
      }
      materials = entry.materials;
    } else {
      materials = (Array.isArray(live) ? live : [live]).map((source) => (source ? legacyMaterial(tag.role, source) : (undefined as unknown as MeshPhysicalMaterial)));
    }
    const source = isDeformed(object) ? bakeDeformation(object) : (object.geometry as BufferGeometry);
    const matrix = object.matrixWorld.clone();
    for (const range of ranges) {
      const material = materials[range.materialIndex];
      if (!material) {
        geometryIssues.push(`${object.name || object.uuid}: no photo material for index ${range.materialIndex}`);
        continue;
      }
      const geometry = range.whole ? source.clone() : extractRange(source, range.start, range.count);
      if (range.whole) {
        geometry.morphAttributes = {};
        geometry.groups = [];
      }
      // Exact world bounds of the drawn vertices (a rotated part's local box would overestimate).
      const box = worldBox(geometry, matrix);
      bounds.union(box);
      if (FURNITURE_ROLES.has(tag.role)) furnitureBounds.union(box);
      items.push({
        name: range.whole ? object.name : `${object.name}#${range.materialIndex}@${range.start}`,
        tag,
        geometry,
        matrix,
        material,
        ...(range.whole ? {} : { group: { start: range.start, count: range.count, materialIndex: range.materialIndex } }),
      });
    }
    if (source !== object.geometry) source.dispose();
  });
  const sets = [...bound.values()].map((e) => e.set);
  const ready = Promise.all(sets.map((s) => s.ready)).then(() => undefined);
  return {
    items,
    loading,
    bounds,
    furnitureBounds,
    ready,
    diagnostics() {
      const unavailable = new Set<string>();
      const failed = new Set<string>();
      for (const set of sets) {
        for (const [slot, instance] of set.bySlot) {
          const label = set.resolved.get(slot)?.label ?? slot;
          if (instance.issues.includes("missing-authorized-swatch")) unavailable.add(label);
          if (instance.issues.includes("texture-load-failed")) failed.add(label);
        }
      }
      return {
        unavailable: [...unavailable].sort(),
        failed: [...failed].sort(),
        ...(geometryIssues.length > 0 ? { geometry: [...geometryIssues] } : {}),
      };
    },
    textureStats: () => textures.stats(),
    dispose() {
      for (const item of items) item.geometry.dispose();
      legacy.forEach((m) => m.dispose());
      sets.forEach((s) => s.dispose());
      if (ownsTextures) textures.dispose();
    },
  };
}

/** Distinct textures the materials of a scene reference (= path-tracer texture-array layers). */
export function sceneTextures(scene: Object3D): Set<Texture> {
  const textures = new Set<Texture>();
  scene.traverse((o) => {
    if (!(o instanceof Mesh)) return;
    for (const m of Array.isArray(o.material) ? o.material : [o.material]) {
      for (const value of Object.values(m as unknown as Record<string, unknown>)) {
        const t = value as (Texture & { isRenderTargetTexture?: boolean }) | null;
        if (t && t.isTexture && !t.isRenderTargetTexture) textures.add(t);
      }
    }
  });
  return textures;
}

// In photos a door leaf casts a shadow (the floor under its undercut is shaded; the walls cast shadows here
// too, so it never falls through its own wall); the other opening parts never do.
const NO_SHADOW_ROLES = new Set(["wall", "floor", "frame", "glass", "sill", "handle"]);

/** Default lighting of a photo scene (HDRI intensity and the ceiling softbox). */
export const PHOTO_SCENE_LIGHTING = { environmentIntensity: 0.85, areaIntensity: 3.2 } as const;

/** Studio backdrop seen behind the cut-away room (no horizon, no distracting background). */
export const BACKDROP_COLOR = "#F2F1EE";

/**
 * The photo scene for one view: the snapshot without the walls (and their windows and doors) that the
 * camera stands behind, on a neutral backdrop, lit by the HDRI environment and a large soft area light
 * above the room (a ceiling softbox), which gives soft contact shadows. With the view's camera, every
 * visible window shows a daytime exterior (exterior.ts) — only through its glazing.
 */
export function buildPhotoScene(
  snapshot: SceneSnapshot,
  hiddenWalls: readonly WallId[],
  environment: Texture | null,
  lighting: { environmentIntensity: number; areaIntensity: number } = PHOTO_SCENE_LIGHTING,
  camera: Camera | null = null,
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
    // Window and door parts cast no shadows except a door leaf (as in the configurator); walls and floor receive only.
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
  if (camera) addWindowExteriors(scene, camera);
  scene.updateMatrixWorld(true);
  return scene;
}
