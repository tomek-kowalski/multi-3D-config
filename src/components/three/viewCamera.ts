import type { Vec3 } from "@/domain/sharing/snapshot";

/**
 * The interactive room camera, for configuration snapshots: read when a configuration is shared,
 * applied when a shared configuration is opened. Registered by the mounted 3D view; a view requested
 * before the view is mounted is applied when it mounts (instead of the default framing).
 */
export interface CameraView {
  readonly position: Vec3;
  readonly target: Vec3;
}

interface CameraController {
  get(): CameraView | null;
  set(view: CameraView): void;
}

let controller: CameraController | null = null;
let pending: CameraView | null = null;

export function registerViewCamera(next: CameraController | null): void {
  controller = next;
}

export function currentCameraView(): CameraView | null {
  return controller?.get() ?? null;
}

export function requestCameraView(view: CameraView): void {
  if (controller) controller.set(view);
  else pending = view;
}

/** The view requested before mount, if any (taken once). */
export function takePendingCameraView(): CameraView | null {
  const view = pending;
  pending = null;
  return view;
}
