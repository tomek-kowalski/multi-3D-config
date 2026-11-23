"use client";

import { Component, type ReactNode } from "react";
import { useT } from "@/i18n";

/** Whether an error means the browser refused to start WebGL (as opposed to a bug in a scene). */
export function isWebGLUnavailable(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /webgl|context/i.test(message);
}

function Unavailable({ webgl, onRetry }: { webgl: boolean; onRetry: () => void }) {
  const t = useT();
  return (
    <div role="alert" data-webgl-unavailable className="flex h-full items-center justify-center p-6">
      <div className="max-w-md space-y-3 rounded-xl border border-stone-200 bg-white/95 p-5 text-sm text-stone-700 shadow-sm">
        <p className="font-semibold text-stone-900">{t(webgl ? "webgl.unavailableTitle" : "webgl.errorTitle")}</p>
        <p>{t(webgl ? "webgl.unavailableBody" : "webgl.errorBody")}</p>
        <button
          type="button"
          onClick={onRetry}
          className="rounded-lg border border-stone-300 bg-white px-3 py-1.5 text-sm font-medium text-stone-800 hover:bg-stone-100"
        >
          {t("webgl.retry")}
        </button>
      </div>
    </div>
  );
}

/**
 * Keeps the configurator usable when the 3D view cannot start: the browser may refuse a WebGL context
 * (hardware acceleration off, WebGL disabled after GPU crashes, too many contexts). Without this the
 * error from the canvas would unmount the whole application. Menus, ordering and quotations keep working;
 * the view area explains what happened and can try again.
 */
export class WebGLErrorBoundary extends Component<{ children: ReactNode }, { error: unknown; attempt: number }> {
  state = { error: null as unknown, attempt: 0 };

  static getDerivedStateFromError(error: unknown) {
    return { error };
  }

  componentDidCatch(error: unknown) {
    console.error("3D view unavailable:", error);
  }

  render() {
    if (this.state.error !== null) {
      return (
        <Unavailable
          webgl={isWebGLUnavailable(this.state.error)}
          onRetry={() => this.setState((s) => ({ error: null, attempt: s.attempt + 1 }))}
        />
      );
    }
    // A new key on retry mounts a fresh canvas (and asks the browser for a new context).
    return <div key={this.state.attempt} className="contents">{this.props.children}</div>;
  }
}
