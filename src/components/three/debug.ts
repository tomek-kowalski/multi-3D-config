/**
 * Developer-only visualization of the technical geometry the configurator computes with: collision
 * volumes, operation envelopes (the space a transforming bed sweeps), keep-free volumes of windows and
 * doors, and the volumes of the selected/colliding module. Customers never see these: they are off by
 * default and can only be switched on in a development build with NEXT_PUBLIC_SHOW_GEOMETRY_DEBUG=true.
 *
 * Turning them off changes nothing in the calculations: collision detection, docking, wall clearance and
 * the operational clearance of beds work on the geometry data in src/domain, not on these meshes.
 */
export const SHOW_GEOMETRY_DEBUG =
  process.env.NODE_ENV !== "production" && process.env.NEXT_PUBLIC_SHOW_GEOMETRY_DEBUG === "true";

export interface TechnicalOverlays {
  /** Collision volumes of the selected module (blue). */
  readonly selection: boolean;
  /** Collision volumes of a module that collides (red). */
  readonly collision: boolean;
  /** Operation envelope of a selected transforming module (orange). */
  readonly envelope: boolean;
}

/** Which technical overlays to draw for a module: none, unless geometry debugging is enabled. */
export function technicalOverlays(selected: boolean, colliding: boolean, debug = SHOW_GEOMETRY_DEBUG): TechnicalOverlays {
  return { selection: debug && selected, collision: debug && colliding, envelope: debug && selected };
}

/** Whether to draw the keep-free volume of the selected window or door. */
export function showKeepFreeVolume(selected: boolean, debug = SHOW_GEOMETRY_DEBUG): boolean {
  return debug && selected;
}
