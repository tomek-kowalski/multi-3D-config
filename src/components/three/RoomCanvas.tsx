"use client";

import { OrbitControls } from "@react-three/drei";
import { Canvas, useThree } from "@react-three/fiber";
import { useEffect, useLayoutEffect, useMemo, useRef, type ComponentRef } from "react";
import { Box3, NeutralToneMapping, PerspectiveCamera, Vector3 } from "three";
import { detectCollisions } from "@/domain/arrangement/collisions";
import { placedCollisionBoxes } from "@/domain/arrangement/spatial";
import { planBounds } from "@/domain/spatial/geometry";
import { useArrangementStore } from "@/store/useArrangementStore";
import { useConfiguratorStore } from "@/store/useConfiguratorStore";
import { frameBox } from "./cameraFraming";
import { DOCKING_PREVIEW_ID, DockingPreview, ModuleObject } from "./modules/ModuleObject";
import { FurnitureOutlines } from "./modules/FurnitureOutlines";
import { collidingModules, furnitureStatuses } from "./modules/furnitureStatus";
import { RoomModel } from "./room/RoomModel";
import { WallLabelProjector } from "./room/WallLabels";
import { PhotoRenderer } from "./photo/PhotoRenderer";
import { mmToM } from "./units";

type OrbitControlsImpl = ComponentRef<typeof OrbitControls>;

const BACKGROUND_COLOR = "#ecebe8";
/** Looking from the front-right, above the room, into it (towards the back wall). */
const ROOM_VIEW_DIRECTION = new Vector3(0.45, 0.85, 1).normalize();

function ModulesLayer() {
  const arrangement = useArrangementStore((s) => s.arrangement);
  const selectedId = useArrangementStore((s) => s.selectedModuleId);
  const movingId = useArrangementStore((s) => s.draggingModuleId);
  const issues = useMemo(() => detectCollisions(arrangement), [arrangement]);
  const colliding = useMemo(() => collidingModules(issues), [issues]);
  const proposal = useArrangementStore((s) => s.dockingProposal);
  const statuses = useMemo(() => {
    // While a wall-mounted module is being positioned (dragged, or a wall-docking proposal is open),
    // its missing wall mounting is not flagged again: the proposal is the answer to it.
    const positioning = new Set([movingId, proposal?.kind === "wall" ? proposal.moduleId : null]);
    const shown = issues.filter((i) => !(i.kind === "wall-mounting" && positioning.has(i.moduleId)));
    const map = furnitureStatuses(arrangement.modules.map((m) => m.id), shown, selectedId, movingId);
    if (proposal) map.set(DOCKING_PREVIEW_ID, proposal.verdict === "invalid" ? "collision" : "valid");
    return map;
  }, [arrangement.modules, issues, selectedId, movingId, proposal]);
  return (
    <>
      {arrangement.modules.map((m) => (
        <ModuleObject key={m.id} module={m} selected={m.id === selectedId} colliding={colliding.has(m.id)} />
      ))}
      <DockingPreview />
      <FurnitureOutlines statuses={statuses} />
    </>
  );
}

/** Orbit controls; frames the room on start and on request, or the selected instance. */
function RoomCameraRig() {
  const controls = useRef<OrbitControlsImpl>(null);
  const get = useThree((s) => s.get);
  const room = useArrangementStore((s) => s.arrangement.room);
  const viewRequest = useArrangementStore((s) => s.viewRequest);

  const frame = (box: Box3, keepDirection: boolean) => {
    const state = get();
    const { camera, size } = state;
    const orbit = controls.current;
    if (!(camera instanceof PerspectiveCamera) || !orbit) return;
    camera.aspect = size.width / size.height;
    camera.updateProjectionMatrix();
    const current = camera.position.clone().sub(orbit.target);
    const direction = keepDirection && current.lengthSq() > 0 ? current : ROOM_VIEW_DIRECTION;
    const { position, target } = frameBox(camera, camera.aspect, box, direction);
    camera.position.copy(position);
    orbit.target.copy(target);
    orbit.update();
    state.invalidate();
  };

  const roomBox = () => new Box3(new Vector3(0, 0, 0), new Vector3(mmToM(room.width), mmToM(room.height), mmToM(room.depth)));

  const framed = useRef(false);
  useLayoutEffect(() => {
    if (framed.current) return;
    framed.current = true;
    frame(roomBox(), false);
  });

  const handled = useRef(viewRequest?.seq ?? 0);
  useEffect(() => {
    if (!viewRequest || viewRequest.seq === handled.current) return;
    handled.current = viewRequest.seq;
    const { arrangement, selectedModuleId } = useArrangementStore.getState();
    const instance = arrangement.modules.find((m) => m.id === selectedModuleId);
    if (viewRequest.kind === "selection" && instance) {
      const bounds = placedCollisionBoxes(instance).map(planBounds);
      const top = Math.max(...placedCollisionBoxes(instance).map((b) => b.yMax));
      const box = new Box3(
        new Vector3(mmToM(Math.min(...bounds.map((b) => b.minX))), mmToM(instance.placement.y), mmToM(Math.min(...bounds.map((b) => b.minZ)))),
        new Vector3(mmToM(Math.max(...bounds.map((b) => b.maxX))), mmToM(top), mmToM(Math.max(...bounds.map((b) => b.maxZ)))),
      );
      frame(box, true);
    } else {
      frame(roomBox(), false);
    }
  });

  return <OrbitControls ref={controls} makeDefault enableDamping minDistance={0.4} maxDistance={40} maxPolarAngle={Math.PI / 2 - 0.02} />;
}

/** The room scene: walls, floor, openings and every placed instance. */
export function RoomCanvas() {
  return (
    <Canvas
      shadows="percentage"
      frameloop="demand"
      dpr={[1, 2]}
      gl={{ toneMapping: NeutralToneMapping }}
      camera={{ fov: 40, near: 0.05, far: 200, position: [6, 6, 8] }}
      // Clicking empty space only clears the cabinet compartment selection; modules stay selected.
      onPointerMissed={() => useConfiguratorStore.getState().selectCompartment(null)}
      className="touch-none"
    >
      <color attach="background" args={[BACKGROUND_COLOR]} />
      <ambientLight intensity={1.3} />
      <hemisphereLight args={["#ffffff", "#d8d2c8", 0.6]} />
      <directionalLight position={[4, 8, 6]} intensity={2.2} castShadow shadow-mapSize={[2048, 2048]} shadow-bias={-0.0004} shadow-normalBias={0.02} shadow-camera-left={-8} shadow-camera-right={8} shadow-camera-top={8} shadow-camera-bottom={-8} shadow-camera-far={30} />
      <directionalLight position={[-4, 5, -3]} intensity={0.6} />
      <RoomModel />
      <WallLabelProjector />
      <PhotoRenderer />
      <ModulesLayer />
      <RoomCameraRig />
    </Canvas>
  );
}
