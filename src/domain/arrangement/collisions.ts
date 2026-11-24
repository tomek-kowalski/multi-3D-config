import type { ModuleId, ModuleInstance } from "../modules/types";
import { openingKeepFreeBox } from "../room/geometry";
import { openingSwingBoxes } from "../room/openingMotion";
import type { RoomConfiguration } from "../room/types";
import { boxesIntersect, type PlacedBox } from "../spatial/geometry";
import { placedCollisionBoxes, placedOperationEnvelope } from "./spatial";
import { insideRoom, meetsWallMounting } from "./wallContact";
import type { Arrangement } from "./types";

/**
 * - `static`: the module as currently shown (its displayed state).
 * - `operation`: the space a transforming module needs while it is opened or closed in normal use.
 */
export type CollisionPhase = "static" | "operation";

export type CollisionIssue =
  | { readonly kind: "outside-room"; readonly moduleId: ModuleId; readonly phase: CollisionPhase }
  | { readonly kind: "module"; readonly moduleId: ModuleId; readonly otherId: ModuleId; readonly phase: CollisionPhase }
  | { readonly kind: "opening"; readonly moduleId: ModuleId; readonly openingId: string; readonly phase: CollisionPhase }
  /** The product must be fixed to a wall, but its back does not stand against one. */
  | { readonly kind: "wall-mounting"; readonly moduleId: ModuleId; readonly phase: "static" };

const any = (a: readonly PlacedBox[], b: readonly PlacedBox[]) => a.some((x) => b.some((y) => boxesIntersect(x, y)));

interface ModuleVolumes {
  readonly module: ModuleInstance;
  readonly boxes: PlacedBox[];
  readonly envelope: PlacedBox[];
}

/**
 * Checks every module against the room boundaries, the openings (with their keep-free clearance) and
 * every other module, using the real dimensions and positions. A module below a window does not
 * collide with it unless it reaches into the window's height range. Transforming modules are also
 * checked with their operation envelope; an operation issue is only reported when the same pair does
 * not already collide statically.
 */
export function detectCollisions(arrangement: Arrangement): CollisionIssue[] {
  const { room } = arrangement;
  const volumes: ModuleVolumes[] = arrangement.modules.map((module) => ({
    module,
    boxes: placedCollisionBoxes(module),
    envelope: placedOperationEnvelope(module),
  }));
  const openingBoxes = room.openings.map((o) => ({ id: o.id, box: openingKeepFreeBox(room, o) }));
  // An open window or door also needs the space its leaves swing into.
  const openSwings = room.openings.filter((o) => o.open).map((o) => ({ id: o.id, boxes: openingSwingBoxes(room, o) }));
  const issues: CollisionIssue[] = [];

  for (const { module, boxes, envelope } of volumes) {
    // Wall penetration and room containment use the shared wall-contact geometry (src/domain/arrangement/wallContact.ts).
    const staticOutside = !insideRoom(room, boxes);
    if (staticOutside) issues.push({ kind: "outside-room", moduleId: module.id, phase: "static" });
    else if (!insideRoom(room, envelope)) issues.push({ kind: "outside-room", moduleId: module.id, phase: "operation" });
    if (!staticOutside && !meetsWallMounting(room, module)) issues.push({ kind: "wall-mounting", moduleId: module.id, phase: "static" });

    for (const opening of openingBoxes) {
      const swing = openSwings.find((s) => s.id === opening.id);
      if (any(boxes, [opening.box]) || (swing && any(boxes, swing.boxes)))
        issues.push({ kind: "opening", moduleId: module.id, openingId: opening.id, phase: "static" });
      else if (any(envelope, [opening.box]))
        issues.push({ kind: "opening", moduleId: module.id, openingId: opening.id, phase: "operation" });
    }
  }

  for (let i = 0; i < volumes.length; i++) {
    for (let j = i + 1; j < volumes.length; j++) {
      const a = volumes[i];
      const b = volumes[j];
      if (any(a.boxes, b.boxes)) {
        issues.push({ kind: "module", moduleId: a.module.id, otherId: b.module.id, phase: "static" });
        continue;
      }
      // Either module's swept space must stay clear of the other one (in any state it can be in).
      const aSpace = a.envelope.length ? a.envelope : a.boxes;
      const bSpace = b.envelope.length ? b.envelope : b.boxes;
      if ((a.envelope.length || b.envelope.length) && any(aSpace, bSpace)) {
        issues.push({ kind: "module", moduleId: a.module.id, otherId: b.module.id, phase: "operation" });
      }
    }
  }
  return issues;
}

/** Whether a candidate module fits: inside the room and clear of the other modules (static volumes). */
export function fitsAt(room: RoomConfiguration, others: readonly ModuleInstance[], candidate: ModuleInstance): boolean {
  const boxes = placedCollisionBoxes(candidate);
  if (!insideRoom(room, boxes)) return false;
  return others.every((o) => o.id === candidate.id || !any(boxes, placedCollisionBoxes(o)));
}

export function issuesForModule(issues: readonly CollisionIssue[], id: ModuleId): CollisionIssue[] {
  return issues.filter((i) => i.moduleId === id || (i.kind === "module" && i.otherId === id));
}

/** What prevents opening a window or door: furniture, another open window/door, or the room's walls. */
export type OpeningObstacle =
  | { readonly kind: "module"; readonly moduleId: ModuleId }
  | { readonly kind: "opening"; readonly openingId: string }
  | { readonly kind: "wall" };

/**
 * Obstacles in the space the opening's leaves would swing into (empty: it can be opened). Furniture
 * below a window sill does not block it: the sashes are checked at their own height.
 */
export function openingMotionObstacles(arrangement: Arrangement, openingId: string): OpeningObstacle[] {
  const { room } = arrangement;
  const opening = room.openings.find((o) => o.id === openingId);
  if (!opening) return [];
  const swing = openingSwingBoxes(room, opening);
  const obstacles: OpeningObstacle[] = [];
  for (const instance of arrangement.modules) {
    if (any(swing, placedCollisionBoxes(instance))) obstacles.push({ kind: "module", moduleId: instance.id });
  }
  for (const other of room.openings) {
    if (other.id === opening.id || !other.open) continue;
    if (any(swing, openingSwingBoxes(room, other))) obstacles.push({ kind: "opening", openingId: other.id });
  }
  if (!insideRoom(room, swing)) obstacles.push({ kind: "wall" });
  return obstacles;
}
