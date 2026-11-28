"use client";

import type { ThreeElements, ThreeEvent } from "@react-three/fiber";
import { useEffect, useMemo } from "react";
import { BoxGeometry, CylinderGeometry, LatheGeometry, Vector2 } from "three";
import type { Vector3Mm } from "@/domain/geometry/types";
import { HANDLE_RULES } from "@/domain/hardware/catalog";
import type { HardwarePart } from "@/domain/hardware/geometry";
import { hardwareFinishSelection, REGISTERED } from "@/domain/materials/bindings";
import type { MaterialSelection } from "@/domain/materials/contracts";
import { partMapping, writeBoxMetreUvs, writeCylinderMetreUvs } from "./materials/physicalUv";
import { SlotMesh } from "./materials/SlotMesh";
import { CLICK_TOLERANCE_PX } from "./PanelMesh";
import { photoTag } from "./photo/tags";
import { mmToM } from "./units";

const ORIGIN: Vector3Mm = { x: 0, y: 0, z: 0 };
const RECESS = { kind: "registered", id: REGISTERED.recessShadow } as const;

type PartProps = Omit<ThreeElements["mesh"], "ref" | "material" | "geometry"> & { selection: MaterialSelection };

/**
 * A cylindrical hardware part with metre UV0 (u along its axis — the brushing/length direction — v
 * around it), so a registered finish map (brushed steel, knurling) lies at its physical scale.
 */
function MetalCylinder({ radiusTop, radiusBottom, height, segments, selection, ...props }: PartProps & { radiusTop: number; radiusBottom: number; height: number; segments: number }) {
  const geometry = useMemo(() => {
    const g = new CylinderGeometry(radiusTop, radiusBottom, height, segments);
    writeCylinderMetreUvs(g, height);
    return g;
  }, [radiusTop, radiusBottom, height, segments]);
  useEffect(() => () => geometry.dispose(), [geometry]);
  return <SlotMesh selection={selection} mapping={CYLINDER_MAPPING} geometry={geometry} {...props} />;
}

/**
 * Turned profile of a knob (radius, height above the front face), normalized to its diameter and
 * projection: a neck of half the diameter flaring to the full diameter, a rounded shoulder and a gently
 * domed face. Real knobs are turned like this; a flat-faced cylinder reflects a single direction and read
 * as a flat dot in photos. Exactly `diameter` wide and `projection` deep (HANDLE_RULES unchanged).
 */
export function knobProfile(diameter: number, projection: number): Vector2[] {
  const R = diameter / 2;
  const P = projection;
  const points: [number, number][] = [
    [R * 0.5, 0],
    [R * 0.5, P * 0.3],
    [R * 0.56, P * 0.42],
    [R * 0.72, P * 0.53],
    [R * 0.9, P * 0.61],
    [R, P * 0.7],
    [R, P * 0.8],
    [R * 0.97, P * 0.88],
    [R * 0.88, P * 0.945],
    [R * 0.7, P * 0.98],
    [R * 0.4, P * 0.995],
    [0, P],
  ];
  return points.map(([r, y]) => new Vector2(r, y));
}

/** A turned knob (lathe of knobProfile) with metre UV0 like the cylinders: u along the axis, v around. */
function MetalKnob({ diameter, projection, selection, ...props }: PartProps & { diameter: number; projection: number }) {
  const geometry = useMemo(() => {
    const g = new LatheGeometry(knobProfile(diameter, projection), 40);
    g.translate(0, -projection / 2, 0);
    writeCylinderMetreUvs(g, projection);
    return g;
  }, [diameter, projection]);
  useEffect(() => () => geometry.dispose(), [geometry]);
  return <SlotMesh selection={selection} mapping={CYLINDER_MAPPING} geometry={geometry} {...props} />;
}

/** A box part of real size with metre UV0 along its longest side. */
function HardwareBox({ size, selection, ...props }: PartProps & { size: readonly [number, number, number] }) {
  const [w, h, d] = size;
  const grain = w >= h ? "x" : "y";
  const geometry = useMemo(() => {
    const g = new BoxGeometry(w, h, d);
    writeBoxMetreUvs(g, [w, h, d], grain);
    return g;
  }, [w, h, d, grain]);
  useEffect(() => () => geometry.dispose(), [geometry]);
  return <SlotMesh selection={selection} mapping={partMapping("box", grain)} geometry={geometry} {...props} />;
}

const CYLINDER_MAPPING = partMapping("cylinder", "y");

interface HandleMeshProps {
  part: HardwarePart;
  /** Position of the parent group in domain millimetres (e.g. a hinge pivot). */
  origin?: Vector3Mm;
  onSelect?: () => void;
}

/**
 * Generic handle shapes, built in the handle's own frame (centre of its box on the front face,
 * +Z out of the front):
 * - knob: a turned knob (neck, flared body, rounded domed face; knobProfile);
 * - bar: a cylinder along the front edge on two cylindrical standoffs;
 * - recessed: a thin dark plate — a visual stand-in for a milled grip, not a real groove.
 * Finishes come from the universal material system (the part's hardware finish ID).
 */
export function HandleMesh({ part, origin = ORIGIN, onSelect }: HandleMeshProps) {
  const selection = hardwareFinishSelection(part.finish);
  const { position: p, dimensions: d } = part.box;
  const center: [number, number, number] = [
    mmToM(p.x + d.width / 2 - origin.x),
    mmToM(p.y + d.height / 2 - origin.y),
    mmToM(p.z - origin.z),
  ];
  const vertical = part.orientation === "vertical";

  const onClick = onSelect
    ? (event: ThreeEvent<MouseEvent>) => {
        if (event.delta > CLICK_TOLERANCE_PX) return;
        event.stopPropagation();
        onSelect();
      }
    : undefined;

  if (part.type === "knob") {
    const { diameter, projection } = HANDLE_RULES.knob;
    return (
      <MetalKnob
        diameter={mmToM(diameter)}
        projection={mmToM(projection)}
        selection={selection}
        position={[center[0], center[1], center[2] + mmToM(projection / 2)]}
        rotation-x={Math.PI / 2}
        castShadow
        onClick={onClick}
        userData={photoTag("metal")}
      />
    );
  }

  if (part.type === "bar") {
    const { length, diameter, projection } = HANDLE_RULES.bar;
    const standoff = projection - diameter / 2;
    const spacing = length * 0.8;
    return (
      <group position={center} onClick={onClick}>
        <MetalCylinder
          radiusTop={mmToM(diameter / 2)}
          radiusBottom={mmToM(diameter / 2)}
          height={mmToM(length)}
          segments={16}
          selection={selection}
          position-z={mmToM(standoff)}
          rotation-z={vertical ? 0 : Math.PI / 2}
          castShadow
          userData={photoTag("metal")}
        />
        {[-1, 1].map((sign) => (
          <MetalCylinder
            key={sign}
            radiusTop={mmToM(diameter / 3)}
            radiusBottom={mmToM(diameter / 3)}
            height={mmToM(standoff)}
            segments={12}
            selection={selection}
            position={[vertical ? 0 : mmToM((sign * spacing) / 2), vertical ? mmToM((sign * spacing) / 2) : 0, mmToM(standoff / 2)]}
            rotation-x={Math.PI / 2}
            castShadow
            userData={photoTag("metal")}
          />
        ))}
      </group>
    );
  }

  return (
    <HardwareBox
      size={[mmToM(d.width), mmToM(d.height), mmToM(d.depth)]}
      selection={RECESS}
      position={[center[0], center[1], center[2] + mmToM(d.depth / 2)]}
      onClick={onClick}
      userData={photoTag("dark")}
    />
  );
}
