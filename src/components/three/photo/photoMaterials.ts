import { Color, DoubleSide, FrontSide, MeshPhysicalMaterial, type Material, type Texture } from "three";
import type { PhotoRole } from "./tags";

/** Decor of a bed board, recorded on its live material by BedModel (userData.decor). */
export interface PhotoDecor {
  /** Swatch file in /textures/decors (and /textures/decors/hd); null when the catalog has no image. */
  readonly texture: string | null;
  readonly code: string;
  /** Surface structure code from the shop (e.g. SM, PW, MG = mirror gloss, AG = acrylic gloss). */
  readonly structure: string;
  /** Real-world size of one swatch image, metres. */
  readonly swatchSizeM: number;
}

/** Glass of windows and doors: clear, very slightly green-tinted float glass. */
export const GLASS_TINT = "#F3F8F6";

type Standardish = Material & {
  color?: Color;
  map?: Texture | null;
  roughness?: number;
  metalness?: number;
  userData: Record<string, unknown>;
};

export function isGlossDecor(decor: PhotoDecor | null): boolean {
  return !!decor && /^(MG|AG|HG|PG)$/.test(decor.structure);
}

export function isMetalDecor(decor: PhotoDecor | null): boolean {
  return !!decor && decor.code.startsWith("AL");
}

/**
 * The physically based material of one photo mesh, made from the live material at snapshot time.
 * Colours and decor images are copied exactly (the same sRGB colour, the same texture placement); only
 * the surface physics is added: gloss decors get a clear coat, metal decors metalness, mattresses a
 * fabric sheen, glass real transmission. `hdMap` replaces the preview decor image by the full-resolution
 * catalog image with the same orientation and placement.
 */
export function photoMaterial(role: PhotoRole, source: Material, hdMap: Texture | null = null): MeshPhysicalMaterial {
  const s = source as Standardish;
  const color = s.color ? s.color.clone() : new Color("#ffffff");
  const map = hdMap ?? s.map ?? null;
  const roughness = typeof s.roughness === "number" ? s.roughness : 0.6;
  const metalness = typeof s.metalness === "number" ? s.metalness : 0;
  const m = new MeshPhysicalMaterial({ color, map, roughness, metalness, side: FrontSide });
  m.name = `photo:${role}`;
  m.userData = { role };

  switch (role) {
    case "board": {
      const decor = (s.userData?.decor as PhotoDecor | null | undefined) ?? null;
      m.userData.decor = decor;
      if (isGlossDecor(decor)) {
        // High-gloss lacquer/acrylic: smooth clear coat over the decor.
        m.roughness = 0.12;
        m.clearcoat = 1;
        m.clearcoatRoughness = 0.04;
      } else if (isMetalDecor(decor)) {
        m.metalness = 0.75;
        m.roughness = 0.32;
      } else {
        // Melamine boards: matt to satin, with a thin specular layer.
        m.specularIntensity = 0.5;
      }
      break;
    }
    case "fabric":
      m.roughness = 1;
      m.metalness = 0;
      m.sheen = 0.7;
      m.sheenRoughness = 0.75;
      m.sheenColor = color.clone();
      break;
    case "metal":
    case "handle":
      m.metalness = Math.max(metalness, role === "handle" ? 0.9 : metalness);
      m.roughness = Math.min(roughness, 0.4);
      break;
    case "wall":
      // Matt emulsion paint; both sides block light, so the room is lit through its open top.
      m.roughness = 0.92;
      m.side = DoubleSide;
      break;
    case "floor":
      m.roughness = 0.7;
      m.side = DoubleSide;
      break;
    case "glass":
      m.color = new Color(GLASS_TINT);
      m.metalness = 0;
      m.roughness = 0;
      m.transmission = 1;
      m.ior = 1.5;
      m.thickness = 0.004;
      m.side = DoubleSide;
      break;
    case "frame":
    case "sill":
    case "leaf":
      m.roughness = 0.45;
      m.metalness = 0;
      break;
    case "dark":
    case "loading":
      break;
  }
  m.transparent = false;
  m.opacity = 1;
  m.needsUpdate = true;
  return m;
}
