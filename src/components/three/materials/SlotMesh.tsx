"use client";

import type { ThreeElements } from "@react-three/fiber";
import { useMemo, useRef } from "react";
import type { Mesh } from "three";
import type { MappingSpec, MaterialSelection, MeshMaterialBinding } from "@/domain/materials/contracts";
import { useMaterialSlots } from "./useMaterialSlots";

type MeshProps = Omit<ThreeElements["mesh"], "ref" | "material">;

/**
 * A single-material mesh whose material comes from the universal material system: any furniture,
 * room or accessory part declares its selection (and mapping, if it can carry textures) instead of
 * building a material itself.
 */
export function SlotMesh({
  selection,
  mapping,
  side = "front",
  slotId = "surface",
  ...props
}: MeshProps & { selection: MaterialSelection; mapping?: MappingSpec; side?: "front" | "double"; slotId?: string }) {
  const ref = useRef<Mesh>(null);
  const binding = useMemo<MeshMaterialBinding>(() => ({ slots: [{ slotId, selection, mapping, side }], groups: [] }), [slotId, selection, mapping, side]);
  useMaterialSlots(ref, binding);
  return <mesh ref={ref} {...props} />;
}
