"use client";

import { Edges } from "@react-three/drei";
import type { ThreeEvent } from "@react-three/fiber";
import { useMemo } from "react";
import { FrontSide, Path, Shape, ShapeGeometry } from "three";
import { openingKeepFreeBox, wallFrame } from "@/domain/room/geometry";
import { WALL_IDS, type RoomConfiguration, type RoomOpening, type WallId } from "@/domain/room/types";
import { planBounds } from "@/domain/spatial/geometry";
import { useArrangementStore } from "@/store/useArrangementStore";
import { CLICK_TOLERANCE_PX } from "../PanelMesh";
import { mmToM } from "../units";

const FRAME_COLOR = "#E8E6E1";
const GLASS_COLOR = "#BFD9EA";
const FRAME_MM = 60;
const FRAME_DEPTH_MM = 80;
const HIGHLIGHT = "#2563eb";

/**
 * A wall as a single inward-facing surface with holes for its openings. Its back face is culled, so
 * the camera always sees into the room through the walls on its side.
 */
function Wall({ room, wall }: { room: RoomConfiguration; wall: WallId }) {
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
  const angle = Math.atan2(-frame.along.z, frame.along.x);
  return (
    <mesh
      geometry={geometry}
      position={[mmToM(frame.origin.x), 0, mmToM(frame.origin.z)]}
      rotation={[0, angle, 0]}
      receiveShadow
    >
      <meshStandardMaterial color={room.wallColors[wall]} roughness={0.95} side={FrontSide} />
    </mesh>
  );
}

function boxMesh(key: string, center: [number, number, number], size: [number, number, number], color: string, opacity = 1) {
  return (
    <mesh key={key} position={center} scale={size} castShadow={opacity === 1} receiveShadow>
      <boxGeometry />
      <meshStandardMaterial color={color} roughness={0.5} transparent={opacity < 1} opacity={opacity} />
    </mesh>
  );
}

/** Window (frame + glass) or door (frame + leaf in the door colour), placed in its wall opening. */
function Opening({ room, opening, selected }: { room: RoomConfiguration; opening: RoomOpening; selected: boolean }) {
  const select = useArrangementStore((s) => s.selectOpening);
  const setMenu = useArrangementStore((s) => s.setActiveMenu);
  const frame = wallFrame(room, opening.wall);
  const angle = Math.atan2(-frame.along.z, frame.along.x);
  const w = mmToM(opening.width);
  const h = mmToM(opening.height);
  const f = mmToM(FRAME_MM);
  const d = mmToM(FRAME_DEPTH_MM);
  const keepFree = planBounds(openingKeepFreeBox(room, opening));
  const parts =
    opening.kind === "window"
      ? [
          boxMesh("l", [f / 2, h / 2, 0], [f, h, d], FRAME_COLOR),
          boxMesh("r", [w - f / 2, h / 2, 0], [f, h, d], FRAME_COLOR),
          boxMesh("b", [w / 2, f / 2, 0], [w, f, d], FRAME_COLOR),
          boxMesh("t", [w / 2, h - f / 2, 0], [w, f, d], FRAME_COLOR),
          boxMesh("m", [w / 2, h / 2, 0], [f * 0.6, h, d * 0.8], FRAME_COLOR),
          boxMesh("g", [w / 2, h / 2, 0], [w - f, h - f, 0.006], GLASS_COLOR, 0.35),
        ]
      : [
          boxMesh("l", [f / 2, h / 2, 0], [f, h, d * 1.2], FRAME_COLOR),
          boxMesh("r", [w - f / 2, h / 2, 0], [f, h, d * 1.2], FRAME_COLOR),
          boxMesh("t", [w / 2, h - f / 2, 0], [w, f, d * 1.2], FRAME_COLOR),
          boxMesh("leaf", [w / 2, (h - f) / 2, 0], [w - 2 * f, h - f, 0.04], opening.color ?? "#FFFFFF"),
          boxMesh("handle", [w - f - 0.08, (h - f) * 0.48, 0.035], [0.12, 0.02, 0.02], "#8D9094"),
        ];

  return (
    <>
      <group
        position={[mmToM(frame.origin.x + frame.along.x * opening.offset), mmToM(opening.elevation), mmToM(frame.origin.z + frame.along.z * opening.offset)]}
        rotation={[0, angle, 0]}
        onClick={(event: ThreeEvent<MouseEvent>) => {
          if (event.delta > CLICK_TOLERANCE_PX) return;
          event.stopPropagation();
          select(opening.id);
          setMenu("space");
        }}
      >
        {parts}
      </group>
      {selected && (
        // The keep-free volume of the selected opening (opening + clearance).
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
  const W = mmToM(room.width);
  const D = mmToM(room.depth);
  return (
    <group>
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[W / 2, 0, D / 2]} receiveShadow>
        <planeGeometry args={[W, D]} />
        <meshStandardMaterial color={room.floorColor} roughness={0.9} />
      </mesh>
      {WALL_IDS.map((wall) => (
        <Wall key={wall} room={room} wall={wall} />
      ))}
      {room.openings.map((o) => (
        <Opening key={o.id} room={room} opening={o} selected={o.id === selectedOpeningId} />
      ))}
    </group>
  );
}
