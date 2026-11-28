"use client";

import { Edges, Line } from "@react-three/drei";
import { useFrame, useThree, type ThreeEvent } from "@react-three/fiber";
import { useEffect, useMemo, useRef } from "react";
import { BufferAttribute, BufferGeometry, Path, Plane, PlaneGeometry, Raycaster, Shape, ShapeGeometry, Vector2, Vector3, type Group } from "three";
import {
  configuredColor,
  DOOR_LEAF_TEMPLATE,
  floorMaterialRegistryId,
  OPENING_FRAME_TEMPLATE,
  REGISTERED,
  ROOM_FLOOR_TEMPLATE,
  ROOM_WALL_TEMPLATE,
} from "@/domain/materials/bindings";
import type { MappingSpec, MaterialSelection } from "@/domain/materials/contracts";
import { openingKeepFreeBox, wallFrame } from "@/domain/room/geometry";
import { WALL_IDS, type RoomConfiguration, type RoomOpening, type WallId } from "@/domain/room/types";
import { planBounds } from "@/domain/spatial/geometry";
import { useArrangementStore } from "@/store/useArrangementStore";
import { CLICK_TOLERANCE_PX } from "../PanelMesh";
import { showKeepFreeVolume } from "../debug";
import { STATUS_COLORS } from "../modules/furnitureStatus";
import { partMapping, unitBoxWithMetreUvs, writeFloorMetreUvs, writeRoomFloorUvs } from "../materials/physicalUv";
import { SlotMesh } from "../materials/SlotMesh";
import { photoTag } from "../photo/tags";
import { mmToM } from "../units";

import {
  ACTIVE_WALL_COLOR,
  contrastColor,
  DOOR_FRAME_DEPTH_M,
  FRAME_EDGE_COLOR,
  openingOutline,
  leafRotation,
  openingScene,
  sceneOpenings,
  wallAngle,
  wallFloorBand,
  wallHighlightOutline,
  wallHighlights,
  type ScenePart,
} from "./roomScene";

const HIGHLIGHT = "#2563eb";

/** Wall UV0 is the wall shape itself: metres along the wall from its left end, and up from the floor. */
const WALL_MAPPING: MappingSpec = { kind: "projected-metres", originM: [0, 0, 0], uAxis: [1, 0, 0], vAxis: [0, 1, 0] };
/**
 * Floor UV0 in metres from the room's back-left corner (fixed when the room grows); u runs along the
 * floor material's plank axis (writeFloorMetreUvs).
 */
const FLOOR_MAPPING: Readonly<Record<"x" | "z", MappingSpec>> = {
  x: { kind: "projected-metres", originM: [0, 0, 0], uAxis: [1, 0, 0], vAxis: [0, 0, 1] },
  z: { kind: "projected-metres", originM: [0, 0, 0], uAxis: [0, 0, 1], vAxis: [-1, 0, 0] },
};

/** The floor's selection: the configured colour, or a registered floor material. */
function floorSelection(room: RoomConfiguration): { selection: MaterialSelection; plankAxis: "x" | "z" } {
  const floor = room.floor;
  if (floor?.kind === "material") return { selection: { kind: "registered", id: floorMaterialRegistryId(floor.materialId) }, plankAxis: floor.plankAxis };
  return { selection: configuredColor(ROOM_FLOOR_TEMPLATE, room.floorColor), plankAxis: "x" };
}

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
  useEffect(() => () => geometry.dispose(), [geometry]);

  // Shape X → along the wall, Y → up, Z (normal) → into the room.
  const angle = wallAngle(room, wall);
  return (
    <group position={[mmToM(frame.origin.x), 0, mmToM(frame.origin.z)]} rotation={[0, angle, 0]}>
      {/* The configured colour is never changed; selection is shown by the frame and the floor band. */}
      <SlotMesh
        geometry={geometry}
        receiveShadow
        userData={photoTag("wall", wall)}
        selection={configuredColor(ROOM_WALL_TEMPLATE, room.wallColors[wall])}
        mapping={WALL_MAPPING}
      />
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

/** Surface of each window/door part role: configured colours keep their value, glass and handles are registered. */
export function openingPartSelection(part: Pick<ScenePart, "role" | "color">): MaterialSelection {
  switch (part.role) {
    case "glass":
      return { kind: "registered", id: REGISTERED.glass };
    case "handle":
      return { kind: "registered", id: REGISTERED.doorHandle };
    case "leaf":
      return configuredColor(DOOR_LEAF_TEMPLATE, part.color);
    default:
      return configuredColor(OPENING_FRAME_TEMPLATE, part.color);
  }
}

function PartMesh({ part, wall }: { part: ScenePart; wall: WallId }) {
  const [sx, sy, sz] = part.size;
  // Metre UV0 along the part's longest side (unit box scaled to the part, as before).
  const grain = sx >= sy && sx >= sz ? "x" : sy >= sz ? "y" : "z";
  const geometry = useMemo(() => unitBoxWithMetreUvs([sx, sy, sz], grain), [sx, sy, sz, grain]);
  useEffect(() => () => geometry.dispose(), [geometry]);
  return (
    <SlotMesh
      geometry={geometry}
      mapping={partMapping("box", grain)}
      position={part.center as [number, number, number]}
      scale={part.size as [number, number, number]}
      castShadow={part.castShadow}
      receiveShadow={part.receiveShadow}
      userData={photoTag(part.role, wall)}
      selection={openingPartSelection(part)}
    >
      {part.role !== "glass" && part.role !== "handle" && <Edges color={FRAME_EDGE_COLOR} />}
    </SlotMesh>
  );
}

/** Wall-local snapping of a dragged window/door (mm). */
const OPENING_SNAP_MM = 10;
/** Seconds a leaf takes to open or close fully. */
const SWING_SECONDS = 0.6;

/** Outline id of a window/door (furniture outlines read `userData.moduleId`). */
export const openingOutlineId = (id: string) => `opening:${id}`;

/** The active window/door drag (outside React: it only lives between pointer down and up). */
const openingDrag: { id: string | null; grabU: number; grabV: number; startX: number; startY: number; moved: boolean } = {
  id: null,
  grabU: 0,
  grabV: 0,
  startX: 0,
  startY: 0,
  moved: false,
};

/** Position along the wall (mm from its left end) of a room point given in metres. */
function alongWall(f: ReturnType<typeof wallFrame>, x: number, z: number): number {
  return (x * 1000 - f.origin.x) * f.along.x + (z * 1000 - f.origin.z) * f.along.z;
}

/**
 * A window or door: a stationary frame and the leaves, which turn into the room about their hinges when
 * the opening is open (animated). On the active wall it can be selected, opened from its context menu
 * and dragged within the wall (windows along and up/down, doors along only — they stay on the floor),
 * with the same positioning assistance as the numeric inputs. On other walls a click makes that wall
 * active first.
 */
function Opening({ room, opening, selected, active }: { room: RoomConfiguration; opening: RoomOpening; selected: boolean; active: boolean }) {
  const get = useThree((s) => s.get);
  const invalidate = useThree((s) => s.invalidate);
  const frame = wallFrame(room, opening.wall);
  const angle = wallAngle(room, opening.wall);
  const keepFree = planBounds(openingKeepFreeBox(room, opening));
  const scene = useMemo(() => openingScene(opening), [opening]);
  const leafRefs = useRef<(Group | null)[]>([]);
  const progress = useRef<number | null>(null);
  const id = opening.id;

  useEffect(() => invalidate(), [opening.open, invalidate]);
  useFrame((_, delta) => {
    const target = opening.open ? 1 : 0;
    // A window/door loaded open starts open; later changes swing.
    if (progress.current === null) progress.current = target;
    if (progress.current !== target) {
      const step = Math.min(delta, 0.1) / SWING_SECONDS;
      progress.current = target > progress.current ? Math.min(target, progress.current + step) : Math.max(target, progress.current - step);
      invalidate();
    }
    const value = progress.current;
    scene.leaves.forEach((leaf, i) => {
      const group = leafRefs.current[i];
      if (group) group.rotation.y = leafRotation(leaf.direction, value);
    });
  });

  // Dragging in the wall plane (wall-local u along the wall, v up from the floor).
  useEffect(() => {
    const { gl } = get();
    const element = gl.domElement;
    const raycaster = new Raycaster();
    const ndc = new Vector2();
    const hit = new Vector3();
    const onMove = (event: PointerEvent) => {
      if (openingDrag.id !== id) return;
      if (!openingDrag.moved && Math.hypot(event.clientX - openingDrag.startX, event.clientY - openingDrag.startY) < CLICK_TOLERANCE_PX) return;
      openingDrag.moved = true;
      const store = useArrangementStore.getState();
      const current = store.arrangement.room.openings.find((o) => o.id === id);
      if (!current) return;
      const f = wallFrame(store.arrangement.room, current.wall);
      const rect = element.getBoundingClientRect();
      ndc.set(((event.clientX - rect.left) / rect.width) * 2 - 1, -((event.clientY - rect.top) / rect.height) * 2 + 1);
      raycaster.setFromCamera(ndc, get().camera);
      const plane = new Plane().setFromNormalAndCoplanarPoint(new Vector3(f.inward.x, 0, f.inward.z), new Vector3(mmToM(f.origin.x), 0, mmToM(f.origin.z)));
      const point = raycaster.ray.intersectPlane(plane, hit);
      if (!point) return;
      const snap = (x: number) => Math.round(x / OPENING_SNAP_MM) * OPENING_SNAP_MM;
      const offset = snap(alongWall(f, point.x, point.z) - openingDrag.grabU);
      // Doors stay on the floor: only windows move up and down.
      const elevation = current.kind === "door" ? current.elevation : snap(point.y * 1000 - openingDrag.grabV);
      const positioning = store.moveOpening(id, offset, elevation);
      if (positioning) {
        const previous = store.draggingOpening;
        // One explanation per situation: the hint changes only when the reason does.
        const same =
          previous?.id === id && previous.valid === positioning.valid && JSON.stringify(previous.reason) === JSON.stringify(positioning.reason);
        if (!same) store.setDraggingOpening({ id, valid: positioning.valid, reason: positioning.reason });
      }
      get().invalidate();
    };
    const onUp = () => {
      if (openingDrag.id !== id) return;
      openingDrag.id = null;
      useArrangementStore.getState().setDraggingOpening(null);
      const controls = get().controls as unknown as { enabled: boolean } | null;
      if (controls) controls.enabled = true;
      element.style.cursor = "";
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
  }, [get, id]);

  const onPointerDown = (event: ThreeEvent<PointerEvent>) => {
    if (event.button !== 0 || !active) return;
    event.stopPropagation();
    const store = useArrangementStore.getState();
    const current = store.arrangement.room.openings.find((o) => o.id === id);
    if (!current) return;
    const f = wallFrame(store.arrangement.room, current.wall);
    Object.assign(openingDrag, {
      id,
      grabU: alongWall(f, event.point.x, event.point.z) - current.offset,
      grabV: event.point.y * 1000 - current.elevation,
      startX: event.nativeEvent.clientX,
      startY: event.nativeEvent.clientY,
      moved: false,
    });
    const { controls, gl } = get();
    if (controls) (controls as unknown as { enabled: boolean }).enabled = false;
    gl.domElement.style.cursor = "grabbing";
  };

  return (
    <>
      <group
        position={[mmToM(frame.origin.x + frame.along.x * opening.offset), mmToM(opening.elevation), mmToM(frame.origin.z + frame.along.z * opening.offset)]}
        rotation={[0, angle, 0]}
        userData={{ moduleId: openingOutlineId(opening.id) }}
        onPointerDown={onPointerDown}
        onClick={(event: ThreeEvent<MouseEvent>) => {
          if (event.delta > CLICK_TOLERANCE_PX) return;
          event.stopPropagation();
          const store = useArrangementStore.getState();
          // Windows and doors are selectable on the active wall only; elsewhere the click activates the wall.
          if (!active) {
            store.setActiveWall(opening.wall);
            return;
          }
          // Selection only: the room menu ("Wymiary pomieszczenia") opens from the wall labels.
          store.selectOpening(opening.id);
        }}
        onContextMenu={(event: ThreeEvent<MouseEvent>) => {
          if (!active || event.delta > CLICK_TOLERANCE_PX) return;
          event.stopPropagation();
          event.nativeEvent.preventDefault();
          useArrangementStore.getState().openOpeningMenu(opening.id, event.nativeEvent.clientX, event.nativeEvent.clientY);
        }}
      >
        {scene.fixed.map((p) => (
          <PartMesh key={p.key} part={p} wall={opening.wall} />
        ))}
        {scene.leaves.map((leaf, i) => (
          <group
            key={leaf.id}
            ref={(g) => {
              leafRefs.current[i] = g;
            }}
            position={leaf.pivot as [number, number, number]}
            rotation={[0, leafRotation(leaf.direction, opening.open ? 1 : 0), 0]}
          >
            {leaf.parts.map((p) => (
              <PartMesh key={p.key} part={p} wall={opening.wall} />
            ))}
          </group>
        ))}
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

/**
 * The finished floor continuing through a doorway, from the wall line to the frame's outer face: what is
 * seen under the door leaf's undercut at low viewing angles. Same floor selection and room-space UVs as
 * the room floor (the pattern continues without a seam), and edge-adjacent to it — no overlap, no
 * offset. Hidden with its wall in photos taken from behind that wall.
 */
function DoorwayFloor({ room, opening, selection, plankAxis }: { room: RoomConfiguration; opening: RoomOpening; selection: MaterialSelection; plankAxis: "x" | "z" }) {
  const frame = wallFrame(room, opening.wall);
  const geometry = useMemo(() => {
    const out = DOOR_FRAME_DEPTH_M / 2;
    const at = (u: number, t: number): [number, number, number] => [
      mmToM(frame.origin.x + frame.along.x * u) - frame.inward.x * t,
      0,
      mmToM(frame.origin.z + frame.along.z * u) - frame.inward.z * t,
    ];
    const corners = [at(opening.offset, 0), at(opening.offset + opening.width, 0), at(opening.offset + opening.width, out), at(opening.offset, out)];
    const g = new BufferGeometry();
    g.setAttribute("position", new BufferAttribute(new Float32Array(corners.flat()), 3));
    // Wound so the face points up (+y) whatever the wall's orientation.
    const [a, b, c] = corners;
    const ny = (b[2] - a[2]) * (c[0] - a[0]) - (b[0] - a[0]) * (c[2] - a[2]);
    g.setIndex(ny > 0 ? [0, 1, 2, 0, 2, 3] : [0, 2, 1, 0, 3, 2]);
    g.computeVertexNormals();
    writeRoomFloorUvs(g, plankAxis);
    return g;
  }, [frame.origin.x, frame.origin.z, frame.along.x, frame.along.z, frame.inward.x, frame.inward.z, opening.offset, opening.width, plankAxis]);
  useEffect(() => () => geometry.dispose(), [geometry]);
  return (
    <SlotMesh
      geometry={geometry}
      receiveShadow
      userData={photoTag("floor", opening.wall)}
      selection={selection}
      mapping={FLOOR_MAPPING[plankAxis]}
      raycast={() => null}
    />
  );
}

export function RoomModel() {
  const room = useArrangementStore((s) => s.arrangement.room);
  const selectedOpeningId = useArrangementStore((s) => s.selectedOpeningId);
  const activeWall = useArrangementStore((s) => s.activeWall);
  // Highlighted only while the wall is the selection (not while furniture is selected).
  const wallSelected = useArrangementStore((s) => s.wallSelected);
  const highlighted = wallHighlights(wallSelected ? activeWall : null);
  const proposal = useArrangementStore((s) => s.dockingProposal);
  const dockingWall =
    proposal?.kind === "wall" ? { wall: proposal.wall, color: proposal.verdict === "invalid" ? STATUS_COLORS.collision : STATUS_COLORS.valid } : null;
  const W = mmToM(room.width);
  const D = mmToM(room.depth);
  const { selection: floorMaterial, plankAxis } = floorSelection(room);
  const floor = useMemo(() => {
    const geometry = new PlaneGeometry(W, D);
    writeFloorMetreUvs(geometry, W, D, plankAxis);
    return geometry;
  }, [W, D, plankAxis]);
  useEffect(() => () => floor.dispose(), [floor]);
  return (
    <group>
      <SlotMesh
        rotation={[-Math.PI / 2, 0, 0]}
        position={[W / 2, 0, D / 2]}
        geometry={floor}
        receiveShadow
        userData={photoTag("floor")}
        selection={floorMaterial}
        mapping={FLOOR_MAPPING[plankAxis]}
      />
      {sceneOpenings(room)
        .filter((o) => o.kind === "door" && o.elevation === 0)
        .map((o) => (
          <DoorwayFloor key={o.id} room={room} opening={o} selection={floorMaterial} plankAxis={plankAxis} />
        ))}
      {WALL_IDS.map((wall) => (
        <Wall key={wall} room={room} wall={wall} active={highlighted[wall]} docking={dockingWall?.wall === wall ? dockingWall.color : null} />
      ))}
      {wallSelected && <ActiveWallBand room={room} wall={activeWall} />}
      {sceneOpenings(room).map((o) => (
        <Opening key={o.id} room={room} opening={o} selected={o.id === selectedOpeningId} active={wallSelected && o.wall === activeWall} />
      ))}
    </group>
  );
}
