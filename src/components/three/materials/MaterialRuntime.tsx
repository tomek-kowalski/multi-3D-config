"use client";

import { useThree } from "@react-three/fiber";
import { createContext, useContext, useEffect, useMemo, type ReactNode } from "react";
import { materialRegistry } from "@/domain/materials";
import type { MaterialQualityProfile } from "@/domain/materials/contracts";
import { capabilitiesFromRenderer, VIEWPORT_CONSTRAINED, viewportQualityProfile } from "./materialQuality";
import type { MaterialRuntime } from "./materialSlots";
import { SurfaceEnvironment, type EnvironmentState } from "./SurfaceEnvironment";
import { createTextureResources } from "./textureResources";

/** Lights of a viewport canvas, balanced with its reflection environment. */
export interface ViewportLighting {
  readonly ambient: number;
  readonly hemisphere: number;
  readonly key: number;
  readonly fill: number;
}

export interface ViewportLightingPreset {
  /**
   * Calibrated against the pre-environment configurator (measured region colours within 1–3 sRGB levels):
   * less flat ambient fill, the environment supplying soft directional fill and reflections. Used from
   * the first frame (the environment is present from the first frame, see SurfaceEnvironment).
   */
  readonly lighting: ViewportLighting;
  readonly environmentIntensity: number;
  /** HDRI yaw that puts its bright window side on the key light's side (radians). */
  readonly environmentRotationY: number;
}

export const ROOM_LIGHTING: ViewportLightingPreset = {
  lighting: { ambient: 1.0, hemisphere: 0.45, key: 2.2, fill: 0.4 },
  environmentIntensity: 0.35,
  environmentRotationY: 2.16,
};

export const FURNITURE_LIGHTING: ViewportLightingPreset = {
  lighting: { ambient: 1.05, hemisphere: 0, key: 2.8, fill: 0.5 },
  environmentIntensity: 0.35,
  environmentRotationY: 2.19,
};

/** Texture budget of a canvas scope from its quality profile. */
export function scopeBudget(quality: MaterialQualityProfile) {
  return { maxResidentBytes: quality.maxResidentTextureBytes, maxIdleBytes: quality.maxIdleTextureBytes };
}

/** Outside a canvas provider (tests, isolated renders): constrained quality, no reflections. */
let fallbackRuntime: MaterialRuntime | null = null;
function getFallbackRuntime(): MaterialRuntime {
  fallbackRuntime ??= {
    registry: materialRegistry,
    quality: VIEWPORT_CONSTRAINED,
    textures: createTextureResources({ budget: scopeBudget(VIEWPORT_CONSTRAINED) }),
    capabilities: {
      mode: "viewport",
      usable: true,
      maxTextureSize: 4096,
      maxAnisotropy: 1,
      maxArrayTextureLayers: 0,
      supportsFloatColorTargets: false,
      supportsTransmission: false,
      reflections: false,
      uvChannels: 4,
      supportedMaps: new Set(["baseColor"]),
    },
  };
  return fallbackRuntime;
}

const RuntimeContext = createContext<MaterialRuntime | null>(null);

export function useMaterialRuntime(): MaterialRuntime {
  return useContext(RuntimeContext) ?? getFallbackRuntime();
}

export function useViewportLighting(preset: ViewportLightingPreset): ViewportLighting {
  return preset.lighting;
}

function rendererName(gl: WebGLRenderingContext | WebGL2RenderingContext): string | null {
  try {
    const debug = gl.getExtension("WEBGL_debug_renderer_info");
    return debug ? String(gl.getParameter(debug.UNMASKED_RENDERER_WEBGL)) : null;
  } catch {
    return null;
  }
}

/**
 * Material runtime of one viewport canvas: its texture resource scope (shared by every mesh of the
 * canvas, bounded by the quality profile's active and idle budgets, freed with it), the renderer's
 * capabilities, the quality profile for this GPU (also capping the device pixel ratio) and the shared
 * reflection environment.
 *
 * The runtime's identity never changes during the canvas's life: an environment that becomes ready
 * later does not rebuild any material (only the scene environment changes; it is installed right after
 * the first frame, see SurfaceEnvironment). Every material of the canvas is built from this runtime (see useMaterialSlots).
 */
export function MaterialRuntimeProvider({
  lighting,
  children,
  onEnvironmentState,
  runtimeRef,
}: {
  lighting: ViewportLightingPreset;
  children: ReactNode;
  /** Environment lifecycle (placeholder → hdri | failed), for diagnostics. */
  onEnvironmentState?: (state: EnvironmentState) => void;
  /** Receives the canvas runtime (diagnostics and tests). */
  runtimeRef?: (runtime: MaterialRuntime | null) => void;
}) {
  const gl = useThree((s) => s.gl);
  const setDpr = useThree((s) => s.setDpr);
  const runtime = useMemo<MaterialRuntime>(() => {
    const quality = viewportQualityProfile(rendererName(gl.getContext()));
    return {
      registry: materialRegistry,
      quality,
      textures: createTextureResources({ budget: scopeBudget(quality) }),
      // Metals are built fully metallic: an environment is always installed (right after the first frame).
      capabilities: capabilitiesFromRenderer(gl, "viewport", true),
    };
  }, [gl]);
  useEffect(() => () => runtime.textures.dispose(), [runtime]);
  useEffect(() => {
    runtimeRef?.(runtime);
    return () => runtimeRef?.(null);
  }, [runtime, runtimeRef]);
  // DPR policy of the quality profile (never above the device's own ratio).
  useEffect(() => {
    const device = typeof window === "undefined" ? 1 : window.devicePixelRatio || 1;
    setDpr(Math.min(device, runtime.quality.maxViewportDpr));
  }, [setDpr, runtime]);
  return (
    <RuntimeContext.Provider value={runtime}>
      <SurfaceEnvironment intensity={lighting.environmentIntensity} rotationY={lighting.environmentRotationY} onState={onEnvironmentState} />
      {children}
    </RuntimeContext.Provider>
  );
}
