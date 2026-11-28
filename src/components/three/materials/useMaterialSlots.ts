"use client";

import { useThree } from "@react-three/fiber";
import { useLayoutEffect, type RefObject } from "react";
import type { Material, Mesh } from "three";
import type { MeshMaterialBinding, SlotId } from "@/domain/materials/contracts";
import { attachMaterialBinding, bindingKey, detachMaterialBinding, createSlotMaterials, installMaterials, type SlotMaterialSet } from "./materialSlots";
import { useMaterialRuntime } from "./MaterialRuntime";

const NO_AUTHORED: Readonly<Record<SlotId, Material | null>> = Object.freeze({});

/**
 * R3F lifecycle adapter: builds the mesh's materials through the shared factory whenever its binding
 * (selection, mapping, side) or the canvas runtime changes, installs them on the mesh before the next
 * frame, records the binding for photos and frees the replaced materials and texture leases. Created
 * in a layout effect (not during render), so React development remounts create and free exactly once
 * each, and a slow texture of a replaced selection can never land on the new material.
 */
export function useMaterialSlots(ref: RefObject<Mesh | null>, binding: MeshMaterialBinding, authored: Readonly<Record<SlotId, Material | null>> = NO_AUTHORED): void {
  const runtime = useMaterialRuntime();
  const invalidate = useThree((s) => s.invalidate);
  const key = bindingKey(binding);

  useLayoutEffect(() => {
    const mesh = ref.current;
    if (!mesh) return;
    const current = binding;
    const sources = authored;
    let set: SlotMaterialSet | null = createSlotMaterials(current, runtime, sources);
    installMaterials(mesh, set, current);
    const frozen = { binding: current, authored: sources };
    attachMaterialBinding(mesh, frozen);
    invalidate();
    set.ready.then(() => set && invalidate());
    return () => {
      detachMaterialBinding(mesh, frozen);
      set?.dispose();
      set = null;
    };
    // `key` identifies the binding's content; authored sources are immutable model data.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ref, key, runtime, invalidate]);
}
