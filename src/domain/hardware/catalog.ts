/**
 * Hardware catalog: handle types and metal/painted finishes. Deliberately separate from the
 * board material catalog — board finishes and hardware finishes never mix.
 * Generic shapes only; no manufacturer products (Phase 3B).
 */
/*
 * IDs, names and swatch colours only. How a finish renders (metal vs. coating, roughness) is defined
 * once in the universal material registry (src/domain/materials/bindings.ts, hardware finish profiles).
 */
export const HARDWARE_FINISHES = [
  { id: "chrome", name: "Chrom", color: "#D9DCDF" },
  { id: "brushed-steel", name: "Stal szczotkowana", color: "#A9ADB1" },
  { id: "black-matte", name: "Czarny mat", color: "#232323" },
  { id: "brass", name: "Mosiądz", color: "#C9A24A" },
  { id: "white", name: "Biały", color: "#F2F2F0" },
] as const;

export type HardwareFinishId = (typeof HARDWARE_FINISHES)[number]["id"];

export type HardwareFinish = (typeof HARDWARE_FINISHES)[number];

const FINISHES_BY_ID: ReadonlyMap<string, HardwareFinish> = new Map(HARDWARE_FINISHES.map((f) => [f.id, f]));

export function isHardwareFinishId(value: unknown): value is HardwareFinishId {
  return typeof value === "string" && FINISHES_BY_ID.has(value);
}

export function getHardwareFinish(id: HardwareFinishId): HardwareFinish {
  const finish = FINISHES_BY_ID.get(id);
  if (!finish) throw new Error(`Nieznane wykończenie okuć „${id}”`);
  return finish;
}

export const HANDLE_TYPES = ["none", "knob", "bar", "recessed"] as const;

export type HandleType = (typeof HANDLE_TYPES)[number];

export const HANDLE_TYPE_NAMES: Readonly<Record<HandleType, string>> = {
  none: "Brak",
  knob: "Gałka",
  bar: "Uchwyt",
  recessed: "Frezowany",
};

export const DEFAULT_HARDWARE_FINISH: HardwareFinishId = "brushed-steel";

/**
 * Generic handle dimensions (mm). The recessed handle is drawn as a thin dark plate on the front
 * face instead of a real milled groove (simplification documented in the hardware geometry).
 */
export const HANDLE_RULES = Object.freeze({
  knob: { diameter: 32, projection: 28 },
  bar: { length: 160, diameter: 12, projection: 35 },
  recessed: { length: 140, width: 20, projection: 1 },
  /** Distance of the handle centre from the free door edge. */
  edgeOffset: { min: 20, max: 150, default: 40 },
  /** Distance of the handle centre from the top or bottom edge when aligned there. */
  alignOffset: { min: 30, max: 600, default: 100 },
  /** Minimum distance between the handle and the edge of its front. */
  margin: 8,
});
