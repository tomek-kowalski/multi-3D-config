"use client";

import { useThree } from "@react-three/fiber";
import { useEffect } from "react";
import { DataTexture, EquirectangularReflectionMapping, LinearSRGBColorSpace, PMREMGenerator, type WebGLRenderTarget } from "three";
import { halfFloatEnvironment, loadHdriSource, neutralizedEnvironment } from "./hdriSource";

/** The neutral viewport copy of the shared HDRI, derived once per page (an independent texture). */
let neutral: DataTexture | null = null;

/**
 * Radiance of the neutral placeholder by elevation, from the studio HDRI's measured cosine-weighted
 * irradiance (up ≈ 0.77, horizontal ≈ 0.6–1.8, down ≈ 0.36): the same energy, without structure.
 */
const PLACEHOLDER = { zenith: 0.95, horizon: 0.85, nadir: 0.36 };

/** A small neutral gradient environment (sky → horizon → floor), available synchronously (half float). */
export function placeholderEnvironment(width = 32, height = 16): DataTexture {
  const data = new Float32Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    const elevation = 1 - ((y + 0.5) / height) * 2; // +1 top row, −1 bottom row
    const value =
      elevation >= 0
        ? PLACEHOLDER.horizon + (PLACEHOLDER.zenith - PLACEHOLDER.horizon) * elevation
        : PLACEHOLDER.horizon + (PLACEHOLDER.nadir - PLACEHOLDER.horizon) * -elevation;
    for (let x = 0; x < width; x++) data.set([value, value, value, 1], (y * width + x) * 4);
  }
  const texture = halfFloatEnvironment(data, width, height, "viewport-placeholder-environment");
  texture.mapping = EquirectangularReflectionMapping;
  texture.colorSpace = LinearSRGBColorSpace;
  return texture;
}

export type EnvironmentState = "placeholder" | "hdri" | "failed";

/**
 * Shared viewport reflection environment: the local studio HDRI (the one the photo renderer lights
 * with; here an independent, colour-neutral copy so configured colours keep their hue), prefiltered for
 * this canvas and set as the scene environment at a restrained intensity, so gloss, satin and metal
 * finishes reflect something real instead of only the point lights.
 *
 * Startup order (measured on Intel UHD 620, Phase 3.2): building any PMREM compiles three's prefilter
 * shaders, which takes ~0.9–1.6 s on a cold GPU shader cache. That work must never delay the first
 * visible frame, so the HDRI download starts at mount, and the environment is installed only after the
 * first frame has been presented: the HDRI directly if it has arrived by then, otherwise a neutral
 * gradient placeholder of the same energy, replaced when the HDRI arrives. Materials are built once
 * and never rebuilt for the environment (only `scene.environment` changes); until it is installed,
 * metal finishes show no reflections for those first frames. The PMREM targets belong to this canvas
 * and are freed with it. `rotationY` turns the HDRI's bright window side towards the key light.
 */
export function SurfaceEnvironment({ intensity, rotationY, onState }: { intensity: number; rotationY: number; onState?: (state: EnvironmentState) => void }) {
  const get = useThree((s) => s.get);

  useEffect(() => {
    // Read from the store inside the effect: the canvas's renderer and scene are mutable three objects.
    const { gl, scene, invalidate } = get();
    let cancelled = false;
    let pmrem: PMREMGenerator | null = null;
    let target: WebGLRenderTarget | null = null;
    let hdriArrived = false;
    let hdriInstalled = false;
    scene.environmentIntensity = intensity;
    scene.environmentRotation.set(0, rotationY, 0);
    const install = (source: DataTexture) => {
      pmrem ??= new PMREMGenerator(gl);
      const next = pmrem.fromEquirectangular(source);
      const previous = target;
      target = next;
      scene.environment = next.texture;
      previous?.dispose();
      invalidate();
    };
    // The download starts now (network only); nothing is prefiltered before the first frame.
    const started = performance.now();
    const hdri = loadHdriSource().then((texture) => {
      hdriArrived = true;
      return texture;
    });
    let frame = 0;
    const afterFirstFrame = new Promise<void>((resolve) => {
      frame = requestAnimationFrame(() => {
        frame = requestAnimationFrame(() => resolve());
      });
    });
    afterFirstFrame.then(() => {
      if (cancelled || hdriArrived) return;
      const t = performance.now();
      const source = placeholderEnvironment();
      install(source);
      source.dispose();
      performance.measure?.("viewport:environment-placeholder", { start: t, end: performance.now() });
      onState?.("placeholder");
    });
    Promise.all([hdri, afterFirstFrame])
      .then(([texture]) => {
        if (cancelled) return;
        if (!neutral) {
          const t = performance.now();
          neutral = neutralizedEnvironment(texture) ?? texture;
          performance.measure?.("viewport:environment-neutralize", { start: t, end: performance.now() });
        }
        install(neutral);
        hdriInstalled = true;
        performance.measure?.("viewport:environment", { start: started, end: performance.now() });
        onState?.("hdri");
      })
      .catch(() => {
        // The neutral placeholder stays (installed after the first frame): reflections remain plausible.
        if (cancelled) return;
        if (!hdriInstalled && !target) {
          const source = placeholderEnvironment();
          install(source);
          source.dispose();
        }
        onState?.("failed");
      });
    return () => {
      cancelled = true;
      cancelAnimationFrame(frame);
      if (target && scene.environment === target.texture) scene.environment = null;
      target?.dispose();
      pmrem?.dispose();
    };
  }, [get, intensity, rotationY, onState]);

  return null;
}
