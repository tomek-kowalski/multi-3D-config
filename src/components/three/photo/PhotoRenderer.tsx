"use client";

import { useThree } from "@react-three/fiber";
import { useEffect } from "react";
import { TextureLoader, type Texture } from "three";
import { useArrangementStore } from "@/store/useArrangementStore";
import { createBackendPool } from "./backendPool";
import { autoQuality, chooseRenderMode, probeGpu, readPerformance, recordPerformance, type GpuChoice } from "./capabilities";
import type { Arrangement } from "@/domain/arrangement/types";
import { planPhotoViews, toThreeCamera } from "./photoCamera";
import { isPhotoJobRunning, runPhotoJob } from "./photoJob";
import { applyHdDecors, buildPhotoScene, takeSnapshot, type SceneSnapshot } from "./photoScene";
import { registerPhotoPrewarm, registerPhotoRenderer } from "./photoService";
import { resolvePhotoSettings } from "./photoSettings";

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

/** Rendering code (incl. the path tracer) and HDRI: loaded on first use, never in the main bundle. */
function loadEnvironment(): Promise<Texture> {
  environment ??= import("./backends").then(async (b) => {
    backends = b;
    return (environmentTexture = await b.loadEnvironment());
  });
  // A failed download is retried by the next request.
  return environment.catch((error) => {
    environment = null;
    throw error;
  });
}

let prewarming: Promise<void> | null = null;

/**
 * Prepares the fast renderer before it is needed (pointer over "Renderuj obraz"): loads the rendering
 * code and the HDRI, creates the offscreen renderer with its prefiltered environment and compiles the
 * shader programs of the current scene by rendering one frame of it, then leaves the renderer in the
 * pool, where the photo request picks it up (programs are cached per renderer, so the request's first
 * frame needs no compilation). Asynchronous; the configurator stays responsive.
 */
function prewarm(capture: () => { arrangement: Arrangement; snapshot: SceneSnapshot }): Promise<void> {
  const started = performance.now();
  prewarming ??= loadEnvironment()
    .then((env) => {
      performance.measure("photo:prewarm:code+hdri", { start: started, end: performance.now() });
      return env;
    })
    .then(async (env) => {
      if (pool.idle || isPhotoJobRunning()) return;
      const settings = resolvePhotoSettings({ quality: "fast" });
      // User Timing marks (browser performance panel): where the warm-up time goes.
      const mark = (name: string, start: number) => performance.measure(`photo:prewarm:${name}`, { start, end: performance.now() });
      let t = performance.now();
      const backend = pool.acquire("raster", settings);
      mark("renderer+environment", t);
      const { arrangement, snapshot } = capture();
      try {
        if (snapshot.loading === 0) {
          const [view] = planPhotoViews(arrangement, 1, settings.width / settings.height);
          t = performance.now();
          await backend.setScene(buildPhotoScene(snapshot, view.hiddenWalls, env), toThreeCamera(view.camera));
          mark("compile", t);
          t = performance.now();
          backend.step(0);
          mark("first-frame", t);
        }
      } finally {
        snapshot.dispose();
        backend.dispose();
      }
    })
    .catch(() => {})
    .finally(() => {
      prewarming = null;
    });
  return prewarming;
}

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
        autoQuality: () => autoQuality((gpu ??= chooseRenderMode(probeGpu())), readPerformance()),
        recordPerformance: (photo) => recordPerformance(photo),
        // A prewarm in progress finishes first (its renderer is then reused, not created twice).
        loadEnvironment: () => (prewarming ?? Promise.resolve()).then(loadEnvironment),
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
    registerPhotoPrewarm(() => prewarm(() => ({ arrangement: useArrangementStore.getState().arrangement, snapshot: takeSnapshot(get().scene) })));
    // When the browser is idle after the configurator has loaded: download the rendering code and the
    // HDRI (network and parsing only, no GPU work), so a photo request does not wait for them.
    const idle = typeof requestIdleCallback === "function" ? requestIdleCallback(() => void loadEnvironment().catch(() => {}), { timeout: 10_000 }) : null;
    return () => {
      if (idle !== null) cancelIdleCallback(idle);
      registerPhotoRenderer(null);
      registerPhotoPrewarm(null);
      pool.release();
    };
  }, [get]);

  return null;
}
