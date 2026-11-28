// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { exportArrangementJson } from "@/domain/serialization/arrangementJson";
import { DEFAULT_ROOM } from "@/domain/room/defaults";
import { INITIAL_ARRANGEMENT, LEGACY_STORAGE_KEY, persistArrangement, useArrangementStore, WORKSPACE_STORAGE_KEY } from "./useArrangementStore";

const store = () => useArrangementStore.getState();
const fresh = useArrangementStore.getState();

/** A page load in this tab: a fresh store, restored from the tab's sessionStorage. */
function reload(): () => void {
  useArrangementStore.setState({ ...fresh, arrangement: INITIAL_ARRANGEMENT, hydrated: false, workspaceId: "" }, true);
  store().hydrate();
  return persistArrangement();
}

let stop: () => void = () => {};

beforeEach(() => {
  vi.useFakeTimers();
  window.sessionStorage.clear();
  window.localStorage.clear();
  stop = reload();
});

afterEach(() => {
  stop();
  vi.useRealTimers();
});

describe("per-tab working configuration", () => {
  it("a new visitor gets the default configuration and a new workspace id", () => {
    expect(store().arrangement).toBe(INITIAL_ARRANGEMENT);
    expect(store().workspaceId).toMatch(/^[0-9a-f-]{36}$/);
    expect(store().isDirty()).toBe(false);
  });

  it("never restores the former device-wide copy (another person's design on a shared computer)", () => {
    stop();
    window.sessionStorage.clear();
    const previousCustomer = { room: { ...DEFAULT_ROOM, width: 6100 }, modules: [] };
    window.localStorage.setItem(LEGACY_STORAGE_KEY, exportArrangementJson(previousCustomer));
    stop = reload();
    expect(store().arrangement.room.width).toBe(DEFAULT_ROOM.width);
    expect(window.localStorage.getItem(LEGACY_STORAGE_KEY)).toBeNull();
  });

  it("a reload restores this tab's configuration, workspace id and unsaved state", () => {
    store().addModule("cabinet");
    store().setRoomDimension("width", 5300);
    const id = store().workspaceId;
    vi.advanceTimersByTime(400); // debounced write; nothing is sent to a server
    stop();
    stop = reload();
    expect(store().arrangement.modules).toHaveLength(1);
    expect(store().arrangement.room.width).toBe(5300);
    expect(store().workspaceId).toBe(id);
    expect(store().isDirty()).toBe(true);
  });

  it("keeps pending changes when the page is left before the debounce", () => {
    store().addModule("cabinet");
    window.dispatchEvent(new Event("pagehide"));
    stop();
    stop = reload();
    expect(store().arrangement.modules).toHaveLength(1);
  });

  it("another tab (its own sessionStorage) starts with the default and does not see these changes", () => {
    store().addModule("cabinet");
    vi.advanceTimersByTime(400);
    const tabA = window.sessionStorage.getItem(WORKSPACE_STORAGE_KEY);
    // Tab B: empty session storage.
    stop();
    window.sessionStorage.clear();
    stop = reload();
    expect(store().arrangement.modules).toHaveLength(0);
    store().setRoomDimension("width", 4100);
    vi.advanceTimersByTime(400);
    // Back in tab A: its own copy is untouched by tab B.
    stop();
    window.sessionStorage.setItem(WORKSPACE_STORAGE_KEY, tabA!);
    stop = reload();
    expect(store().arrangement.modules).toHaveLength(1);
    expect(store().arrangement.room.width).toBe(DEFAULT_ROOM.width);
  });

  it("a duplicated tab gets a copy and both evolve independently", () => {
    store().addModule("cabinet");
    vi.advanceTimersByTime(400);
    const copy = window.sessionStorage.getItem(WORKSPACE_STORAGE_KEY)!; // the browser copies sessionStorage
    store().addModule("clickbed-o");
    vi.advanceTimersByTime(400);
    stop();
    window.sessionStorage.setItem(WORKSPACE_STORAGE_KEY, copy);
    stop = reload();
    expect(store().arrangement.modules.map((m) => m.typeId)).toEqual(["cabinet"]);
  });

  it("Nowa konfiguracja: default room, new id, written at once so a reload never brings the old one back", () => {
    store().addModule("cabinet");
    vi.advanceTimersByTime(400);
    const old = store().workspaceId;
    store().selectModule(store().arrangement.modules[0].id);
    store().startNewWorkspace();
    expect(store().arrangement).toBe(INITIAL_ARRANGEMENT);
    expect(store().selectedModuleId).toBeNull();
    expect(store().workspaceId).not.toBe(old);
    expect(store().isDirty()).toBe(false);
    stop(); // no debounce wait
    stop = reload();
    expect(store().arrangement.modules).toHaveLength(0);
    expect(store().workspaceId).not.toBe(old);
  });

  it("a loaded snapshot becomes a new clean workspace; editing it makes it dirty", () => {
    const shared = { room: { ...DEFAULT_ROOM, width: 4800 }, modules: [] };
    store().loadWorkspace(shared, "shared");
    expect(store().workspaceOrigin).toBe("shared");
    expect(store().isDirty()).toBe(false);
    store().setRoomDimension("depth", 3900);
    expect(store().isDirty()).toBe(true);
    store().markClean();
    expect(store().isDirty()).toBe(false);
  });

  it("an unreadable stored workspace falls back to the default", () => {
    stop();
    window.sessionStorage.setItem(WORKSPACE_STORAGE_KEY, "{not json");
    stop = reload();
    expect(store().arrangement).toBe(INITIAL_ARRANGEMENT);
    expect(store().hydrated).toBe(true);
  });
});
