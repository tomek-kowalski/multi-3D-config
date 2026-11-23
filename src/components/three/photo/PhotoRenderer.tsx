"use client";

import { useThree } from "@react-three/fiber";
import { useEffect } from "react";
import { TextureLoader, type Texture } from "three";
import { useArrangementStore } from "@/store/useArrangementStore";
import { createBackendPool } from "./backendPool";
import { chooseRenderMode, probeGpu, type GpuChoice } from "./capabilities";
import { runPhotoJob } from "./photoJob";
import { applyHdDecors, takeSnapshot } from "./photoScene";
import { registerPhotoRenderer } from "./photoService";

let environment: Promise<Texture> | null = null;
let environmentTexture: Texture | null = null;
let gpu: GpuChoice | null = null;
let backends: typeof import("./backends") | null = null;

/** Offscreen renderers, kept for a short while between renders (see backendPool.ts). */
const pool = createBackendPool((mode, settings) => {
  if (!backends || !environmentTexture) throw new Error("backends not loaded");
  return mode === "pathtraced"
    ? backends.createPathTracedBackend(settings, environmentTexture)
    : backends.createRasterBackend(settings, environmentTexture);
});

/**
 * Registers the photorealistic renderer for the mounted room view. It reads the live scene only to
 * take a snapshot; rendering happens on a separate offscreen WebGL context, so the interactive view
 * (camera, selection, overlays, canvas size) is never changed and nothing needs restoring.
 */
export function PhotoRenderer() {
  const get = useThree((s) => s.get);

  useEffect(() => {
    registerPhotoRenderer((request) =>
      runPhotoJob(request, {
        capture: () => ({ arrangement: useArrangementStore.getState().arrangement, snapshot: takeSnapshot(get().scene) }),
        choice: () => (gpu ??= chooseRenderMode(probeGpu())),
        loadEnvironment: () => {
          // The path tracer is loaded only when a photo is requested (not in the main bundle).
          environment ??= import("./backends").then(async (b) => {
            backends = b;
            return (environmentTexture = await b.loadEnvironment());
          });
          // A failed download is retried by the next request.
          return environment.catch((error) => {
            environment = null;
            throw error;
          });
        },
        upgradeTextures: (snapshot) => {
          const loader = new TextureLoader();
          return applyHdDecors(snapshot, (url) => loader.loadAsync(url));
        },
        createBackend: (mode, settings) => pool.acquire(mode, settings),
        now: () => performance.now(),
        nextFrame: () => new Promise((resolve) => requestAnimationFrame(() => resolve())),
        sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      }),
    );
    return () => {
      registerPhotoRenderer(null);
      pool.release();
    };
  }, [get]);

  return null;
}
