import type { PhotoMode } from "./capabilities";
import type { PhotoBackend } from "./photoEngine";
import type { PhotoSettings } from "./photoSettings";

/** A backend that can take new settings of the same output size (tone mapping, quality). */
export type ReusableBackend = PhotoBackend & { configure?(settings: PhotoSettings): void };

/**
 * Keeps the last backend alive for a while after a render instead of destroying its WebGL context:
 * the path tracer's shaders take long to compile (up to a minute on integrated GPUs), and "Renderuj
 * ponownie" or a quotation right after a preview would otherwise pay that again. It is released after
 * `idleMs` without use, when another mode/size is needed, or at once after any error (a backend that
 * failed is never reused).
 */
export function createBackendPool(
  create: (mode: PhotoMode, settings: PhotoSettings) => ReusableBackend,
  idleMs = 120_000,
  timers: { set: (fn: () => void, ms: number) => unknown; clear: (handle: unknown) => void } = {
    set: (fn, ms) => setTimeout(fn, ms),
    clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  },
) {
  let idle: { key: string; backend: ReusableBackend; timer: unknown } | null = null;

  const releaseIdle = () => {
    if (!idle) return;
    timers.clear(idle.timer);
    idle.backend.dispose();
    idle = null;
  };

  const lease = (key: string, backend: ReusableBackend): PhotoBackend => {
    let broken = false;
    const guard = <T,>(fn: () => T): T => {
      try {
        const result = fn();
        if (result instanceof Promise) return result.catch((e) => ((broken = true), Promise.reject(e))) as T;
        return result;
      } catch (error) {
        broken = true;
        throw error;
      }
    };
    return {
      mode: backend.mode,
      get compiling() {
        return backend.compiling;
      },
      get exposure() {
        return backend.exposure;
      },
      get traceLayers() {
        return backend.traceLayers;
      },
      get reductions() {
        return backend.reductions;
      },
      // Optional capabilities are forwarded too (a missing one stays missing).
      invalidFraction: backend.invalidFraction ? () => guard(() => backend.invalidFraction!()) : undefined,
      setScene: (scene, camera) => guard(() => backend.setScene(scene, camera)),
      step: (budget) => guard(() => backend.step(budget)),
      output: (format) => guard(() => backend.output(format)),
      dispose: () => {
        if (broken) {
          backend.dispose();
          return;
        }
        releaseIdle();
        idle = { key, backend, timer: timers.set(releaseIdle, idleMs) };
      },
    };
  };

  return {
    acquire(mode: PhotoMode, settings: PhotoSettings): PhotoBackend {
      // Raster supersampling depends on the quality (canvas size); the path tracer only re-configures.
      const key = `${mode}|${settings.width}x${settings.height}${mode === "raster" ? `|${settings.quality}` : ""}`;
      if (idle && idle.key === key) {
        const { backend } = idle;
        timers.clear(idle.timer);
        idle = null;
        backend.configure?.(settings);
        return lease(key, backend);
      }
      releaseIdle();
      return lease(key, create(mode, settings));
    },
    /** Frees the kept backend now (e.g. when the 3D view unmounts). */
    release: releaseIdle,
    get idle() {
      return idle !== null;
    },
  };
}
