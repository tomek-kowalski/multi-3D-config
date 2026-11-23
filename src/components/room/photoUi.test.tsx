// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PhotoProgress, RenderedPhoto } from "@/components/three/photo/photoEngine";
import { PhotoRenderError } from "@/components/three/photo/photoEngine";
import { clearPhotoCache, registerPhotoRenderer, type PhotoRequest } from "@/components/three/photo/photoService";
import { DEFAULT_PHOTO_SETTINGS } from "@/components/three/photo/photoSettings";
import { useLocaleStore } from "@/i18n";
import { useArrangementStore } from "@/store/useArrangementStore";
import { photoFileName } from "./PhotoPreview";
import { ViewOverlay } from "./ViewOverlay";

const store = () => useArrangementStore.getState();

function photo(mode: "pathtraced" | "raster" = "pathtraced", fallbackReason: string | null = null): RenderedPhoto {
  return {
    viewId: "front-right",
    blob: new Blob(["png"], { type: "image/png" }),
    width: 1920,
    height: 1080,
    mode,
    samples: mode === "pathtraced" ? 192 : 1,
    targetSamples: 192,
    durationMs: 42_000,
    camera: { position: [4, 1.8, 3], target: [2, 0.9, 0.4], fov: 40, aspect: 16 / 9, near: 0.05, far: 30 },
    hiddenWalls: [],
    settings: DEFAULT_PHOTO_SETTINGS,
    fallbackReason,
  };
}

/** A renderer the test controls: it reports progress and finishes (or fails) on request. */
function controllableRenderer() {
  const requests: PhotoRequest[] = [];
  let finish: (photos: RenderedPhoto[]) => void = () => {};
  let fail: (error: unknown) => void = () => {};
  const renderer = vi.fn(
    (request: PhotoRequest) =>
      new Promise<RenderedPhoto[]>((resolve, reject) => {
        requests.push(request);
        finish = resolve;
        fail = reject;
        request.signal?.addEventListener("abort", () => reject(new PhotoRenderError("cancelled")));
      }),
  );
  registerPhotoRenderer(renderer);
  const progress = (p: Partial<PhotoProgress>) =>
    act(() =>
      requests.at(-1)!.onProgress?.({ phase: "rendering", view: 0, views: 1, samples: 0, targetSamples: 192, mode: "pathtraced", fraction: 0, ...p }),
    );
  return { renderer, requests, finish: (p: RenderedPhoto[]) => act(async () => finish(p)), fail: (e: unknown) => act(async () => fail(e)), progress };
}

const flush = () => act(() => new Promise((r) => setTimeout(r, 0)));

beforeEach(() => {
  useLocaleStore.setState({ locale: "pl" });
  store().reset();
  clearPhotoCache();
  for (const type of ["cabinet", "clickbed-o"]) store().addModule(type);
  URL.createObjectURL = vi.fn(() => "blob:photo") as unknown as typeof URL.createObjectURL;
  URL.revokeObjectURL = vi.fn();
});
afterEach(() => {
  cleanup();
  registerPhotoRenderer(null);
  vi.restoreAllMocks();
});

describe("Renderuj obraz", () => {
  it("sits directly below Wymiary pomieszczenia", () => {
    render(<ViewOverlay />);
    const roomButton = screen.getByRole("button", { name: "Wymiary pomieszczenia" });
    const next = roomButton.nextElementSibling as HTMLElement;
    expect(next.textContent).toBe("Renderuj obraz");
    expect(next.hasAttribute("data-render-image")).toBe(true);
  });

  it("starts a photorealistic render of the whole arrangement, shows progress and then the image", async () => {
    const r = controllableRenderer();
    render(<ViewOverlay />);
    fireEvent.click(screen.getByRole("button", { name: "Renderuj obraz" }));
    expect(screen.getByRole("dialog", { name: "Wizualizacja fotorealistyczna" })).toBeTruthy();
    await flush();
    expect(r.renderer).toHaveBeenCalledTimes(1);
    expect(r.requests[0]).toMatchObject({ count: 1, settings: { quality: "standard" }, reuse: true });
    r.progress({ samples: 96, fraction: 0.5 });
    expect(screen.getByRole("status").textContent).toBe("Path tracing: 96 z 192 próbek na piksel");
    expect((screen.getByRole("progressbar") as HTMLProgressElement).value).toBe(0.5);
    expect(screen.getByRole("button", { name: "Pobierz PNG" }).hasAttribute("disabled")).toBe(true);
    await r.finish([photo()]);
    const img = screen.getByRole("img", { name: /Fotorealistyczna wizualizacja/ }) as HTMLImageElement;
    expect(img.getAttribute("src")).toBe("blob:photo");
    expect(document.querySelector("[data-photo-mode]")?.getAttribute("data-photo-mode")).toBe("pathtraced");
    expect(screen.getByText(/Rendering fotorealistyczny \(path tracing\): 192 próbek na piksel, 1920×1080 px/)).toBeTruthy();
  });

  it("downloads the PNG", async () => {
    const r = controllableRenderer();
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    render(<ViewOverlay />);
    fireEvent.click(screen.getByRole("button", { name: "Renderuj obraz" }));
    await flush();
    const result = photo();
    await r.finish([result]);
    fireEvent.click(screen.getByRole("button", { name: "Pobierz PNG" }));
    expect(click).toHaveBeenCalledTimes(1);
    const calls = (URL.createObjectURL as unknown as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls.at(-1)![0]).toBe(result.blob);
    expect((calls.at(-1)![0] as Blob).type).toBe("image/png");
    expect(photoFileName(new Date(2026, 10, 24, 9, 5))).toBe("wizualizacja-20261124-0905.png");
  });

  it("can be cancelled and then rendered again", async () => {
    const r = controllableRenderer();
    render(<ViewOverlay />);
    fireEvent.click(screen.getByRole("button", { name: "Renderuj obraz" }));
    await flush();
    r.progress({ samples: 10, fraction: 0.05 });
    fireEvent.click(screen.getByRole("button", { name: "Anuluj" }));
    await flush();
    expect(r.requests[0].signal?.aborted).toBe(true);
    expect(screen.getByRole("alert").textContent).toBe("Renderowanie zostało anulowane.");
    // Retry, at another quality, without reusing an earlier result.
    fireEvent.click(screen.getByRole("button", { name: "Wysoka" }));
    fireEvent.click(screen.getByRole("button", { name: "Renderuj ponownie" }));
    await flush();
    expect(r.renderer).toHaveBeenCalledTimes(2);
    expect(r.requests[1]).toMatchObject({ count: 1, settings: { quality: "high" }, reuse: false });
    await r.finish([photo()]);
    expect(screen.getByRole("img", { name: /Fotorealistyczna wizualizacja/ })).toBeTruthy();
  });

  it("shows a failure and recovers with a retry", async () => {
    const r = controllableRenderer();
    render(<ViewOverlay />);
    fireEvent.click(screen.getByRole("button", { name: "Renderuj obraz" }));
    await flush();
    await r.fail(new PhotoRenderError("insufficient_samples"));
    expect(screen.getByRole("alert").textContent).toMatch(/wystarczającej liczby próbek/);
    fireEvent.click(screen.getByRole("button", { name: "Renderuj ponownie" }));
    await flush();
    await r.finish([photo()]);
    expect(screen.getByRole("img", { name: /Fotorealistyczna wizualizacja/ })).toBeTruthy();
  });

  it("labels the raster fallback clearly as not photorealistic", async () => {
    const r = controllableRenderer();
    render(<ViewOverlay />);
    fireEvent.click(screen.getByRole("button", { name: "Renderuj obraz" }));
    await flush();
    await r.finish([photo("raster", "software_gpu")]);
    const badge = document.querySelector("[data-photo-mode]")!;
    expect(badge.getAttribute("data-photo-mode")).toBe("raster");
    expect(badge.textContent).toMatch(/NIE jest rendering fotorealistyczny/);
    expect(badge.textContent).toMatch(/programowy renderer/);
  });

  it("closing the preview cancels a running render and leaves the configurator as it was", async () => {
    const r = controllableRenderer();
    store().selectModule("module-2");
    const before = JSON.stringify({ a: store().arrangement, s: store().selectedModuleId, w: store().activeWall, l: store().showWallLabels });
    render(<ViewOverlay />);
    fireEvent.click(screen.getByRole("button", { name: "Renderuj obraz" }));
    await flush();
    fireEvent.click(screen.getAllByRole("button", { name: /Zamknij/ })[0]);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(r.requests[0].signal?.aborted).toBe(true);
    expect(JSON.stringify({ a: store().arrangement, s: store().selectedModuleId, w: store().activeWall, l: store().showWallLabels })).toBe(before);
    expect(screen.getByRole("button", { name: "Renderuj obraz" })).toBeTruthy();
  });

  it("explains when the 3D view is not ready", async () => {
    render(<ViewOverlay />);
    fireEvent.click(screen.getByRole("button", { name: "Renderuj obraz" }));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toMatch(/Widok 3D nie jest jeszcze gotowy/));
  });
});
