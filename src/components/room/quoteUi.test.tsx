// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RenderedPhoto } from "@/components/three/photo/photoEngine";
import { clearPhotoCache, registerPhotoRenderer, type PhotoRequest } from "@/components/three/photo/photoService";
import { DEFAULT_PHOTO_SETTINGS } from "@/components/three/photo/photoSettings";
import { useLocaleStore } from "@/i18n";
import { clearQuotationCache, resetSavedQuotations } from "@/services/quotation";
import { useArrangementStore } from "@/store/useArrangementStore";
import { FurnitureContextMenu } from "./FurnitureContextMenu";
import { OrderDialog } from "./OrderDialog";
import { ActionNotice } from "./ViewOverlay";

const store = () => useArrangementStore.getState();

// The PDF gets a JPEG copy of each PNG rendering; jsdom cannot decode images, so the copy is stubbed.
vi.mock("@/components/three/photo/quoteCapture", async (importActual) => {
  const actual = await importActual<typeof import("@/components/three/photo/quoteCapture")>();
  const jpeg = "data:image/jpeg;base64,/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=";
  return { ...actual, quoteCapture: (renderer: Parameters<typeof actual.quoteCapture>[0]) => actual.quoteCapture(renderer, undefined, async () => jpeg) };
});

/** Photos as the photorealistic pipeline returns them. */
function fakePhotos(count: number): RenderedPhoto[] {
  const views = ["front-right", "front-left", "front"] as const;
  return Array.from({ length: count }, (_, i) => ({
    viewId: views[i],
    blob: new Blob([`png-${i}`], { type: "image/png" }),
    width: 1920,
    height: 1080,
    mode: "pathtraced",
    samples: 192,
    targetSamples: 192,
    durationMs: 900,
    camera: { position: [4, 1.8, 3], target: [2, 0.9, 0.4], fov: 40, aspect: 16 / 9, near: 0.05, far: 30 },
    hiddenWalls: [],
    settings: DEFAULT_PHOTO_SETTINGS,
    fallbackReason: null,
    timings: {},
  }));
}

afterEach(() => {
  cleanup();
  registerPhotoRenderer(null);
  vi.restoreAllMocks();
});
beforeEach(() => {
  useLocaleStore.setState({ locale: "pl" });
  store().reset();
  clearQuotationCache();
  resetSavedQuotations();
  clearPhotoCache();
  for (const type of ["cabinet", "clickbed-o", "cabinet"]) store().addModule(type);
});

describe("Zamówienie", () => {
  it("shows the whole arrangement tab with the live module count, no module-only tab, and the quotation tab", () => {
    render(<OrderDialog onClose={() => {}} />);
    const tabs = screen.getAllByRole("tab").map((t) => t.textContent);
    expect(tabs).toEqual(["Cały układ (3)", "Drukuj ofertę"]);
    expect(screen.queryByText(/Tylko/)).toBeNull();
    // The order lists every module of the arrangement.
    expect(screen.getAllByRole("article")).toHaveLength(3);
  });

  it("offers 1–3 renderings (default 1) and both quotation actions", () => {
    render(<OrderDialog onClose={() => {}} />);
    fireEvent.click(screen.getByRole("tab", { name: "Drukuj ofertę" }));
    const panel = within(screen.getByRole("tabpanel"));
    const group = panel.getByText("Liczba wizualizacji 3D").closest("fieldset")!;
    expect([...group.querySelectorAll("button")].map((b) => [b.textContent, b.getAttribute("aria-pressed")])).toEqual([
      ["1", "true"],
      ["2", "false"],
      ["3", "false"],
    ]);
    expect(panel.getByRole("button", { name: "Zapisz PDF na komputerze" })).toBeTruthy();
    expect(panel.getByRole("button", { name: "Wyślij ofertę e-mailem" })).toBeTruthy();
  });

  it("validates the e-mail address in the form", () => {
    render(<OrderDialog onClose={() => {}} />);
    fireEvent.click(screen.getByRole("tab", { name: "Drukuj ofertę" }));
    fireEvent.click(screen.getByRole("button", { name: "Wyślij ofertę e-mailem" }));
    fireEvent.change(screen.getByLabelText("Adres e-mail odbiorcy"), { target: { value: "klient@" } });
    fireEvent.submit(screen.getByLabelText("Adres e-mail odbiorcy").closest("form")!);
    expect(screen.getByRole("alert").textContent).toBe("Podaj poprawny adres e-mail.");
  });

  it("generates exactly the selected number (1, 2, 3) of photorealistic renderings for the PDF", async () => {
    const renderer = vi.fn(async (request: PhotoRequest) => fakePhotos(request.count));
    registerPhotoRenderer(renderer);
    const fonts = join(__dirname, "../../../public/fonts");
    vi.stubGlobal("fetch", vi.fn(async (url: string) => new Response(readFileSync(join(fonts, url.replace("/fonts/", ""))))));
    URL.createObjectURL = vi.fn(() => "blob:quote") as unknown as typeof URL.createObjectURL;
    URL.revokeObjectURL = vi.fn();
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    render(<OrderDialog onClose={() => {}} />);
    fireEvent.click(screen.getByRole("tab", { name: "Drukuj ofertę" }));
    const group = screen.getByText("Liczba wizualizacji 3D").closest("fieldset")! as HTMLElement;
    for (const count of [1, 2, 3]) {
      fireEvent.click(within(group).getByRole("button", { name: String(count) }));
      fireEvent.click(screen.getByRole("button", { name: "Zapisz PDF na komputerze" }));
      await waitFor(() => expect(renderer).toHaveBeenCalledTimes(count));
      expect(renderer.mock.calls[count - 1][0]).toMatchObject({ count });
      await waitFor(() => expect(screen.getByRole("status").textContent).toMatch(/została zapisana jako PDF/));
    }
  }, 30_000); // builds three PDFs with embedded fonts

  it("saves the PDF with the selected number of renderings", async () => {
    const capture = vi.fn(async (request: PhotoRequest) => fakePhotos(request.count));
    registerPhotoRenderer(capture);
    const fonts = join(__dirname, "../../../public/fonts");
    // Fonts from disk; the configurator's server (BFF) reserves and stores the quotation.
    const id = "3f2b8a4e-1c2d-4e5f-9a6b-7c8d9e0f1a2b";
    const api = vi.fn((url: string, init?: RequestInit) => {
      const key = `${init?.method ?? "GET"} ${url}`;
      if (key === "POST /api/quotes")
        return Response.json(
          { id, number: "OF-20261124-SRV7QZ", createdAt: "2026-11-24T10:00:00Z", expiresAt: "2027-01-23T10:00:00Z", configurationUrl: "https://cfg.test/c/" + "a".repeat(43) },
          { status: 201 },
        );
      if (key === "GET /api/quotes") return Response.json({ quotes: [] });
      if (key.startsWith(`PUT /api/quotes/${id}`) || key.startsWith(`POST /api/quotes/${id}/`)) return Response.json({ stored: true }, { status: 201 });
      throw new Error(`unexpected ${key}`);
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => (url.startsWith("/api/") ? api(url, init) : new Response(readFileSync(join(fonts, url.replace("/fonts/", "")))))),
    );
    const createObjectURL = vi.fn((blob: Blob) => {
      void blob;
      return "blob:quote";
    });
    URL.createObjectURL = createObjectURL as unknown as typeof URL.createObjectURL;
    URL.revokeObjectURL = vi.fn();
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});

    render(<OrderDialog onClose={() => {}} />);
    fireEvent.click(screen.getByRole("tab", { name: "Drukuj ofertę" }));
    const group = screen.getByText("Liczba wizualizacji 3D").closest("fieldset")!;
    fireEvent.click(within(group as HTMLElement).getByRole("button", { name: "3" }));
    fireEvent.click(screen.getByRole("button", { name: "Zapisz PDF na komputerze" }));
    await waitFor(() => expect(screen.getByRole("status").textContent).toBe("Oferta OF-20261124-SRV7QZ została zapisana jako PDF."));
    // Stored through the server by its internal id: document, PDF, then the three renderings.
    expect(api.mock.calls.map(([url, init]) => `${init?.method} ${url}`).filter((c) => !c.startsWith("GET"))).toEqual([
      "POST /api/quotes",
      `PUT /api/quotes/${id}`,
      `POST /api/quotes/${id}/pdf`,
      `POST /api/quotes/${id}/renderings/1`,
      `POST /api/quotes/${id}/renderings/2`,
      `POST /api/quotes/${id}/renderings/3`,
    ]);
    expect(capture.mock.calls[0][0]).toMatchObject({ count: 3 });
    expect(click).toHaveBeenCalledTimes(1);
    const blob = createObjectURL.mock.calls[0][0];
    expect(blob.type).toBe("application/pdf");
    const bytes = await new Promise<Uint8Array>((resolve) => {
      const reader = new FileReader();
      reader.onload = () => resolve(new Uint8Array(reader.result as ArrayBuffer));
      reader.readAsArrayBuffer(blob);
    });
    expect(new TextDecoder().decode(bytes.slice(0, 5))).toBe("%PDF-");
  });
});

describe("furniture context menu", () => {
  it("selects the right-clicked module and offers Usuń mebel", () => {
    store().selectModule("module-1");
    store().openContextMenu("module-2", 300, 200);
    render(<FurnitureContextMenu />);
    expect(store().selectedModuleId).toBe("module-2");
    const menu = screen.getByRole("menu");
    expect(menu.getAttribute("data-furniture-context-menu")).toBe("module-2");
    // A bed offers its transformation besides removal.
    expect(within(menu).getAllByRole("menuitem").map((b) => b.textContent)).toEqual(["Rozłóż łóżko", "Usuń mebel"]);
  });

  it("offers only removal for a cabinet without fronts", () => {
    store().openContextMenu("module-1", 300, 200);
    render(<FurnitureContextMenu />);
    expect(screen.getAllByRole("menuitem").map((b) => b.textContent)).toEqual(["Usuń mebel"]);
  });

  it("opens, closes and removes a window of the active wall from its menu", () => {
    store().addOpening("window", "left");
    const id = store().selectedOpeningId!;
    store().setActiveWall("back");
    store().openOpeningMenu(id, 50, 50);
    expect(store().contextMenu).toBeNull(); // not on the active wall
    store().setActiveWall("left");
    store().openOpeningMenu(id, 50, 50);
    render(<FurnitureContextMenu />);
    expect(screen.getByRole("menu").getAttribute("data-opening-context-menu")).toBe(id);
    fireEvent.click(screen.getByRole("menuitem", { name: "Otwórz okno" }));
    expect(store().arrangement.room.openings.find((o) => o.id === id)?.open).toBe(true);
    expect(screen.queryByRole("menu")).toBeNull();
    act(() => store().openOpeningMenu(id, 50, 50));
    expect(screen.getAllByRole("menuitem").map((b) => b.textContent)).toEqual(["Zamknij okno", "Usuń okno"]);
    fireEvent.click(screen.getByRole("menuitem", { name: "Usuń okno" }));
    expect(store().arrangement.room.openings.some((o) => o.id === id)).toBe(false);
  });

  it("removes only that instance and keeps the state consistent", () => {
    store().openContextMenu("module-3", 300, 200);
    const docking = store().dockingProposal;
    render(
      <>
        <FurnitureContextMenu />
        <OrderDialog onClose={() => {}} />
      </>,
    );
    fireEvent.click(screen.getByRole("menuitem", { name: "Usuń mebel" }));
    expect(store().arrangement.modules.map((m) => m.id)).toEqual(["module-1", "module-2"]);
    expect(store().arrangement.modules.map((m) => m.typeId)).toEqual(["cabinet", "clickbed-o"]); // the other cabinet stays
    expect(store().selectedModuleId).toBeNull();
    expect(store().contextMenu).toBeNull();
    expect(docking).toBeNull();
    expect(screen.queryByRole("menu")).toBeNull();
    expect(screen.getByRole("tab", { name: "Cały układ (2)" })).toBeTruthy();
    expect(screen.getAllByRole("article")).toHaveLength(2);
  });

  it("closes on Escape and on a click outside, without removing anything", () => {
    store().openContextMenu("module-1", 10, 10);
    render(<FurnitureContextMenu />);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("menu")).toBeNull();
    act(() => store().openContextMenu("module-1", 10, 10));
    expect(screen.getByRole("menu")).toBeTruthy();
    fireEvent.pointerDown(document.body);
    expect(store().contextMenu).toBeNull();
    expect(store().arrangement.modules).toHaveLength(3);
  });

  it("explains why a door cannot be opened and keeps it closed", () => {
    store().addOpening("door", "back");
    const id = store().selectedOpeningId!;
    store().updateOpening(id, { offset: 1000, clearanceDepth: 0 });
    store().setPlacement("module-1", { x: 1500, z: 700, rotationDeg: 0 });
    store().openOpeningMenu(id, 50, 50);
    render(
      <>
        <FurnitureContextMenu />
        <ActionNotice />
      </>,
    );
    fireEvent.click(screen.getByRole("menuitem", { name: "Otwórz drzwi" }));
    expect(store().arrangement.room.openings.find((o) => o.id === id)?.open).toBeFalsy();
    expect(screen.getByRole("alert").textContent).toContain(`Drzwi (${id}): nie można otworzyć — skrzydło uderzyłoby w: Szafka modułowa (module-1)`);
  });

  it("does not open for empty space or unknown modules", () => {
    store().openContextMenu("module-99", 10, 10);
    expect(store().contextMenu).toBeNull();
  });
});
