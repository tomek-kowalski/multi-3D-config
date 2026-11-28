"use client";

import { useGLTF } from "@react-three/drei";
import { useThree } from "@react-three/fiber";
import { useLayoutEffect, useMemo } from "react";
import { Mesh, PropertyBinding, type Material, type Object3D } from "three";
import type { BedConfiguration } from "@/domain/beds/bedType";
import { getBedModel } from "@/domain/beds/catalog";
import { BED_SLOT_FINISHES, bedDecorSelection, UNAVAILABLE_PREVIEW_HEX } from "@/domain/materials/bindings";
import type { MaterialSlotBinding, MeshMaterialBinding } from "@/domain/materials/contracts";
import { DECOR_SWATCH_COVERAGE_M } from "@/domain/materials/textures";
import { useMaterialRuntime } from "../materials/MaterialRuntime";
import { attachMaterialBinding, createSlotMaterials, detachMaterialBinding, type MaterialRuntime, type SlotMaterialSet } from "../materials/materialSlots";
import { photoTag, type PhotoRole } from "../photo/tags";

/** Neutral preview for decors the supplied catalog has no swatch for (the unavailable indicator). */
export const NO_SWATCH_COLOR = UNAVAILABLE_PREVIEW_HEX;
/** Real-world size covered by one decor swatch image (UVs are in metres; legacy assumption, see textures.ts). */
export const SWATCH_SIZE_M = DECOR_SWATCH_COVERAGE_M[0];

/** Material slot of the converted models → photo role (see convert-clickbed.mjs). */
const SLOT_ROLES: Readonly<Record<string, PhotoRole>> = { body: "board", front: "board", mattress: "fabric", hardware: "metal" };

/** The converter writes metre UVs (scripts/assets/uv.mjs); the decor's coverage gives the repeat. */
const BED_UV_MAPPING = { kind: "authored-uv0", uvUnits: "metres" } as const;

/** Body and front: the configured decor entries (exact catalog lookup, explicit unavailable state). */
export function bedDecorBinding(productId: number, configuration: Pick<BedConfiguration, "decorCategory" | "frontDecor" | "bodyDecor">): MeshMaterialBinding {
  const decor = (slotId: string, decorId: string): MaterialSlotBinding => ({
    slotId,
    selection: bedDecorSelection(productId, configuration.decorCategory, decorId),
    mapping: BED_UV_MAPPING,
    side: "front",
  });
  return { slots: [decor("front", configuration.frontDecor), decor("body", configuration.bodyDecor)], groups: [] };
}

/**
 * Mattress and mechanism: the materials authored in the model (their side and every unnamed property
 * kept) with a shared physical finish profile as a selective override. Their UV0 is the converter's
 * metre projection, so registered surface maps (ticking weave, brushed metal) apply at physical scale.
 */
export const BED_FIXED_BINDING: MeshMaterialBinding = {
  slots: [
    { slotId: "mattress", selection: { kind: "authored", overrides: { finishProfileId: BED_SLOT_FINISHES.mattress } }, mapping: BED_UV_MAPPING, side: "authored" },
    { slotId: "hardware", selection: { kind: "authored", overrides: { finishProfileId: BED_SLOT_FINISHES.hardware } }, mapping: BED_UV_MAPPING, side: "authored" },
  ],
  groups: [],
};

/** All four slots of one bed (decor slots + fixed slots). */
export function bedMaterialBinding(productId: number, configuration: Pick<BedConfiguration, "decorCategory" | "frontDecor" | "bodyDecor">): MeshMaterialBinding {
  return { slots: [...bedDecorBinding(productId, configuration).slots, ...BED_FIXED_BINDING.slots], groups: [] };
}

/**
 * Builds the materials of the binding's slots through the shared factory and installs them on every
 * mesh of those slots (other slots are untouched), recording each mesh's binding for photos. Returns
 * the set (dispose it to free materials and texture leases).
 */
export function applyBedMaterials(root: Object3D, sources: ReadonlyMap<string, Material>, binding: MeshMaterialBinding, runtime: MaterialRuntime): SlotMaterialSet {
  const authored = Object.fromEntries([...sources].map(([slot, material]) => [slot, material]));
  const set = createSlotMaterials(binding, runtime, authored);
  root.traverse((child) => {
    if (!(child instanceof Mesh)) return;
    const slotId = child.userData.slot as string | undefined;
    const instance = slotId ? set.bySlot.get(slotId) : undefined;
    const slot = binding.slots.find((s) => s.slotId === slotId);
    if (!instance || !slot) return;
    child.material = instance.material;
    attachMaterialBinding(child, { binding: { slots: [slot], groups: [] }, authored: { [slot.slotId]: sources.get(slot.slotId) ?? null } });
  });
  return set;
}

/** Forgets the photo bindings of the given slots' meshes. */
function detachSlots(root: Object3D, slots: readonly MaterialSlotBinding[]) {
  const ids = new Set(slots.map((s) => s.slotId));
  root.traverse((child) => {
    if (ids.has(child.userData.slot as string)) detachMaterialBinding(child);
  });
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
 * Clones a loaded bed model for one instance (own hierarchy, shadows, mattress hidden from the start, so
 * nothing is ever drawn with a mattress unless the configuration explicitly includes one) and records
 * each mesh's model slot. The authored materials (shared by every instance through the model cache) are
 * returned as `sources`; applyBedMaterials gives every instance its own factory-built materials before
 * the first frame, so decors never leak between beds and the cached model is never modified.
 */
export function prepareBedScene(scene: Object3D): { root: Object3D; sources: Map<string, Material> } {
  const root = scene.clone(true);
  const sources = new Map<string, Material>();
  root.traverse((child: Object3D) => {
    if (isMattressNode(child.name)) child.visible = false;
    if (!(child instanceof Mesh)) return;
    const source = child.material as Material;
    if (!sources.has(source.name)) sources.set(source.name, source);
    child.userData = { ...child.userData, slot: source.name, ...photoTag(SLOT_ROLES[source.name] ?? "metal") };
    child.castShadow = true;
    child.receiveShadow = true;
  });
  return { root, sources };
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
  const runtime = useMaterialRuntime();

  const { root, sources } = useMemo(() => prepareBedScene(scene), [scene]);
  const { decorCategory, frontDecor, bodyDecor } = configuration;

  // Mattress and mechanism: built once per model instance (a decor change does not rebuild them).
  useLayoutEffect(() => {
    const set = applyBedMaterials(root, sources, BED_FIXED_BINDING, runtime);
    let live = true;
    set.ready.then(() => live && invalidate());
    invalidate();
    return () => {
      live = false;
      detachSlots(root, BED_FIXED_BINDING.slots);
      set.dispose();
    };
  }, [root, sources, runtime, invalidate]);

  // Decors: installed before the next frame on every change (never a stale decor).
  useLayoutEffect(() => {
    const binding = bedDecorBinding(productId, { decorCategory, frontDecor, bodyDecor });
    const set = applyBedMaterials(root, sources, binding, runtime);
    let live = true;
    set.ready.then(() => live && invalidate());
    invalidate();
    return () => {
      live = false;
      detachSlots(root, binding.slots);
      set.dispose();
    };
  }, [root, sources, runtime, productId, decorCategory, frontDecor, bodyDecor, invalidate]);

  // Layout effect: applied before the browser paints, so a change never shows a stale frame.
  useLayoutEffect(() => {
    applyBedVisibility(root, state, configuration.mattress);
    invalidate();
  }, [root, state, configuration.mattress, invalidate]);

  return <primitive object={root} />;
}
