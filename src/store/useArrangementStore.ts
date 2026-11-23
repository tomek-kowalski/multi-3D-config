import { create } from "zustand";
import { proposeDocking, type DockingProposal } from "@/domain/arrangement/docking";
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
  /** The wall the customer is working on; highlighted in the 3D view. */
  readonly activeWall: WallId;
  /** Whether the wall identifiers are shown in the 3D view (display only). */
  readonly showWallLabels: boolean;
  /** Whether cabinets moved next to another cabinet get a docking proposal. */
  readonly dockingEnabled: boolean;
  /** A docking position waiting for the customer's confirmation (preview in 3D). */
  readonly dockingProposal: DockingProposal | null;
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
  readonly contextMenu: { readonly moduleId: ModuleId; readonly x: number; readonly y: number } | null;
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

  const selectAdded = ({ id }: { id: ModuleId }): Partial<ArrangementState> => ({ selectedModuleId: id });

  return {
    arrangement: INITIAL_ARRANGEMENT,
    selectedModuleId: null,
    selectedOpeningId: null,
    activeWall: "back",
    showWallLabels: true,
    dockingEnabled: true,
    dockingProposal: null,
    draggingModuleId: null,
    activeMenu: "arrangement",
    roomPanelOpen: false,
    menuCollapsed: false,
    contextMenu: null,
    viewRequest: null,
    hydrated: false,

    setRoomDimension: (key, value) => applyRoom(roomOps.setRoomDimension(get().arrangement.room, key, value)),
    setWallColor: (wall, color) => applyRoom(roomOps.setWallColor(get().arrangement.room, wall, color)),
    setFloorColor: (color) => applyRoom(roomOps.setFloorColor(get().arrangement.room, color)),
    addOpening: (kind, wall) => {
      const result = roomOps.addOpening(get().arrangement.room, kind, wall);
      if (!result.ok) return { ok: false, issues: result.issues };
      set({ arrangement: ops.setRoom(get().arrangement, result.value.room), selectedOpeningId: result.value.id, activeWall: wall });
      return OK;
    },
    updateOpening: (id, patch) => {
      const result = applyRoom(roomOps.updateOpening(get().arrangement.room, id, patch));
      if (result.ok && patch.wall) set({ activeWall: patch.wall });
      return result;
    },
    removeOpening: (id) => {
      const result = applyRoom(roomOps.removeOpening(get().arrangement.room, id));
      if (result.ok && get().selectedOpeningId === id) set({ selectedOpeningId: null });
      return result;
    },
    selectOpening: (id) => {
      const opening = id === null ? undefined : get().arrangement.room.openings.find((o) => o.id === id);
      set({ selectedOpeningId: id, ...(opening ? { activeWall: opening.wall } : {}) });
    },
    setActiveWall: (wall) => {
      if (get().activeWall !== wall) set({ activeWall: wall });
    },
    setShowWallLabels: (show) => set({ showWallLabels: show }),
    setDockingEnabled: (enabled) => set({ dockingEnabled: enabled, ...(enabled ? {} : { dockingProposal: null }) }),
    proposeDockingFor: (id) => {
      // The proposal shown so far (same module) is kept while it stays valid: no flicker while dragging.
      const shown = get().dockingProposal;
      const previous = shown && shown.moduleId === id ? { targetId: shown.targetId, side: shown.side } : null;
      const proposal = get().dockingEnabled ? proposeDocking(get().arrangement, id, previous) : null;
      set({ dockingProposal: proposal });
    },
    setDragging: (id) => {
      if (get().draggingModuleId !== id) set({ draggingModuleId: id });
    },
    confirmDocking: () => {
      const proposal = get().dockingProposal;
      if (!proposal) return { ok: false, issues: [{ code: "no_docking_proposal" }] };
      // A physically impossible position is only explained, never applied.
      if (proposal.verdict === "invalid") return { ok: false, issues: [{ code: "docking_invalid" }] };
      // The arrangement may have changed since the proposal: only apply it if it is still the one proposed.
      const current = proposeDocking(get().arrangement, proposal.moduleId, { targetId: proposal.targetId, side: proposal.side });
      if (
        !current ||
        current.verdict === "invalid" ||
        current.placement.x !== proposal.placement.x ||
        current.placement.z !== proposal.placement.z ||
        current.placement.y !== proposal.placement.y
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
    setModuleState: (id, state) => apply(ops.setModuleState(get().arrangement, id, state)),
    updateModuleConfiguration: (id, configuration) => apply(ops.updateModuleConfiguration(get().arrangement, id, configuration)),
    selectModule: (id) => {
      if (id !== null && !get().arrangement.modules.some((m) => m.id === id)) return;
      if (get().selectedModuleId !== id) set({ selectedModuleId: id });
    },

    setActiveMenu: (menu) => set({ activeMenu: menu }),
    setRoomPanelOpen: (open) => set({ roomPanelOpen: open }),
    setMenuCollapsed: (collapsed) => set({ menuCollapsed: collapsed }),
    openContextMenu: (moduleId, x, y) => {
      if (!get().arrangement.modules.some((m) => m.id === moduleId)) return;
      set({ selectedModuleId: moduleId, contextMenu: { moduleId, x, y } });
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
