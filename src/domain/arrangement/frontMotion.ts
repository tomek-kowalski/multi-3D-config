import { buildFurniture } from "../geometry/buildFurniture";
import type { PartMotion } from "../geometry/types";
import type { CabinetConfiguration } from "../furniture/types";
import { CABINET_TYPE_ID } from "../modules/cabinetType";
import { getFurnitureType } from "../modules/registry";
import type { ModuleId, ModuleInstance } from "../modules/types";
import { placeBox, type PlacedBox } from "../spatial/geometry";
import { boxesIntersect } from "../spatial/geometry";
import { openingKeepFreeBox } from "../room/geometry";
import { insideRoom } from "./wallContact";
import { placedCollisionBoxes } from "./spatial";
import type { Arrangement } from "./types";

/**
 * The room-level space a cabinet's doors and drawers sweep while opening (the cabinet's own internal
 * limits — doors against doors or drawers — are handled by src/domain/attachments/collisions.ts). Each
 * front is swept through its real motion: hinged leaves sampled up to their maximum angle around their
 * pivot, drawers along their full travel. The result is in the module's local frame (millimetres,
 * origin at the footprint's back-left corner, front towards +Z), one box per front.
 */
export interface FrontSweep {
  readonly attachmentId: string;
  readonly box: { readonly position: { x: number; y: number; z: number }; readonly dimensions: { width: number; height: number; depth: number } };
}

const STEP_DEG = 5;

export function cabinetFrontSweeps(configuration: CabinetConfiguration): FrontSweep[] {
  const model = buildFurniture(configuration);
  const groups = new Map<string, { attachmentId: string; motion: PartMotion; boxes: { x0: number; x1: number; y0: number; y1: number; z0: number; z1: number }[] }>();
  for (const part of [...model.panels, ...model.hardware]) {
    if (!part.motion || !part.attachmentId) continue;
    const p = "box" in part ? part.box.position : part.position;
    const d = "box" in part ? part.box.dimensions : part.dimensions;
    const entry = groups.get(part.motion.groupId) ?? { attachmentId: part.attachmentId, motion: part.motion, boxes: [] };
    entry.boxes.push({ x0: p.x, x1: p.x + d.width, y0: p.y, y1: p.y + d.height, z0: p.z, z1: p.z + d.depth });
    groups.set(part.motion.groupId, entry);
  }
  const sweeps: FrontSweep[] = [];
  for (const { attachmentId, motion, boxes } of groups.values()) {
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    const y0 = Math.min(...boxes.map((b) => b.y0));
    const y1 = Math.max(...boxes.map((b) => b.y1));
    const corners = boxes.flatMap((b) => [
      { x: b.x0, z: b.z0 },
      { x: b.x1, z: b.z0 },
      { x: b.x1, z: b.z1 },
      { x: b.x0, z: b.z1 },
    ]);
    const include = (x: number, z: number) => {
      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x);
      minZ = Math.min(minZ, z);
      maxZ = Math.max(maxZ, z);
    };
    if (motion.kind === "hinge") {
      for (let angle = 0; ; angle = Math.min(motion.maxAngleDeg, angle + STEP_DEG)) {
        const theta = (motion.direction * angle * Math.PI) / 180;
        const cos = Math.cos(theta);
        const sin = Math.sin(theta);
        for (const { x, z } of corners) {
          const dx = x - motion.pivot.x;
          const dz = z - motion.pivot.z;
          include(motion.pivot.x + dx * cos + dz * sin, motion.pivot.z - dx * sin + dz * cos);
        }
        if (angle >= motion.maxAngleDeg) break;
      }
    } else {
      for (const { x, z } of corners) {
        include(x, z);
        include(x, z + motion.distance);
      }
    }
    // Only the space in front of the front's closed position counts in the room: behind it is the
    // cabinet itself (a leaf opened beyond 90° turns back there next to the hinge, which the cabinet's
    // own motion limits handle, not the neighbouring furniture).
    const closedZ = Math.min(...boxes.map((b) => b.z0));
    const z0 = Math.max(minZ, closedZ);
    sweeps.push({
      attachmentId,
      box: { position: { x: minX, y: y0, z: z0 }, dimensions: { width: maxX - minX, height: y1 - y0, depth: Math.max(0, maxZ - z0) } },
    });
  }
  return sweeps;
}

/** What blocks one front while opening: furniture, a window/door (its keep-free space) or the room's walls. */
export type FrontObstacle = { readonly kind: "module"; readonly moduleId: ModuleId } | { readonly kind: "opening"; readonly openingId: string } | { readonly kind: "wall" };

export interface FrontCheck {
  readonly attachmentId: string;
  readonly obstacles: readonly FrontObstacle[];
}

/** Whether the module has fronts that open (doors, drawers). */
export function movableFronts(module: ModuleInstance): string[] {
  if (module.typeId !== CABINET_TYPE_ID) return [];
  return (module.configuration as CabinetConfiguration).attachments.map((a) => a.id);
}

/** Every front of a placed cabinet with what would block it when opened (empty: it opens freely). */
export function checkFrontMotion(arrangement: Arrangement, moduleId: ModuleId): FrontCheck[] {
  const module_ = arrangement.modules.find((m) => m.id === moduleId);
  if (!module_ || module_.typeId !== CABINET_TYPE_ID) return [];
  const footprint = getFurnitureType(module_.typeId).footprint(module_.configuration);
  const others = arrangement.modules.filter((m) => m.id !== moduleId).map((m) => ({ id: m.id, boxes: placedCollisionBoxes(m) }));
  const openings = arrangement.room.openings.map((o) => ({ id: o.id, box: openingKeepFreeBox(arrangement.room, o) }));
  return cabinetFrontSweeps(module_.configuration as CabinetConfiguration).map(({ attachmentId, box }) => {
    const placed: PlacedBox = placeBox(box, module_.placement, footprint);
    const obstacles: FrontObstacle[] = [];
    for (const other of others) if (other.boxes.some((b) => boxesIntersect(placed, b))) obstacles.push({ kind: "module", moduleId: other.id });
    for (const opening of openings) if (boxesIntersect(placed, opening.box)) obstacles.push({ kind: "opening", openingId: opening.id });
    if (!insideRoom(arrangement.room, [placed])) obstacles.push({ kind: "wall" });
    return { attachmentId, obstacles };
  });
}
