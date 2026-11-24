import { create } from "zustand";
import { proposeDocking, type DockingProposal } from "@/domain/arrangement/docking";
import { detectCollisions, openingMotionObstacles } from "@/domain/arrangement/collisions";
import { checkFrontMotion, movableFronts } from "@/domain/arrangement/frontMotion";
import { assistOpeningPosition, type OpeningPositioning } from "@/domain/room/openingMotion";
import { usePreviewStore } from "./usePreviewStore";

/** The right-click menu: of a furniture module or of a window/door (screen position in CSS pixels). */
export type ContextMenuState =
  | { readonly kind: "module"; readonly moduleId: ModuleId; readonly x: number; readonly y: number }
  | { readonly kind: "opening"; readonly openingId: string; readonly x: number; readonly y: number };

export interface OpeningDrag {
  readonly id: string;
  /** The requested position was valid (green); otherwise the nearest valid one is used (red, with the reason). */
  readonly valid: boolean;
  readonly reason: OpeningPositioning["reason"];
}
import { proposeWallDocking, requiresWallMounting, type WallDockingProposal } from "@/domain/arrangement/wallDocking";

export type AnyDockingProposal = DockingProposal | WallDockingProposal;

/**
 * The one docking proposal to show for a moved module. Furniture docking for every module; for
 * wall-mounted furniture also wall docking — a dockable furniture position wins (it keeps the backs on
 * the wall the neighbour stands against), otherwise the wall position; impossible positions are shown
 * only to explain why, the wall's first. The proposal shown so far is kept while it stays valid.
 */
export function chooseDocking(arrangement: Arrangement, id: ModuleId, shown: AnyDockingProposal | null): AnyDockingProposal | null {
  const own = shown && shown.moduleId === id ? shown : null;
  const furniture = proposeDocking(arrangement, id, own?.kind === "module" ? { targetId: own.targetId, side: own.side } : null);
  const instance = arrangement.modules.find((m) => m.id === id);
  if (!instance || !requiresWallMounting(instance)) return furniture;
  const wall = proposeWallDocking(arrangement, id, { previousWall: own?.kind === "wall" ? own.wall : null });
  const usable = (p: AnyDockingProposal | null) => p !== null && p.verdict !== "invalid";
  if (usable(furniture)) return furniture;
  if (usable(wall)) return wall;
  return wall ?? furniture;
}
import * as ops from "@/domain/arrangement/operations";
import type { Arrangement, Side } from "@/domain/arrangement/types";
import type { FurnitureTypeId, ModuleId, OperationalStateId } from "@/domain/modules/types";
import { DEFAULT_ROOM } from "@/domain/room/defaults";
import * as roomOps from "@/domain/room/operations";
import type { HexColor, OpeningKind, RoomConfiguration, RoomDimensionKey, WallId } from "@/domain/room/types";
import { exportArrangementJson, importArrangementJson } from "@/domain/serialization/arrangementJson";
import type { Issue, Result } from "@/domain/shared/issues";
import type { Placement } from "@/domain/spatial/geometry";

export type ActionResult = { readonly ok: true } | { readonly ok: false; readonly issues: readonly Issue[] };

/**
 * The main menus: A the furniture arrangement, B the selected module. The room (space) settings live
 * in the room panel opened from the 3D view (`roomPanelOpen`).
 */
export type MenuId = "arrangement" | "module";

export interface ViewRequest {
  readonly kind: "room" | "selection";
  readonly seq: number;
}

export interface ArrangementState {
  /** The committed arrangement; always valid. */
  readonly arrangement: Arrangement;
  readonly selectedModuleId: ModuleId | null;
  readonly selectedOpeningId: string | null;
  /** The wall the customer is working on (the room menu's wall; its windows and doors are editable). */
  readonly activeWall: WallId;
  /**
   * Whether the active wall is the current selection (highlighted in 3D). One item is selected at a
   * time: selecting furniture deselects the wall (and its window/door) until a wall is selected again;
   * selecting a wall or one of its windows/doors deselects the furniture.
   */
  readonly wallSelected: boolean;
  /** Whether the wall identifiers are shown in the 3D view (display only). */
  readonly showWallLabels: boolean;
  /** Whether cabinets moved next to another cabinet get a docking proposal. */
  readonly dockingEnabled: boolean;
  /** A docking position waiting for the customer's confirmation (preview in 3D). */
  /** A docking position waiting for the customer's confirmation: next to another module, or against a wall. */
  readonly dockingProposal: AnyDockingProposal | null;
  /**
   * The module being dragged in the 3D view (null when nothing is): its placement is shown live (green
   * when valid, red on a collision) and the docking proposal is previewed but only asked for on drop.
   */
  readonly draggingModuleId: ModuleId | null;
  readonly activeMenu: MenuId;
  /** Whether the room panel ("Wymiary pomieszczenia": dimensions, walls, openings) is open. */
  readonly roomPanelOpen: boolean;
  /** Main menu collapsed to its header (display only: the 3D view gets the space; nothing else changes). */
  readonly menuCollapsed: boolean;
  /** Right-click menu of a furniture module (screen position in CSS pixels). */
  readonly contextMenu: ContextMenuState | null;
  /** A window or door being dragged in the 3D view, and whether the requested position is valid. */
  readonly draggingOpening: OpeningDrag | null;
  /** Result of an action that could not be carried out (shown briefly in the 3D view). */
  readonly notice: readonly Issue[] | null;
  readonly viewRequest: ViewRequest | null;
  /** True once the saved arrangement (if any) was loaded on the client. */
  readonly hydrated: boolean;

  setRoomDimension: (key: RoomDimensionKey, value: number) => ActionResult;
  setWallColor: (wall: WallId, color: HexColor) => ActionResult;
  setFloorColor: (color: HexColor) => ActionResult;
  addOpening: (kind: OpeningKind, wall: WallId) => ActionResult;
  updateOpening: (id: string, patch: roomOps.OpeningPatch) => ActionResult;
  removeOpening: (id: string) => ActionResult;
  selectOpening: (id: string | null) => void;
  setActiveWall: (wall: WallId) => void;
  setShowWallLabels: (show: boolean) => void;
  setDockingEnabled: (enabled: boolean) => void;
  /** Looks for a docking position for the module (after it was moved); shows it for confirmation. */
  proposeDockingFor: (id: ModuleId) => void;
  /** The customer asks to dock the module to a wall (wall-mounted furniture): any wall, however far. */
  requestWallDocking: (id: ModuleId) => void;
  /** Starts/ends a drag of a module in the 3D view. */
  setDragging: (id: ModuleId | null) => void;
  /** Applies the proposed position (re-checked first). */
  confirmDocking: () => ActionResult;
  /** Discards the proposal; the module keeps the position the customer gave it. */
  rejectDocking: () => void;

  addModule: (typeId: FurnitureTypeId) => ActionResult;
  addModuleNextTo: (typeId: FurnitureTypeId, side: Side) => ActionResult;
  duplicateSelected: (side: Side) => ActionResult;
  removeModule: (id: ModuleId) => ActionResult;
  setPlacement: (id: ModuleId, patch: Partial<Placement>) => ActionResult;
  rotateModule: (id: ModuleId, deltaDeg: number) => ActionResult;
  snapToWall: (id: ModuleId, wall: WallId) => ActionResult;
  setModuleState: (id: ModuleId, state: OperationalStateId) => ActionResult;
  updateModuleConfiguration: (id: ModuleId, configuration: unknown) => ActionResult;
  selectModule: (id: ModuleId | null) => void;

  setActiveMenu: (menu: MenuId) => void;
  setRoomPanelOpen: (open: boolean) => void;
  setMenuCollapsed: (collapsed: boolean) => void;
  /** Selects the module and opens its context menu at the pointer. */
  openContextMenu: (moduleId: ModuleId, x: number, y: number) => void;
  /** Selects the window/door (on the active wall only) and opens its context menu at the pointer. */
  openOpeningMenu: (openingId: string, x: number, y: number) => void;
  /** Opens or closes a window/door; opening is refused (with the obstacles) when its leaves cannot swing. */
  setOpeningOpen: (id: string, open: boolean) => ActionResult;
  /** Opens or closes every door and drawer of a cabinet (the same session state as its menu); blocked fronts stay closed. */
  setFrontsOpen: (id: ModuleId, open: boolean) => ActionResult;
  /** Moves a window/door within its wall with positioning assistance (see assistOpeningPosition). */
  moveOpening: (id: string, offset: number, elevation: number) => OpeningPositioning | null;
  setDraggingOpening: (drag: OpeningDrag | null) => void;
  setNotice: (issues: readonly Issue[] | null) => void;
  closeContextMenu: () => void;
  requestView: (kind: ViewRequest["kind"]) => void;
  replaceArrangement: (arrangement: Arrangement) => void;
  importJson: (json: string) => ActionResult;
  exportJson: () => string;
  reset: () => void;
  hydrate: () => void;
}

export const INITIAL_ARRANGEMENT: Arrangement = { room: DEFAULT_ROOM, modules: [] };

const STORAGE_KEY = "multi3d.arrangement.v1";
const OK: ActionResult = { ok: true };

export const useArrangementStore = create<ArrangementState>()((set, get) => {
  const apply = <T extends { arrangement: Arrangement }>(
    result: Result<T>,
    after?: (value: T) => Partial<ArrangementState>,
  ): ActionResult => {
    if (!result.ok) return { ok: false, issues: result.issues };
    set({ arrangement: result.value.arrangement, ...(after ? after(result.value) : {}) });
    return OK;
  };

  const applyRoom = (result: Result<RoomConfiguration>): ActionResult =>
    result.ok ? apply({ ok: true, value: { arrangement: ops.setRoom(get().arrangement, result.value) } }) : { ok: false, issues: result.issues };

  /** Furniture becomes the one selected item: the wall and its window/door are deselected. */
  const furnitureSelection = (id: ModuleId): Partial<ArrangementState> => ({ selectedModuleId: id, selectedOpeningId: null, wallSelected: false });
  /** A wall (optionally with one of its windows/doors) becomes the selection: furniture is deselected. */
  const wallSelection = (wall: WallId, openingId: string | null): Partial<ArrangementState> => ({
    activeWall: wall,
    wallSelected: true,
    selectedOpeningId: openingId,
    selectedModuleId: null,
  });
  const selectAdded = ({ id }: { id: ModuleId }): Partial<ArrangementState> => furnitureSelection(id);

  return {
    arrangement: INITIAL_ARRANGEMENT,
    selectedModuleId: null,
    selectedOpeningId: null,
    activeWall: "back",
    wallSelected: true,
    showWallLabels: true,
    dockingEnabled: true,
    dockingProposal: null,
    draggingModuleId: null,
    activeMenu: "arrangement",
    roomPanelOpen: false,
    menuCollapsed: false,
    contextMenu: null,
    draggingOpening: null,
    notice: null,
    viewRequest: null,
    hydrated: false,

    setRoomDimension: (key, value) => applyRoom(roomOps.setRoomDimension(get().arrangement.room, key, value)),
    setWallColor: (wall, color) => applyRoom(roomOps.setWallColor(get().arrangement.room, wall, color)),
    setFloorColor: (color) => applyRoom(roomOps.setFloorColor(get().arrangement.room, color)),
    addOpening: (kind, wall) => {
      const result = roomOps.addOpening(get().arrangement.room, kind, wall);
      if (!result.ok) return { ok: false, issues: result.issues };
      set({ arrangement: ops.setRoom(get().arrangement, result.value.room), ...wallSelection(wall, result.value.id) });
      return OK;
    },
    updateOpening: (id, patch) => {
      const result = applyRoom(roomOps.updateOpening(get().arrangement.room, id, patch));
      if (result.ok && patch.wall) set(wallSelection(patch.wall, get().selectedOpeningId));
      return result;
    },
    removeOpening: (id) => {
      const result = applyRoom(roomOps.removeOpening(get().arrangement.room, id));
      if (result.ok && get().selectedOpeningId === id) set({ selectedOpeningId: null });
      return result;
    },
    selectOpening: (id) => {
      const opening = id === null ? undefined : get().arrangement.room.openings.find((o) => o.id === id);
      set(opening ? wallSelection(opening.wall, opening.id) : { selectedOpeningId: null });
    },
    setActiveWall: (wall) => {
      const { activeWall, wallSelected, selectedModuleId, selectedOpeningId } = get();
      if (activeWall === wall && wallSelected && selectedModuleId === null) return;
      // Windows and doors are selectable on the active wall only: another wall clears that selection.
      const selected = get().arrangement.room.openings.find((o) => o.id === selectedOpeningId);
      set(wallSelection(wall, selected && selected.wall === wall ? selected.id : null));
    },
    setShowWallLabels: (show) => set({ showWallLabels: show }),
    setDockingEnabled: (enabled) => set({ dockingEnabled: enabled, ...(enabled ? {} : { dockingProposal: null }) }),
    proposeDockingFor: (id) => {
      if (!get().dockingEnabled) return set({ dockingProposal: null });
      set({ dockingProposal: chooseDocking(get().arrangement, id, get().dockingProposal) });
    },
    requestWallDocking: (id) => set({ dockingProposal: proposeWallDocking(get().arrangement, id, { explicit: true }) }),
    setDragging: (id) => {
      if (get().draggingModuleId !== id) set({ draggingModuleId: id });
    },
    confirmDocking: () => {
      const proposal = get().dockingProposal;
      if (!proposal) return { ok: false, issues: [{ code: "no_docking_proposal" }] };
      // A physically impossible position is only explained, never applied.
      if (proposal.verdict === "invalid") return { ok: false, issues: [{ code: "docking_invalid" }] };
      // The arrangement may have changed since the proposal: only apply it if it is still the one proposed.
      const current =
        proposal.kind === "wall"
          ? proposeWallDocking(get().arrangement, proposal.moduleId, { explicit: true, previousWall: proposal.wall })
          : proposeDocking(get().arrangement, proposal.moduleId, { targetId: proposal.targetId, side: proposal.side });
      if (
        !current ||
        current.verdict === "invalid" ||
        current.placement.x !== proposal.placement.x ||
        current.placement.z !== proposal.placement.z ||
        current.placement.y !== proposal.placement.y ||
        current.placement.rotationDeg !== proposal.placement.rotationDeg
      ) {
        set({ dockingProposal: null });
        return { ok: false, issues: [{ code: "docking_no_longer_valid" }] };
      }
      const { x, y, z, rotationDeg } = proposal.placement;
      return apply(ops.setPlacement(get().arrangement, proposal.moduleId, { x, y, z, rotationDeg }), () => ({ dockingProposal: null }));
    },
    rejectDocking: () => set({ dockingProposal: null }),

    addModule: (typeId) => apply(ops.addModule(get().arrangement, typeId), selectAdded),
    addModuleNextTo: (typeId, side) => {
      const { selectedModuleId } = get();
      if (!selectedModuleId) return { ok: false, issues: [{ code: "no_selection" }] };
      return apply(ops.addModuleNextTo(get().arrangement, selectedModuleId, typeId, side), selectAdded);
    },
    duplicateSelected: (side) => {
      const { selectedModuleId } = get();
      if (!selectedModuleId) return { ok: false, issues: [{ code: "no_selection" }] };
      return apply(ops.duplicateModule(get().arrangement, selectedModuleId, side), selectAdded);
    },
    removeModule: (id) =>
      apply(ops.removeModule(get().arrangement, id), () => ({
        dockingProposal: null,
        contextMenu: null,
        ...(get().selectedModuleId === id ? { selectedModuleId: null } : {}),
      })),
    // Any new position supersedes a pending docking proposal.
    // A placement change ends the proposal, except while the module is being dragged: then the proposal
    // is re-evaluated right after the move (proposeDockingFor) and kept if still valid (no flicker).
    setPlacement: (id, patch) =>
      apply(ops.setPlacement(get().arrangement, id, patch), () => (get().draggingModuleId === id ? {} : { dockingProposal: null })),
    rotateModule: (id, delta) => apply(ops.rotateModule(get().arrangement, id, delta)),
    snapToWall: (id, wall) => apply(ops.snapToWall(get().arrangement, id, wall), () => ({ activeWall: wall })),
    // Changing the state (e.g. unfolding a bed) must not create a physical collision: refused, with the obstacles.
    setModuleState: (id, state) => {
      const result = ops.setModuleState(get().arrangement, id, state);
      if (!result.ok) return { ok: false, issues: result.issues };
      const blockers = (a: Arrangement) =>
        new Set(
          detectCollisions(a)
            .filter((i) => i.phase === "static" && i.kind !== "wall-mounting" && (i.moduleId === id || (i.kind === "module" && i.otherId === id)))
            .map((i) => (i.kind === "module" ? (i.moduleId === id ? i.otherId : i.moduleId) : i.kind === "opening" ? i.openingId : "wall")),
        );
      const before = blockers(get().arrangement);
      const added = [...blockers(result.value.arrangement)].filter((b) => !before.has(b));
      if (added.length > 0) return { ok: false, issues: [{ code: "transform_blocked", params: { module: id, state, obstacles: added.join(",") } }] };
      return apply(result);
    },
    updateModuleConfiguration: (id, configuration) => apply(ops.updateModuleConfiguration(get().arrangement, id, configuration)),
    selectModule: (id) => {
      if (id !== null && !get().arrangement.modules.some((m) => m.id === id)) return;
      if (id === null) {
        if (get().selectedModuleId !== null) set({ selectedModuleId: null });
        return;
      }
      if (get().selectedModuleId !== id || get().wallSelected || get().selectedOpeningId !== null) set(furnitureSelection(id));
    },

    setActiveMenu: (menu) => set({ activeMenu: menu }),
    setRoomPanelOpen: (open) => set({ roomPanelOpen: open }),
    setMenuCollapsed: (collapsed) => set({ menuCollapsed: collapsed }),
    openOpeningMenu: (openingId, x, y) => {
      const opening = get().arrangement.room.openings.find((o) => o.id === openingId);
      if (!opening || opening.wall !== get().activeWall || !get().wallSelected) return;
      set({ ...wallSelection(opening.wall, openingId), contextMenu: { kind: "opening", openingId, x, y }, notice: null });
    },
    setOpeningOpen: (id, open) => {
      if (open) {
        const obstacles = openingMotionObstacles(get().arrangement, id);
        if (obstacles.length > 0) {
          const ids = obstacles.map((o) => (o.kind === "module" ? o.moduleId : o.kind === "opening" ? o.openingId : "wall"));
          return { ok: false, issues: [{ code: "opening_blocked", params: { opening: id, obstacles: ids.join(",") } }] };
        }
      }
      return get().updateOpening(id, { open });
    },
    setFrontsOpen: (id, open) => {
      const instance = get().arrangement.modules.find((m) => m.id === id);
      if (!instance) return { ok: false, issues: [{ code: "module_not_found", params: { id } }] };
      // The fronts move in the cabinet's editing session: it must be the selected module (as from its menu).
      if (get().selectedModuleId !== id) get().selectModule(id);
      const preview = usePreviewStore.getState();
      if (!open) {
        preview.setOpen(movableFronts(instance), false);
        return OK;
      }
      const checks = checkFrontMotion(get().arrangement, id);
      const free = checks.filter((c) => c.obstacles.length === 0).map((c) => c.attachmentId);
      const blocked = checks.filter((c) => c.obstacles.length > 0);
      preview.setOpen(free, true);
      if (blocked.length === 0) return OK;
      const ids = [...new Set(blocked.flatMap((c) => c.obstacles.map((o) => (o.kind === "module" ? o.moduleId : o.kind === "opening" ? o.openingId : "wall"))))];
      return { ok: false, issues: [{ code: "fronts_blocked", params: { module: id, count: blocked.length, obstacles: ids.join(",") } }] };
    },
    moveOpening: (id, offset, elevation) => {
      const room = get().arrangement.room;
      const opening = room.openings.find((o) => o.id === id);
      if (!opening) return null;
      const positioning = assistOpeningPosition(room, opening, offset, elevation);
      if (positioning.offset !== opening.offset || positioning.elevation !== opening.elevation) {
        get().updateOpening(id, { offset: positioning.offset, elevation: positioning.elevation });
      }
      return positioning;
    },
    // A new drag replaces an earlier notice (one explanation at a time).
    setDraggingOpening: (drag) => set({ draggingOpening: drag, ...(drag ? { notice: null } : {}) }),
    setNotice: (issues) => set({ notice: issues && issues.length ? issues : null }),
    openContextMenu: (moduleId, x, y) => {
      if (!get().arrangement.modules.some((m) => m.id === moduleId)) return;
      set({ ...furnitureSelection(moduleId), contextMenu: { kind: "module", moduleId, x, y }, notice: null });
    },
    closeContextMenu: () => {
      if (get().contextMenu) set({ contextMenu: null });
    },
    requestView: (kind) => set({ viewRequest: { kind, seq: (get().viewRequest?.seq ?? 0) + 1 } }),
    replaceArrangement: (arrangement) =>
      set({ arrangement, selectedModuleId: null, selectedOpeningId: null, dockingProposal: null, contextMenu: null }),
    importJson: (json) => {
      const result = importArrangementJson(json);
      if (!result.ok) return { ok: false, issues: result.issues };
      get().replaceArrangement(result.value);
      return OK;
    },
    exportJson: () => exportArrangementJson(get().arrangement),
    reset: () =>
      set({
        arrangement: INITIAL_ARRANGEMENT,
        selectedModuleId: null,
        selectedOpeningId: null,
        activeWall: "back",
        wallSelected: true,
        dockingProposal: null,
        draggingModuleId: null,
        contextMenu: null,
      }),

    hydrate: () => {
      if (get().hydrated) return;
      try {
        const saved = window.localStorage.getItem(STORAGE_KEY);
        const result = saved ? importArrangementJson(saved) : null;
        set({ hydrated: true, ...(result?.ok ? { arrangement: result.value } : {}) });
      } catch {
        set({ hydrated: true });
      }
    },
  };
});

/** Saves the arrangement locally after every change (once hydrated), so a reload keeps the design. */
export function persistArrangement(): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const unsubscribe = useArrangementStore.subscribe((state, previous) => {
    if (!state.hydrated || state.arrangement === previous.arrangement) return;
    clearTimeout(timer);
    timer = setTimeout(() => {
      try {
        window.localStorage.setItem(STORAGE_KEY, exportArrangementJson(state.arrangement));
      } catch {
        // Storage full or unavailable: the design still works, it is just not kept across reloads.
      }
    }, 300);
  });
  return () => {
    clearTimeout(timer);
    unsubscribe();
  };
}
