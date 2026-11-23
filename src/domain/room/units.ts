import type { Issue } from "../shared/issues";

/**
 * Room dimensions are shown and typed in centimetres, but stored and computed in whole millimetres
 * like everything else (geometry, collisions, saved files). These helpers are the only conversion:
 * used at the UI boundary, never inside the domain. Furniture always stays in millimetres.
 */
export const MM_PER_CM = 10;
const EPSILON = 1e-6;

export function mmToCm(mm: number): number {
  return mm / MM_PER_CM;
}

/**
 * Centimetres typed by the customer → whole millimetres. Values finer than 0.1 cm (1 mm) cannot be
 * stored and return null; non-numbers return NaN. Float noise (400.9 × 10 = 4008.999…) is absorbed.
 */
export function cmToMm(cm: number): number | null {
  if (!Number.isFinite(cm)) return Number.NaN;
  const mm = cm * MM_PER_CM;
  const whole = Math.round(mm);
  return Math.abs(mm - whole) < EPSILON ? whole : null;
}

/** Re-expresses millimetre limits in a room-dimension issue in centimetres for display. */
export function roomIssueInCm(issue: Issue): Issue {
  if (issue.code === "below_minimum" && typeof issue.params?.min === "number") {
    return { ...issue, code: "below_minimum_cm", params: { min: mmToCm(issue.params.min) } };
  }
  if (issue.code === "above_maximum" && typeof issue.params?.max === "number") {
    return { ...issue, code: "above_maximum_cm", params: { max: mmToCm(issue.params.max) } };
  }
  if (issue.code === "opening_outside_wall") return { ...issue, code: "room_cuts_opening" };
  if (issue.code === "opening_above_ceiling") return { ...issue, code: "room_cuts_opening" };
  return issue;
}
