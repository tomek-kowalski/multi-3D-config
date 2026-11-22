import type { BoxMm } from "../compartments/types";
import type { ModelBounds, ModelSizeEntry } from "./catalog";
import { maxSpec, type BedSizeSpec } from "./specs";

/**
 * Spatial volumes of a ClickBed, in the module's local frame (origin at the carcass's back-left-bottom
 * corner, X along the bed, Z out of the wall). Every volume covers both the published dimensions and
 * the supplied 3D model, so neither can stick out of what the collision check sees.
 *
 * - Footprint (the placement box): the carcass, W × H × D.
 * - Folded: the carcass; for the Desk also the deployed desk (WD × DD at height HD, with the space below
 *   it kept free for use).
 * - Unfolded: the carcass plus the bed lying in front of it, up to DU from the wall, HU + HM high.
 * - Operation envelope: the bed rotates from vertical (in the carcass) to horizontal; the platform's
 *   swept volume stays within the carcass width and height and the unfolded depth DU. The envelope is
 *   that whole box: conservative, because the exact pivot and swing radius are not published.
 */
export type BedState = "folded" | "unfolded";
export const BED_STATES: readonly BedState[] = ["folded", "unfolded"];

function box(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number): BoxMm {
  return { position: { x: x0, y: y0, z: z0 }, dimensions: { width: x1 - x0, height: y1 - y0, depth: z1 - z0 } };
}

function maxX(b: ModelBounds | null | undefined) {
  return b ? b.min.x + b.size.width : 0;
}
function maxY(b: ModelBounds | null | undefined) {
  return b ? b.min.y + b.size.height : 0;
}
function maxZ(b: ModelBounds | null | undefined) {
  return b ? b.min.z + b.size.depth : 0;
}

export interface BedVolumes {
  readonly footprint: { width: number; depth: number; height: number };
  readonly states: Readonly<Record<BedState, readonly BoxMm[]>>;
  readonly envelope: readonly BoxMm[];
}

export function computeBedVolumes(spec: BedSizeSpec, model: ModelSizeEntry | null, hasDesk: boolean): BedVolumes {
  const folded = model?.states.folded;
  const unfolded = model?.states.unfolded;
  const width = Math.max(maxSpec(spec.W), maxX(folded?.carcass), maxX(unfolded?.carcass));
  const depth = Math.max(maxSpec(spec.D), maxZ(folded?.carcass), maxZ(unfolded?.carcass));
  const height = Math.max(maxSpec(spec.H), maxY(folded?.overall), maxY(unfolded?.carcass));

  const foldedBoxes: BoxMm[] = [box(0, 0, 0, width, Math.max(maxSpec(spec.H), maxY(folded?.overall)), depth)];
  if (hasDesk) {
    const deskWidth = Math.max(maxSpec(spec.WD), folded?.extension?.size.width ?? 0);
    const x0 = Math.min((width - deskWidth) / 2, folded?.extension?.min.x ?? Infinity);
    const x1 = Math.max(x0 + deskWidth, maxX(folded?.extension));
    const top = Math.max(maxSpec(spec.HD), maxY(folded?.extension));
    const front = Math.max(depth + maxSpec(spec.DD), maxZ(folded?.extension), maxZ(folded?.overall));
    foldedBoxes.push(box(x0, 0, depth, x1, top, front));
  } else if (folded?.extension) {
    const e = folded.extension;
    foldedBoxes.push(box(e.min.x, e.min.y, depth, maxX(e), maxY(e), maxZ(e)));
  }

  const bedTop = Math.max(maxSpec(spec.HU) + maxSpec(spec.HM), maxY(unfolded?.extension));
  const bedFront = Math.max(maxSpec(spec.DU), maxZ(unfolded?.extension), maxZ(unfolded?.overall));
  const bedX0 = Math.min(0, unfolded?.extension?.min.x ?? 0, unfolded?.overall.min.x ?? 0);
  const bedX1 = Math.max(width, maxX(unfolded?.extension), maxX(unfolded?.overall));
  const unfoldedBoxes: BoxMm[] = [
    box(0, 0, 0, width, Math.max(maxSpec(spec.H), maxY(unfolded?.carcass)), depth),
    box(bedX0, 0, depth, bedX1, bedTop, bedFront),
  ];

  const all = [...foldedBoxes, ...unfoldedBoxes];
  const envelope = box(
    Math.min(...all.map((b) => b.position.x)),
    0,
    0,
    Math.max(...all.map((b) => b.position.x + b.dimensions.width)),
    Math.max(...all.map((b) => b.position.y + b.dimensions.height)),
    Math.max(...all.map((b) => b.position.z + b.dimensions.depth)),
  );

  return { footprint: { width, depth, height }, states: { folded: foldedBoxes, unfolded: unfoldedBoxes }, envelope: [envelope] };
}
