"use client";

import { useFrame } from "@react-three/fiber";
import { useRef } from "react";
import { Mesh, type Object3D } from "three";
import { readPhotoTag } from "../photo/tags";

/** Whether the scene shows furniture and no model is still loading (loading placeholders are tagged). */
export function furnitureReady(scene: Object3D, expectedModules: number): boolean {
  if (expectedModules === 0) return true;
  let loading = 0;
  let furniture = 0;
  scene.traverse((o) => {
    if (!(o instanceof Mesh) || !o.visible) return;
    const role = readPhotoTag(o.userData)?.role;
    if (role === "loading") loading++;
    else if (role === "board" || role === "fabric" || role === "metal") furniture++;
  });
  return loading === 0 && furniture > 0;
}

/**
 * Startup User Timing marks (browser performance panel, harness measurements): `viewport:first-frame`
 * when the canvas renders its first frame, `viewport:furniture-ready` at the first frame showing every
 * module's geometry (no loading placeholder). Inert after both are recorded (no per-frame cost).
 */
export function StartupMarks({ expectedModules }: { expectedModules: number }) {
  const done = useRef({ first: false, furniture: false });
  useFrame(({ scene }) => {
    const state = done.current;
    if (state.first && state.furniture) return;
    if (!state.first) {
      state.first = true;
      performance.mark?.("viewport:first-frame");
    }
    if (!state.furniture && furnitureReady(scene, expectedModules)) {
      state.furniture = true;
      performance.mark?.("viewport:furniture-ready");
    }
  });
  return null;
}
