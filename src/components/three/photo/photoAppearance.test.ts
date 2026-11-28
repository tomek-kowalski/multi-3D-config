import { BoxGeometry, Mesh, MeshStandardMaterial, Scene, Texture } from "three";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { addModule } from "@/domain/arrangement/operations";
import type { Arrangement } from "@/domain/arrangement/types";
import { bedDecorSelection, cabinetFinishSelection } from "@/domain/materials/bindings";
import type { MaterialSelection } from "@/domain/materials/contracts";
import { DEFAULT_ROOM } from "@/domain/room/defaults";
import { attachMaterialBinding } from "../materials/materialSlots";
import type { PhotoBackend } from "./photoEngine";
import { runPhotoJob, type PhotoJobDeps } from "./photoJob";
import { takeSnapshot } from "./photoScene";
import { clearPhotoCache } from "./photoService";
import { photoTag } from "./tags";

function scene(selection: MaterialSelection) {
  const s = new Scene();
  const mesh = new Mesh(new BoxGeometry(), new MeshStandardMaterial());
  mesh.userData = photoTag("board");
  attachMaterialBinding(mesh, { binding: { slots: [{ slotId: "front", selection, side: "front", mapping: { kind: "authored-uv0", uvUnits: "metres" } }], groups: [] }, authored: {} });
  s.add(mesh);
  return s;
}

function backend(mode: "pathtraced" | "raster"): PhotoBackend {
  let samples = 0;
  return {
    mode,
    async setScene() {
      samples = 0;
    },
    step: () => (samples += 200),
    output: async () => new Blob([`${mode}`], { type: "image/png" }),
    dispose() {},
  };
}

function deps(live: Scene, overrides: Partial<PhotoJobDeps> = {}): PhotoJobDeps {
  let t = 0;
  let a: Arrangement = { room: DEFAULT_ROOM, modules: [] };
  const r = addModule(a, "cabinet");
  if (r.ok) a = r.value.arrangement;
  return {
    capture: () => ({ arrangement: a, snapshot: takeSnapshot(live) }),
    choice: () => ({ mode: "pathtraced", reason: null, rasterEligible: true }),
    autoQuality: () => "fast",
    loadEnvironment: async () => new Texture(),
    prepareMaterials: (snapshot) => snapshot.ready,
    createBackend: (mode) => backend(mode),
    now: () => (t += 10),
    nextFrame: async () => {},
    sleep: async () => {},
    ...overrides,
  };
}

describe("photo appearance diagnostics", () => {
  beforeEach(() => clearPhotoCache());

  it("an image with a decor lacking an authorized swatch carries the diagnostic and a burned-in note; cached results keep it", async () => {
    const annotate = vi.fn(async (image: Blob) => new Blob([await image.text(), "+note"], { type: "image/png" }));
    const d = deps(scene(bedDecorSelection(4000, "standard", "8361-SN")), { annotate });
    const [photo] = await runPhotoJob({ count: 1 }, d);
    expect(photo.appearance).toEqual({ unavailable: ["8361 SN"], failed: [] });
    expect(annotate).toHaveBeenCalledTimes(1);
    expect(await photo.blob.text()).toBe("raster+note");
    // The cached rendering (e.g. reused by the quotation) carries the diagnostic, and the note is added
    // again when it is returned (current language) — the cache keeps the plain image.
    const [cached] = await runPhotoJob({ count: 1 }, d);
    expect(cached.appearance?.unavailable).toEqual(["8361 SN"]);
    expect(await cached.blob.text()).toBe("raster+note");
    expect(annotate).toHaveBeenCalledTimes(2);
  });

  it("authorized appearances are not annotated", async () => {
    const annotate = vi.fn(async (image: Blob) => image);
    const [photo] = await runPhotoJob({ count: 1 }, deps(scene(cabinetFinishSelection("white-matte")), { annotate }));
    expect(photo.appearance).toEqual({ unavailable: [], failed: [] });
    expect(annotate).not.toHaveBeenCalled();
    expect(photo.timings).toMatchObject({ materials: expect.any(Number), textures: 0, textureKiB: 0 });
  });

  it("a device whose fast renderer is ineligible path traces a 'fast' request instead of failing", async () => {
    const created: string[] = [];
    const [photo] = await runPhotoJob(
      { count: 1, settings: { quality: "fast" } },
      deps(scene(cabinetFinishSelection("walnut")), {
        choice: () => ({ mode: "pathtraced", reason: null, rasterEligible: false }),
        createBackend: (mode, s) => (created.push(`${mode}:${s.quality}`), backend(mode)),
      }),
    );
    expect(created).toEqual(["pathtraced:standard"]);
    expect(photo.mode).toBe("pathtraced");
  });
});
