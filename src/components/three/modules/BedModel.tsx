"use client";

import { useGLTF } from "@react-three/drei";
import { useThree } from "@react-three/fiber";
import { useEffect, useLayoutEffect, useMemo } from "react";
import { Color, Mesh, PropertyBinding, MeshStandardMaterial, RepeatWrapping, SRGBColorSpace, TextureLoader, type Object3D, type Texture } from "three";
import type { BedConfiguration } from "@/domain/beds/bedType";
import { findDecor, getBedModel, getBedOptions, type BedDecor } from "@/domain/beds/catalog";
import { photoTag, type PhotoRole } from "../photo/tags";
import type { PhotoDecor } from "../photo/photoMaterials";

/** Neutral preview for decors the supplied catalog has no swatch for. */
export const NO_SWATCH_COLOR = "#B9B6B0";
/** Real-world size covered by one decor swatch image (UVs are in metres). */
export const SWATCH_SIZE_M = 0.6;

/** Material slot of the converted models → photo role (see convert-clickbed.mjs). */
const SLOT_ROLES: Readonly<Record<string, PhotoRole>> = { body: "board", front: "board", mattress: "fabric", hardware: "metal" };

const loader = new TextureLoader();
const textures = new Map<string, Texture>();

function decorTexture(file: string, invalidate: () => void): Texture {
  let texture = textures.get(file);
  if (!texture) {
    texture = loader.load(`/textures/decors/${file}`, invalidate);
    texture.colorSpace = SRGBColorSpace;
    texture.wrapS = RepeatWrapping;
    texture.wrapT = RepeatWrapping;
    texture.repeat.set(1 / SWATCH_SIZE_M, 1 / SWATCH_SIZE_M);
    textures.set(file, texture);
  }
  return texture;
}

function applyDecor(material: MeshStandardMaterial, decor: BedDecor | null, invalidate: () => void) {
  if (decor?.swatch) {
    material.map = decorTexture(decor.swatch.texture, invalidate);
    material.color = new Color("#FFFFFF");
  } else {
    material.map = null;
    material.color = new Color(NO_SWATCH_COLOR);
  }
  // Gloss finishes (MG/AG = Mirror/Acrylic Gloss) are shinier; metal decors slightly metallic.
  const gloss = decor && /^(MG|AG)$/.test(decor.structure);
  material.roughness = gloss ? 0.25 : 0.65;
  material.metalness = decor && decor.code.startsWith("AL") ? 0.35 : 0;
  // The photorealistic renderer reads the decor from here (HD texture, surface structure).
  const photo: PhotoDecor | null = decor?.swatch
    ? { texture: decor.swatch.texture, code: decor.code, structure: decor.structure, swatchSizeM: SWATCH_SIZE_M }
    : decor
      ? { texture: null, code: decor.code, structure: decor.structure, swatchSizeM: SWATCH_SIZE_M }
      : null;
  material.userData.decor = photo;
  material.needsUpdate = true;
}

/**
 * Mattress nodes as written by the converter ("<state>:mattress") and as named after loading:
 * three's GLTFLoader sanitizes node names (PropertyBinding.sanitizeNodeName strips ":"), so the loaded
 * scene calls them "unfoldedmattress". Both spellings are recognised.
 */
const MATTRESS_NODE_NAMES = new Set(
  ["folded:mattress", "unfolded:mattress"].flatMap((name) => [name, PropertyBinding.sanitizeNodeName(name)]),
);

export function isMattressNode(name: string): boolean {
  return MATTRESS_NODE_NAMES.has(name);
}

/**
 * Visibility of a named node of a converted bed model (see scripts/assets/convert-clickbed.mjs), or
 * null for nodes it does not control:
 * - the state nodes "folded" / "unfolded": only the displayed state is visible;
 * - "<state>:mattress": the mattress supplied in the model, shown only when the configuration includes
 *   the mattress. It is part of the state's node, so it moves with the bed between states. The folded
 *   models have no mattress geometry (it is enclosed behind the front), so nothing is drawn there.
 */
export function bedNodeVisible(name: string, state: string, mattress: boolean): boolean | null {
  if (name === "folded" || name === "unfolded") return name === state;
  if (isMattressNode(name)) return mattress;
  return null;
}

/**
 * Clones a loaded bed model for one instance: own materials (decors never leak between beds), shadows,
 * and every mattress embedded in the supplied model hidden from the start, so nothing is ever drawn
 * with a mattress unless the configuration explicitly includes one.
 */
export function prepareBedScene(scene: Object3D): { root: Object3D; materials: Map<string, MeshStandardMaterial> } {
  const root = scene.clone(true);
  const materials = new Map<string, MeshStandardMaterial>();
  root.traverse((child: Object3D) => {
    if (isMattressNode(child.name)) child.visible = false;
    if (!(child instanceof Mesh)) return;
    const source = child.material as MeshStandardMaterial;
    let material = materials.get(source.name);
    if (!material) {
      material = source.clone();
      materials.set(source.name, material);
    }
    child.material = material;
    child.userData = { ...child.userData, ...photoTag(SLOT_ROLES[source.name] ?? "metal") };
    child.castShadow = true;
    child.receiveShadow = true;
  });
  return { root, materials };
}

/** Applies the displayed state and the mattress selection to a prepared bed scene. */
export function applyBedVisibility(root: Object3D, state: string, mattress: boolean): void {
  root.traverse((child) => {
    const visible = bedNodeVisible(child.name, state, mattress);
    if (visible !== null) child.visible = visible;
  });
}

/**
 * One ClickBed, rendered from its converted asset (public/models/clickbed). The scene is cloned per
 * instance with its own materials, so beds never share decor or state. Origin: the carcass's
 * back-left-bottom corner, as in the domain.
 */
export function BedModel({ typeId, productId, configuration, state }: { typeId: string; productId: number; configuration: BedConfiguration; state: string }) {
  const model = getBedModel(typeId, configuration.size);
  const { scene } = useGLTF(`/models/clickbed/${model!.file}`);
  const invalidate = useThree((s) => s.invalidate);

  const { root, materials } = useMemo(() => prepareBedScene(scene), [scene]);

  useEffect(() => {
    const options = getBedOptions(productId);
    const front = materials.get("front");
    const body = materials.get("body");
    if (front) applyDecor(front, findDecor(options, configuration.decorCategory, configuration.frontDecor), invalidate);
    if (body) applyDecor(body, findDecor(options, configuration.decorCategory, configuration.bodyDecor), invalidate);
    invalidate();
  }, [materials, productId, configuration.decorCategory, configuration.frontDecor, configuration.bodyDecor, invalidate]);

  // Layout effect: applied before the browser paints, so a change never shows a stale frame.
  useLayoutEffect(() => {
    applyBedVisibility(root, state, configuration.mattress);
    invalidate();
  }, [root, state, configuration.mattress, invalidate]);

  useEffect(() => () => materials.forEach((m) => m.dispose()), [materials]);

  return <primitive object={root} />;
}
