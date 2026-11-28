"use client";

import { Edges } from "@react-three/drei";
import type { ThreeEvent } from "@react-three/fiber";
import { useEffect, useMemo, useRef } from "react";
import type { Mesh } from "three";
import type { PanelPart, PanelType, Vector3Mm } from "@/domain/geometry/types";
import { cabinetFinishSelection } from "@/domain/materials/bindings";
import type { MeshMaterialBinding } from "@/domain/materials/contracts";
import { getMaterialAppearance } from "./materialAppearance";
import { partMapping, patternOffsetM, unitBoxWithMetreUvs, type Axis } from "./materials/physicalUv";
import { useMaterialSlots } from "./materials/useMaterialSlots";
import { photoTag } from "./photo/tags";
import { mmToM } from "./units";

/** Pixels the pointer may travel between down and up and still count as a click (not an orbit drag). */
export const CLICK_TOLERANCE_PX = 4;

const ORIGIN: Vector3Mm = { x: 0, y: 0, z: 0 };

/**
 * Grain direction (texture u) of each part type, as boards are cut: sides, dividers, back panels and
 * doors run vertically; tops, bottoms, shelves, plinths and every drawer front horizontally (one
 * direction across a drawer bank); drawer box parts along their length. Independent of the part's
 * aspect ratio, so resizing never turns the grain.
 */
export const PANEL_GRAIN: Readonly<Record<PanelType, Axis>> = {
  "left-side": "y",
  "right-side": "y",
  divider: "y",
  "back-panel": "y",
  door: "y",
  top: "x",
  bottom: "x",
  shelf: "x",
  plinth: "x",
  "drawer-front": "x",
  "drawer-back": "x",
  "drawer-bottom": "x",
  "drawer-side": "z",
};

interface PanelMeshProps {
  panel: PanelPart;
  /** Position of the parent group in domain millimeters (e.g. a hinge pivot); defaults to the origin. */
  origin?: Vector3Mm;
  /** Makes the panel clickable (used for fronts); orbit drags are ignored. */
  onSelect?: () => void;
}

/**
 * Renders one panel as a unit box scaled to the panel's size (transforms, picking, collision and
 * motion are unchanged), with metre UV0 along the part's grain axis so any finish image keeps its
 * physical size. Its finish comes from the universal material system (slot "panel", the part's
 * existing finish ID).
 */
export function PanelMesh({ panel, origin = ORIGIN, onSelect }: PanelMeshProps) {
  const { dimensions: size, position: min } = panel;
  const ref = useRef<Mesh>(null);
  const grain = PANEL_GRAIN[panel.type];
  // Only a size change reallocates the 24-vertex box (UVs depend on the physical size).
  const phase = useMemo(() => patternOffsetM(panel.id), [panel.id]);
  const geometry = useMemo(
    () => unitBoxWithMetreUvs([mmToM(size.width), mmToM(size.height), mmToM(size.depth)], grain, phase),
    [size.width, size.height, size.depth, grain, phase],
  );
  useEffect(() => () => geometry.dispose(), [geometry]);
  const binding = useMemo<MeshMaterialBinding>(
    () => ({ slots: [{ slotId: "panel", selection: cabinetFinishSelection(panel.materialId), mapping: partMapping("box", grain, phase), side: "front" }], groups: [] }),
    [panel.materialId, grain, phase],
  );
  useMaterialSlots(ref, binding);
  const appearance = getMaterialAppearance(panel.materialId);

  return (
    <mesh
      ref={ref}
      name={panel.id}
      geometry={geometry}
      // The box is centered on its origin; domain positions are minimum corners.
      position={[
        mmToM(min.x + size.width / 2 - origin.x),
        mmToM(min.y + size.height / 2 - origin.y),
        mmToM(min.z + size.depth / 2 - origin.z),
      ]}
      scale={[mmToM(size.width), mmToM(size.height), mmToM(size.depth)]}
      castShadow
      receiveShadow
      userData={photoTag("board")}
      onClick={
        onSelect &&
        ((event: ThreeEvent<MouseEvent>) => {
          if (event.delta > CLICK_TOLERANCE_PX) return;
          // Stop here so the compartment hit region behind the front does not handle the click too.
          event.stopPropagation();
          onSelect();
        })
      }
    >
      <Edges color={appearance.edgeColor} />
    </mesh>
  );
}
