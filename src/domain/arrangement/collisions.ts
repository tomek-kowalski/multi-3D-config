import type { ModuleId, ModuleInstance } from "../modules/types";
import { openingKeepFreeBox } from "../room/geometry";
import type { RoomConfiguration } from "../room/types";
import { boxesIntersect, boxInsideRoom, type PlacedBox } from "../spatial/geometry";
import { placedCollisionBoxes, placedOperationEnvelope } from "./spatial";
import type { Arrangement } from "./types";

/**
 * - `static`: the module as currently shown (its displayed state).
 * - `operation`: the space a transforming module needs while it is opened or closed in normal use.
 */
export type CollisionPhase = "static" | "operation";

export type CollisionIssue =
  | { readonly kind: "outside-room"; readonly moduleId: ModuleId; readonly phase: CollisionPhase }
  | { readonly kind: "module"; readonly moduleId: ModuleId; readonly otherId: ModuleId; readonly phase: CollisionPhase }
  | { readonly kind: "opening"; readonly moduleId: ModuleId; readonly openingId: string; readonly phase: CollisionPhase };

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
  const issues: CollisionIssue[] = [];

  for (const { module, boxes, envelope } of volumes) {
    const inside = (b: PlacedBox) => boxInsideRoom(b, room);
    const staticOutside = !boxes.every(inside);
    if (staticOutside) issues.push({ kind: "outside-room", moduleId: module.id, phase: "static" });
    else if (!envelope.every(inside)) issues.push({ kind: "outside-room", moduleId: module.id, phase: "operation" });

    for (const opening of openingBoxes) {
      if (any(boxes, [opening.box])) issues.push({ kind: "opening", moduleId: module.id, openingId: opening.id, phase: "static" });
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
  if (!boxes.every((b) => boxInsideRoom(b, room))) return false;
  return others.every((o) => o.id === candidate.id || !any(boxes, placedCollisionBoxes(o)));
}

export function issuesForModule(issues: readonly CollisionIssue[], id: ModuleId): CollisionIssue[] {
  return issues.filter((i) => i.moduleId === id || (i.kind === "module" && i.otherId === id));
}
