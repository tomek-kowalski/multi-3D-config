// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useLocaleStore } from "@/i18n";
import { isWebGLUnavailable, WebGLErrorBoundary } from "./WebGLErrorBoundary";

let webglAvailable = true;
function Canvas() {
  if (!webglAvailable) throw new Error("THREE.WebGLRenderer: Error creating WebGL context.");
  return <canvas data-testid="canvas" />;
}

beforeEach(() => {
  useLocaleStore.setState({ locale: "pl" });
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("3D view without WebGL", () => {
  it("explains the problem instead of crashing the application, and can try again", () => {
    webglAvailable = false;
    render(
      <>
        <WebGLErrorBoundary>
          <Canvas />
        </WebGLErrorBoundary>
        <nav>Menu</nav>
      </>,
    );
    expect(screen.getByRole("alert").textContent).toMatch(/Podgląd 3D nie może się uruchomić.*ponowne uruchomienie przeglądarki/);
    expect(screen.getByText("Menu")).toBeTruthy(); // the rest of the configurator is still there
    webglAvailable = true; // e.g. after restarting the browser
    fireEvent.click(screen.getByRole("button", { name: "Spróbuj ponownie" }));
    expect(screen.getByTestId("canvas")).toBeTruthy();
  });

  it("tells WebGL refusals apart from other errors", () => {
    expect(isWebGLUnavailable(new Error("THREE.WebGLRenderer: Error creating WebGL context."))).toBe(true);
    expect(isWebGLUnavailable(new Error("Cannot read properties of undefined"))).toBe(false);
  });
});
