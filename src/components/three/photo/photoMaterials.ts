import { Color, DoubleSide, FrontSide, MeshPhysicalMaterial, MeshStandardMaterial, type Material, type Texture } from "three";
import type { PhotoRole } from "./tags";

type Standardish = Material & {
  color?: Color;
  map?: Texture | null;
  roughness?: number;
  metalness?: number;
  userData: Record<string, unknown>;
};

const COPIED_MAPS = [
  "map",
  "normalMap",
  "roughnessMap",
  "metalnessMap",
  "aoMap",
  "emissiveMap",
  "alphaMap",
  "bumpMap",
  "clearcoatMap",
  "clearcoatNormalMap",
  "clearcoatRoughnessMap",
  "sheenColorMap",
  "sheenRoughnessMap",
  "specularIntensityMap",
  "specularColorMap",
  "transmissionMap",
  "thicknessMap",
] as const;

/**
 * Renderer compatibility policy of the photo scene, per role (applied to every photo material, bound or
 * legacy): walls and floor block light from both sides, so the room is lit through its open top.
 * Appearance (colour, finish, maps) is never changed here — it comes from the shared factory.
 */
export function applyPhotoRolePolicy(m: MeshPhysicalMaterial, role: PhotoRole): MeshPhysicalMaterial {
  m.userData = { ...m.userData, role };
  if (role === "wall" || role === "floor") m.side = DoubleSide;
  if (!(m.transmission > 0) && m.opacity >= 1) m.transparent = false;
  m.needsUpdate = true;
  return m;
}

/**
 * Legacy pass-through for a tagged mesh that has no material binding yet: a faithful physical copy of
 * its live material — colour, every supported map with its own transform and colour space, scalar and
 * physical fields (TR-02: normal/roughness/clear coat/sheen are no longer dropped) — plus the role policy.
 * Bound meshes (every current product, room part and accessory) never come here: their photo material
 * is built by the shared factory from the frozen binding (photoScene.ts).
 */
export function photoMaterial(role: PhotoRole, source: Material): MeshPhysicalMaterial {
  const s = source as Standardish & Partial<MeshPhysicalMaterial>;
  const m = new MeshPhysicalMaterial({ side: FrontSide });
  if ((s as MeshPhysicalMaterial).isMeshPhysicalMaterial) {
    m.copy(s as MeshPhysicalMaterial);
  } else if ((s as { isMeshStandardMaterial?: boolean }).isMeshStandardMaterial) {
    MeshStandardMaterial.prototype.copy.call(m, s as MeshStandardMaterial);
  } else {
    m.color = s.color ? s.color.clone() : new Color("#ffffff");
    for (const key of COPIED_MAPS) {
      const value = (s as unknown as Record<string, unknown>)[key];
      if (value) (m as unknown as Record<string, unknown>)[key] = value;
    }
    if (typeof s.roughness === "number") m.roughness = s.roughness;
    if (typeof s.metalness === "number") m.metalness = s.metalness;
  }
  m.name = `photo:${role}`;
  m.side = s.side === DoubleSide ? DoubleSide : FrontSide;
  m.opacity = 1;
  m.transparent = false;
  m.depthWrite = true;
  return applyPhotoRolePolicy(m, role);
}
