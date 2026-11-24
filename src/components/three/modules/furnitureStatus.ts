import type { CollisionIssue } from "@/domain/arrangement/collisions";
import type { ModuleId } from "@/domain/modules/types";

/**
 * What the outline of a module shows, for every furniture type alike:
 * - collision (red): the module has a collision issue (another module, a wall, a window/door, the space
 *   a bed needs to unfold, a missing wall mounting); stays until the conflict is resolved;
 * - valid (green): the module is being moved and its current position is free;
 * - selected (blue): the module open in the menu;
 * - normal: no outline.
 * Precedence: collision > valid (while moving) > selected > normal.
 */
export type FurnitureStatus = "collision" | "valid" | "selected" | "normal";

export const STATUS_COLORS: Readonly<Record<Exclude<FurnitureStatus, "normal">, string>> = {
  selected: "#2563eb",
  valid: "#16a34a",
  collision: "#dc2626",
};

export function furnitureStatus(state: { colliding: boolean; moving: boolean; selected: boolean }): FurnitureStatus {
  if (state.colliding) return "collision";
  if (state.moving) return "valid";
  if (state.selected) return "selected";
  return "normal";
}

/** Modules involved in any collision issue (both sides of a module–module conflict). */
export function collidingModules(issues: readonly CollisionIssue[]): Set<ModuleId> {
  const ids = new Set<ModuleId>();
  for (const issue of issues) {
    ids.add(issue.moduleId);
    if (issue.kind === "module") ids.add(issue.otherId);
  }
  return ids;
}

/** The status of every module that has one (normal modules are left out). */
export function furnitureStatuses(
  moduleIds: readonly ModuleId[],
  issues: readonly CollisionIssue[],
  selectedId: ModuleId | null,
  movingId: ModuleId | null,
): Map<ModuleId, Exclude<FurnitureStatus, "normal">> {
  const colliding = collidingModules(issues);
  const statuses = new Map<ModuleId, Exclude<FurnitureStatus, "normal">>();
  for (const id of moduleIds) {
    const status = furnitureStatus({ colliding: colliding.has(id), moving: id === movingId, selected: id === selectedId });
    if (status !== "normal") statuses.set(id, status);
  }
  return statuses;
}

/**
 * Windows and doors use the same outlines, keyed `opening:<id>`: red while dragged to a position that
 * had to be corrected or when furniture conflicts with them, green while dragged freely, blue when
 * selected (only possible on the active wall).
 */
export function openingStatuses(
  openingIds: readonly string[],
  issues: readonly CollisionIssue[],
  selectedId: string | null,
  drag: { readonly id: string; readonly valid: boolean } | null,
): Map<string, Exclude<FurnitureStatus, "normal">> {
  const conflicting = new Set(issues.flatMap((i) => (i.kind === "opening" ? [i.openingId] : [])));
  const statuses = new Map<string, Exclude<FurnitureStatus, "normal">>();
  for (const id of openingIds) {
    const dragged = drag?.id === id;
    const status = furnitureStatus({ colliding: conflicting.has(id) || (dragged && !drag.valid), moving: dragged, selected: id === selectedId });
    if (status !== "normal") statuses.set(`opening:${id}`, status);
  }
  return statuses;
}
