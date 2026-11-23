"use client";

import { Edges, Line } from "@react-three/drei";
import type { ThreeEvent } from "@react-three/fiber";
import { useMemo } from "react";
import { FrontSide, Path, Shape, ShapeGeometry } from "three";
import { openingKeepFreeBox, wallFrame } from "@/domain/room/geometry";
import { WALL_IDS, type RoomConfiguration, type RoomOpening, type WallId } from "@/domain/room/types";
import { planBounds } from "@/domain/spatial/geometry";
import { useArrangementStore } from "@/store/useArrangementStore";
import { CLICK_TOLERANCE_PX } from "../PanelMesh";
import { showKeepFreeVolume } from "../debug";
import { STATUS_COLORS } from "../modules/furnitureStatus";
import { photoTag } from "../photo/tags";
import { mmToM } from "../units";

import {
  ACTIVE_WALL_COLOR,
  contrastColor,
  FRAME_EDGE_COLOR,
  openingOutline,
  openingParts,
  sceneOpenings,
  wallAngle,
  wallFloorBand,
  wallHighlightOutline,
  wallHighlights,
  type ScenePart,
} from "./roomScene";

const HIGHLIGHT = "#2563eb";

/**
 * A wall as a single inward-facing surface with holes for its openings. Its back face is culled, so
 * the camera always sees into the room through the walls on its side.
 */
function Wall({ room, wall, active, docking }: { room: RoomConfiguration; wall: WallId; active: boolean; docking: string | null }) {
  const frame = wallFrame(room, wall);
  const openings = room.openings.filter((o) => o.wall === wall);
  const geometry = useMemo(() => {
    const L = mmToM(frame.length);
    const H = mmToM(room.height);
    // Shape in wall coordinates: u along the wall from its left end, v up from the floor.
    const shape = new Shape();
    shape.moveTo(0, 0);
    shape.lineTo(L, 0);
    shape.lineTo(L, H);
    shape.lineTo(0, H);
    shape.lineTo(0, 0);
    for (const o of openings) {
      const hole = new Path();
      const u0 = mmToM(o.offset);
      const u1 = mmToM(o.offset + o.width);
      const v0 = mmToM(o.elevation);
      const v1 = mmToM(o.elevation + o.height);
      // A door reaching the floor cuts the wall's bottom edge; keep the hole a hair above it.
      const bottom = Math.max(v0, 0.0005);
      hole.moveTo(u0, bottom);
      hole.lineTo(u0, v1);
      hole.lineTo(u1, v1);
      hole.lineTo(u1, bottom);
      hole.lineTo(u0, bottom);
      shape.holes.push(hole);
    }
    return new ShapeGeometry(shape);
  }, [frame.length, room.height, openings]);

  // Shape X → along the wall, Y → up, Z (normal) → into the room.
  const angle = wallAngle(room, wall);
  return (
    <group position={[mmToM(frame.origin.x), 0, mmToM(frame.origin.z)]} rotation={[0, angle, 0]}>
      <mesh geometry={geometry} receiveShadow userData={photoTag("wall", wall)}>
        {/* The configured colour is never changed; selection is shown by the frame and the floor band. */}
        <meshStandardMaterial color={room.wallColors[wall]} roughness={0.95} side={FrontSide} />
      </mesh>
      {/* Reveal outline around every opening, in a colour contrasting with the wall. */}
      {openings.map((o) => (
        <Line
          key={o.id}
          points={openingOutline(o).map(([x, y, z]) => [x + mmToM(o.offset), y + mmToM(o.elevation), z] as [number, number, number])}
          color={contrastColor(room.wallColors[wall])}
          lineWidth={1.5}
          raycast={() => null}
        />
      ))}
      {active && !docking && (
        <Line points={wallHighlightOutline(room, wall)} color={ACTIVE_WALL_COLOR} lineWidth={4} raycast={() => null} />
      )}
      {/* The wall a wall-docking proposal mounts to (green; red when it is not possible). */}
      {docking && <Line points={wallHighlightOutline(room, wall)} color={docking} lineWidth={4} raycast={() => null} />}
    </group>
  );
}

/** Floor band along the active wall: a soft "shadow" that marks it from any camera angle. */
function ActiveWallBand({ room, wall }: { room: RoomConfiguration; wall: WallId }) {
  const { center, size } = wallFloorBand(room, wall);
  return (
    <mesh position={center as [number, number, number]} rotation={[-Math.PI / 2, 0, 0]} raycast={() => null}>
      <planeGeometry args={[size[0], size[1]]} />
      <meshBasicMaterial color={ACTIVE_WALL_COLOR} transparent opacity={0.22} depthWrite={false} />
    </mesh>
  );
}

function PartMesh({ part, wall }: { part: ScenePart; wall: WallId }) {
  return (
    <mesh
      position={part.center as [number, number, number]}
      scale={part.size as [number, number, number]}
      castShadow={part.castShadow}
      receiveShadow={part.receiveShadow}
      userData={photoTag(part.role, wall)}
    >
      <boxGeometry />
      <meshStandardMaterial color={part.color} roughness={0.5} transparent={part.opacity < 1} opacity={part.opacity} depthWrite={part.opacity === 1} />
      {part.role !== "glass" && part.role !== "handle" && <Edges color={FRAME_EDGE_COLOR} />}
    </mesh>
  );
}

/** Window (frame + glass) or door (frame + leaf in the door colour), placed in its wall opening. */
function Opening({ room, opening, selected }: { room: RoomConfiguration; opening: RoomOpening; selected: boolean }) {
  const select = useArrangementStore((s) => s.selectOpening);
  const openRoomPanel = useArrangementStore((s) => s.setRoomPanelOpen);
  const frame = wallFrame(room, opening.wall);
  const angle = wallAngle(room, opening.wall);
  const keepFree = planBounds(openingKeepFreeBox(room, opening));
  const parts = openingParts(opening).map((p) => <PartMesh key={p.key} part={p} wall={opening.wall} />);

  return (
    <>
      <group
        position={[mmToM(frame.origin.x + frame.along.x * opening.offset), mmToM(opening.elevation), mmToM(frame.origin.z + frame.along.z * opening.offset)]}
        rotation={[0, angle, 0]}
        onClick={(event: ThreeEvent<MouseEvent>) => {
          if (event.delta > CLICK_TOLERANCE_PX) return;
          event.stopPropagation();
          select(opening.id);
          openRoomPanel(true);
        }}
      >
        {parts}
      </group>
      {showKeepFreeVolume(selected) && (
        // The keep-free volume of the selected opening (opening + clearance): developer debugging only.
        <mesh
          position={[mmToM((keepFree.minX + keepFree.maxX) / 2), mmToM(opening.elevation + opening.height / 2), mmToM((keepFree.minZ + keepFree.maxZ) / 2)]}
          scale={[mmToM(keepFree.maxX - keepFree.minX), mmToM(opening.height), mmToM(keepFree.maxZ - keepFree.minZ)]}
          raycast={() => null}
        >
          <boxGeometry />
          <meshBasicMaterial color={HIGHLIGHT} transparent opacity={0.1} depthWrite={false} />
          <Edges color={HIGHLIGHT} />
        </mesh>
      )}
    </>
  );
}

export function RoomModel() {
  const room = useArrangementStore((s) => s.arrangement.room);
  const selectedOpeningId = useArrangementStore((s) => s.selectedOpeningId);
  const activeWall = useArrangementStore((s) => s.activeWall);
  const highlighted = wallHighlights(activeWall);
  const proposal = useArrangementStore((s) => s.dockingProposal);
  const dockingWall =
    proposal?.kind === "wall" ? { wall: proposal.wall, color: proposal.verdict === "invalid" ? STATUS_COLORS.collision : STATUS_COLORS.valid } : null;
  const W = mmToM(room.width);
  const D = mmToM(room.depth);
  return (
    <group>
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[W / 2, 0, D / 2]} receiveShadow userData={photoTag("floor")}>
        <planeGeometry args={[W, D]} />
        <meshStandardMaterial color={room.floorColor} roughness={0.9} />
      </mesh>
      {WALL_IDS.map((wall) => (
        <Wall key={wall} room={room} wall={wall} active={highlighted[wall]} docking={dockingWall?.wall === wall ? dockingWall.color : null} />
      ))}
      <ActiveWallBand room={room} wall={activeWall} />
      {sceneOpenings(room).map((o) => (
        <Opening key={o.id} room={room} opening={o} selected={o.id === selectedOpeningId} />
      ))}
    </group>
  );
}
