import { create } from "zustand";
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

/** The three primary menus: the room, the arrangement, the selected module. */
export type MenuId = "space" | "arrangement" | "module";

export interface ViewRequest {
  readonly kind: "room" | "selection";
  readonly seq: number;
}

export interface ArrangementState {
  /** The committed arrangement; always valid. */
  readonly arrangement: Arrangement;
  readonly selectedModuleId: ModuleId | null;
  readonly selectedOpeningId: string | null;
  readonly activeMenu: MenuId;
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
    activeMenu: "space",
    viewRequest: null,
    hydrated: false,

    setRoomDimension: (key, value) => applyRoom(roomOps.setRoomDimension(get().arrangement.room, key, value)),
    setWallColor: (wall, color) => applyRoom(roomOps.setWallColor(get().arrangement.room, wall, color)),
    setFloorColor: (color) => applyRoom(roomOps.setFloorColor(get().arrangement.room, color)),
    addOpening: (kind, wall) => {
      const result = roomOps.addOpening(get().arrangement.room, kind, wall);
      if (!result.ok) return { ok: false, issues: result.issues };
      set({ arrangement: ops.setRoom(get().arrangement, result.value.room), selectedOpeningId: result.value.id });
      return OK;
    },
    updateOpening: (id, patch) => applyRoom(roomOps.updateOpening(get().arrangement.room, id, patch)),
    removeOpening: (id) => {
      const result = applyRoom(roomOps.removeOpening(get().arrangement.room, id));
      if (result.ok && get().selectedOpeningId === id) set({ selectedOpeningId: null });
      return result;
    },
    selectOpening: (id) => set({ selectedOpeningId: id }),

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
      apply(ops.removeModule(get().arrangement, id), () => (get().selectedModuleId === id ? { selectedModuleId: null } : {})),
    setPlacement: (id, patch) => apply(ops.setPlacement(get().arrangement, id, patch)),
    rotateModule: (id, delta) => apply(ops.rotateModule(get().arrangement, id, delta)),
    snapToWall: (id, wall) => apply(ops.snapToWall(get().arrangement, id, wall)),
    setModuleState: (id, state) => apply(ops.setModuleState(get().arrangement, id, state)),
    updateModuleConfiguration: (id, configuration) => apply(ops.updateModuleConfiguration(get().arrangement, id, configuration)),
    selectModule: (id) => {
      if (id !== null && !get().arrangement.modules.some((m) => m.id === id)) return;
      if (get().selectedModuleId !== id) set({ selectedModuleId: id });
    },

    setActiveMenu: (menu) => set({ activeMenu: menu }),
    requestView: (kind) => set({ viewRequest: { kind, seq: (get().viewRequest?.seq ?? 0) + 1 } }),
    replaceArrangement: (arrangement) => set({ arrangement, selectedModuleId: null, selectedOpeningId: null }),
    importJson: (json) => {
      const result = importArrangementJson(json);
      if (!result.ok) return { ok: false, issues: result.issues };
      get().replaceArrangement(result.value);
      return OK;
    },
    exportJson: () => exportArrangementJson(get().arrangement),
    reset: () => set({ arrangement: INITIAL_ARRANGEMENT, selectedModuleId: null, selectedOpeningId: null }),

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
