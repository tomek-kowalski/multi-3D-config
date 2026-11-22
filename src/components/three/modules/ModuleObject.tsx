"use client";

import { Edges } from "@react-three/drei";
import { useThree, type ThreeEvent } from "@react-three/fiber";
import { Suspense, useEffect } from "react";
import { Plane, Raycaster, Vector2, Vector3 } from "three";
import type { BoxMm } from "@/domain/compartments/types";
import { getFurnitureType } from "@/domain/modules/registry";
import type { ModuleInstance } from "@/domain/modules/types";
import { useArrangementStore } from "@/store/useArrangementStore";
import { CLICK_TOLERANCE_PX } from "../PanelMesh";
import { mmToM } from "../units";
import { getModuleRenderer } from "./moduleRenderers";

const SELECT_COLOR = "#2563eb";
const COLLISION_COLOR = "#dc2626";
const ENVELOPE_COLOR = "#f59e0b";
/** Drag positions snap to this grid (mm); exact values are typed in the menu. */
const DRAG_SNAP_MM = 10;

function VolumeBox({ box, color, opacity, edges = true }: { box: BoxMm; color: string; opacity: number; edges?: boolean }) {
  const { position: p, dimensions: d } = box;
  return (
    <mesh
      position={[mmToM(p.x + d.width / 2), mmToM(p.y + d.height / 2), mmToM(p.z + d.depth / 2)]}
      scale={[mmToM(d.width) + 0.004, mmToM(d.height) + 0.004, mmToM(d.depth) + 0.004]}
      raycast={() => null}
    >
      <boxGeometry />
      <meshBasicMaterial color={color} transparent opacity={opacity} depthWrite={false} />
      {edges && <Edges color={color} />}
    </mesh>
  );
}

const DOCKING_COLOR = "#059669";

/** Ghost of the proposed docking position: the moved module's volume at the proposed placement. */
export function DockingPreview() {
  const proposal = useArrangementStore((s) => s.dockingProposal);
  const docked = useArrangementStore((s) => s.arrangement.modules.find((m) => m.id === s.dockingProposal?.moduleId));
  if (!proposal || !docked) return null;
  const type = getFurnitureType(docked.typeId);
  const footprint = type.footprint(docked.configuration);
  const { placement } = proposal;
  return (
    <group
      position={[mmToM(placement.x), mmToM(placement.y), mmToM(placement.z)]}
      rotation={[0, (placement.rotationDeg * Math.PI) / 180, 0]}
    >
      <group position={[-mmToM(footprint.width) / 2, 0, -mmToM(footprint.depth) / 2]}>
        {type.collisionBoxes(docked.configuration, docked.state).map((b, i) => (
          <VolumeBox key={i} box={b} color={DOCKING_COLOR} opacity={0.22} />
        ))}
      </group>
    </group>
  );
}

/** Placeholder while a model loads. */
function LoadingBox({ box }: { box: BoxMm }) {
  return <VolumeBox box={box} color="#a8a29e" opacity={0.25} />;
}

/** The active drag, if any. Kept outside React: it only lives between pointer down and up. */
const drag: { moduleId: string | null; offsetX: number; offsetZ: number; startX: number; startY: number; moved: boolean } = {
  moduleId: null,
  offsetX: 0,
  offsetZ: 0,
  startX: 0,
  startY: 0,
  moved: false,
};

type ControlsLike = { enabled: boolean } | null;

/**
 * Moves the selected module while the pointer is down: intersects the pointer ray with the floor and
 * writes the new centre through the same `setPlacement` as the numeric inputs.
 */
function useDrag(instance: ModuleInstance) {
  const get = useThree((s) => s.get);
  const setPlacement = useArrangementStore((s) => s.setPlacement);
  const id = instance.id;

  useEffect(() => {
    const { gl } = get();
    const element = gl.domElement;
    const raycaster = new Raycaster();
    const plane = new Plane(new Vector3(0, 1, 0), 0);
    const hit = new Vector3();
    const ndc = new Vector2();
    const onMove = (event: PointerEvent) => {
      if (drag.moduleId !== id) return;
      if (!drag.moved && Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY) < CLICK_TOLERANCE_PX) return;
      drag.moved = true;
      const rect = element.getBoundingClientRect();
      ndc.set(((event.clientX - rect.left) / rect.width) * 2 - 1, -((event.clientY - rect.top) / rect.height) * 2 + 1);
      raycaster.setFromCamera(ndc, get().camera);
      const point = raycaster.ray.intersectPlane(plane, hit);
      if (!point) return;
      const snap = (v: number) => Math.round(v / DRAG_SNAP_MM) * DRAG_SNAP_MM;
      setPlacement(id, { x: snap(point.x * 1000 + drag.offsetX), z: snap(point.z * 1000 + drag.offsetZ) });
      get().invalidate();
    };
    const onUp = () => {
      if (drag.moduleId !== id) return;
      const moved = drag.moved;
      drag.moduleId = null;
      // A moved cabinet may now be next to another one: offer docking (applied only on confirmation).
      if (moved) useArrangementStore.getState().proposeDockingFor(id);
      const controls = get().controls as unknown as ControlsLike;
      if (controls) controls.enabled = true;
      element.style.cursor = "";
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
  }, [get, id, setPlacement]);

  return (event: ThreeEvent<PointerEvent>) => {
    if (event.button !== 0) return;
    event.stopPropagation();
    const point = event.ray.intersectPlane(new Plane(new Vector3(0, 1, 0), 0), new Vector3());
    if (!point) return;
    const { placement } = useArrangementStore.getState().arrangement.modules.find((m) => m.id === id) ?? instance;
    Object.assign(drag, {
      moduleId: id,
      offsetX: placement.x - point.x * 1000,
      offsetZ: placement.z - point.z * 1000,
      startX: event.nativeEvent.clientX,
      startY: event.nativeEvent.clientY,
      moved: false,
    });
    const { controls, gl } = get();
    if (controls) (controls as unknown as { enabled: boolean }).enabled = false;
    gl.domElement.style.cursor = "grabbing";
  };
}

/**
 * One placed module: positioned and rotated by its placement, drawn by its type's renderer, with
 * selection, collision and operation-envelope overlays. Click selects; dragging the selected module
 * moves it on the floor.
 */
export function ModuleObject({ module, selected, colliding }: { module: ModuleInstance; selected: boolean; colliding: boolean }) {
  const select = useArrangementStore((s) => s.selectModule);
  const setMenu = useArrangementStore((s) => s.setActiveMenu);
  const type = getFurnitureType(module.typeId);
  const footprint = type.footprint(module.configuration);
  const boxes = type.collisionBoxes(module.configuration, module.state);
  const envelope = type.operationEnvelope(module.configuration);
  const renderModule = getModuleRenderer(module.typeId);
  const startDrag = useDrag(module);

  return (
    <group
      position={[mmToM(module.placement.x), mmToM(module.placement.y), mmToM(module.placement.z)]}
      rotation={[0, (module.placement.rotationDeg * Math.PI) / 180, 0]}
      onClick={(event: ThreeEvent<MouseEvent>) => {
        if (event.delta > CLICK_TOLERANCE_PX) return;
        if (!selected) {
          event.stopPropagation();
          select(module.id);
          setMenu("module");
        }
      }}
      onPointerDown={selected ? startDrag : undefined}
    >
      <group position={[-mmToM(footprint.width) / 2, 0, -mmToM(footprint.depth) / 2]}>
        <Suspense fallback={<LoadingBox box={boxes[0]} />}>
          {renderModule({ module, editing: selected })}
        </Suspense>
        {selected && boxes.map((b, i) => <VolumeBox key={`s${i}`} box={b} color={SELECT_COLOR} opacity={0.04} />)}
        {colliding && boxes.map((b, i) => <VolumeBox key={`c${i}`} box={b} color={COLLISION_COLOR} opacity={0.12} />)}
        {selected && envelope?.map((b, i) => <VolumeBox key={`e${i}`} box={b} color={ENVELOPE_COLOR} opacity={0.05} />)}
      </group>
    </group>
  );
}
