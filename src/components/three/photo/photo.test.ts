import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  BoxGeometry,
  Color,
  Group,
  LineSegments,
  Mesh,
  MeshBasicMaterial,
  MeshPhysicalMaterial,
  MeshStandardMaterial,
  RepeatWrapping,
  Scene,
  SRGBColorSpace,
  Texture,
  Vector3,
  type Object3D,
} from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { addModule, setModuleState, updateModuleConfiguration } from "@/domain/arrangement/operations";
import type { Arrangement } from "@/domain/arrangement/types";
import { getBedModel } from "@/domain/beds/catalog";
import { DEFAULT_ROOM } from "@/domain/room/defaults";
import { addOpening } from "@/domain/room/operations";
import { WALL_IDS } from "@/domain/room/types";
import { applyBedVisibility, prepareBedScene, SWATCH_SIZE_M } from "../modules/BedModel";
import { opensContextMenu } from "../modules/ModuleObject";
import { wallHiddenForCamera } from "../room/roomScene";
import { createBackendPool } from "./backendPool";
import { autoQuality, chooseRenderMode, MIN_TEXTURE_SIZE, readPerformance, recordPerformance, type GpuChoice } from "./capabilities";
import {
  arrangementFacingDeg,
  boxCorners,
  fitPhotoCamera,
  moduleBoxes,
  occlusionScore,
  type BoxM,
  PHOTO_FOV_DEG,
  photoSubject,
  planPhotoViews,
  projectNdc,
  viewDirection,
} from "./photoCamera";
import { PhotoRenderError, renderPhotoViews, type PhotoBackend, type PhotoEngineDeps } from "./photoEngine";
import { isPhotoJobRunning, runPhotoJob, type PhotoJobDeps } from "./photoJob";
import { FABRIC_MAX_ALBEDO, GLASS_TINT, photoMaterial } from "./photoMaterials";
import { applyHdDecors, buildPhotoScene, takeSnapshot } from "./photoScene";
import { clearPhotoCache, renderingMetadata } from "./photoService";
import { DEFAULT_PHOTO_SETTINGS, QUALITY_PRESETS, resolvePhotoSettings } from "./photoSettings";
import { HIGHLIGHT_PERCENTILE, HIGHLIGHT_TARGET, highlightExposure, MIN_EXPOSURE } from "./exposure";
import { photoTag } from "./tags";

const GPU: GpuChoice = { mode: "pathtraced", reason: null };
/** Path tracing settings (the default quality is the fast renderer). */
const PT = { ...DEFAULT_PHOTO_SETTINGS, quality: "standard" as const };

function arrangement(types: string[] = ["cabinet", "clickbed-o", "cabinet"]): Arrangement {
  let a: Arrangement = { room: { ...DEFAULT_ROOM, width: 6000 }, modules: [] };
  for (const type of types) {
    const r = addModule(a, type);
    if (!r.ok) throw new Error(JSON.stringify(r.issues));
    a = r.value.arrangement;
  }
  return a;
}

async function loadBed(typeId: string, size = "140x200"): Promise<Object3D> {
  const buffer = readFileSync(join(__dirname, "../../../../public/models/clickbed", getBedModel(typeId, size)!.file));
  const gltf = await new GLTFLoader().parseAsync(buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength), "");
  return gltf.scene;
}

/**
 * A live scene shaped like the app's: tagged panels, a wall with a window, the floor, and the editing
 * aids the configurator draws (outline, selection volume, docking ghost) — untagged.
 */
function liveScene() {
  const scene = new Scene();
  const panelMaterial = new MeshStandardMaterial({ color: "#67452F", roughness: 0.65 });
  const panel = new Mesh(new BoxGeometry(), panelMaterial);
  panel.name = "side-left";
  panel.position.set(0.4, 0.9, 0.25);
  panel.scale.set(0.018, 1.8, 0.5);
  panel.userData = photoTag("board");
  const outline = new LineSegments(new BoxGeometry(), new MeshBasicMaterial());
  panel.add(outline);
  const wall = new Mesh(new BoxGeometry(4, 2.6, 0.01), new MeshStandardMaterial({ color: "#D9D4CC" }));
  wall.userData = photoTag("wall", "front");
  const glass = new Mesh(new BoxGeometry(1, 1, 0.01), new MeshStandardMaterial({ color: "#A9CBE0", transparent: true, opacity: 0.35 }));
  glass.userData = photoTag("glass", "front");
  const backWall = new Mesh(new BoxGeometry(4, 2.6, 0.01), new MeshStandardMaterial({ color: "#EEEAE2" }));
  backWall.userData = photoTag("wall", "back");
  const floor = new Mesh(new BoxGeometry(4, 0.01, 3.5), new MeshStandardMaterial({ color: "#B79D7C" }));
  floor.userData = photoTag("floor");
  const selection = new Mesh(new BoxGeometry(), new MeshBasicMaterial({ color: "#2563eb", transparent: true, opacity: 0.1 }));
  selection.name = "selection-volume";
  const docking = new Mesh(new BoxGeometry(), new MeshBasicMaterial({ color: "#059669", transparent: true, opacity: 0.22 }));
  docking.name = "docking-ghost";
  scene.add(panel, wall, glass, backWall, floor, selection, docking);
  return { scene, panel, panelMaterial, wall };
}

/** A backend that "renders" a fixed number of samples per step. */
function fakeBackend(mode: "pathtraced" | "raster", options: { perStep?: number; failSetScene?: boolean; log?: string[] } = {}) {
  let samples = 0;
  const log = options.log ?? [];
  const backend: PhotoBackend & { disposed: boolean } = {
    mode,
    disposed: false,
    async setScene(scene) {
      if (options.failSetScene) throw new Error("shader compile failed");
      samples = 0;
      log.push(`${mode}:scene:${scene.children.length}`);
    },
    step() {
      samples += options.perStep ?? (mode === "raster" ? 48 : 16);
      return samples;
    },
    async output() {
      return new Blob([`${mode}-${samples}`], { type: "image/png" });
    },
    dispose() {
      backend.disposed = true;
      log.push(`${mode}:dispose`);
    },
  };
  return backend;
}

function engineDeps(overrides: Partial<PhotoEngineDeps> = {}, clock = { t: 0 }): PhotoEngineDeps {
  return {
    choice: GPU,
    createBackend: (mode) => fakeBackend(mode),
    buildView: () => ({ scene: new Scene(), camera: undefined as never }),
    now: () => (clock.t += 100),
    nextFrame: async () => {},
    ...overrides,
  };
}

describe("photo settings and GPU detection", () => {
  it("renders 1920 × 1080 by default with neutral (colour-preserving) tone mapping", () => {
    expect(DEFAULT_PHOTO_SETTINGS).toMatchObject({ width: 1920, height: 1080, toneMapping: "neutral", quality: "fast" });
    expect(resolvePhotoSettings({ width: 99999, quality: "nope" as never })).toMatchObject({ width: 4096, quality: "fast" });
    for (const p of Object.values(QUALITY_PRESETS)) expect(p.minSamples).toBeLessThan(p.samples);
  });

  it("chooses path tracing only on capable hardware GPUs and labels every fallback", () => {
    const good = { webgl2: true, floatColorBuffer: true, maxTextureSize: 16384, renderer: "ANGLE (NVIDIA GeForce RTX 3060)" };
    expect(chooseRenderMode(good)).toEqual({ mode: "pathtraced", reason: null });
    expect(chooseRenderMode(null)).toEqual({ mode: "unsupported", reason: "no_webgl" });
    expect(chooseRenderMode({ ...good, webgl2: false })).toMatchObject({ mode: "raster", reason: "no_webgl2" });
    expect(chooseRenderMode({ ...good, floatColorBuffer: false })).toMatchObject({ mode: "raster", reason: "no_float_textures" });
    expect(chooseRenderMode({ ...good, maxTextureSize: MIN_TEXTURE_SIZE / 2 })).toMatchObject({ mode: "raster", reason: "small_textures" });
    expect(chooseRenderMode({ ...good, renderer: "ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device))" })).toMatchObject({ mode: "raster", reason: "software_gpu" });
  });
});

describe("photo camera", () => {
  it("frames every corner of the furniture inside the image, for many room and arrangement sizes", () => {
    const subjects = [
      { min: [0, 0, 0], max: [0.8, 1.8, 0.5] },
      { min: [0, 0, 0], max: [6, 2.6, 0.6] },
      { min: [1, 0, 0], max: [3.2, 2.2, 2.3] },
      { min: [0, 0, 0], max: [4, 2.6, 3.5] },
    ] as const;
    for (const subject of subjects)
      for (const aspect of [16 / 9, 4 / 3, 1])
        for (const view of [{ azimuthDeg: 34, elevationDeg: 18 }, { azimuthDeg: -38, elevationDeg: 20 }, { azimuthDeg: 0, elevationDeg: 12 }]) {
          const camera = fitPhotoCamera(subject, viewDirection(view), aspect);
          for (const corner of boxCorners(subject)) {
            const ndc = projectNdc(camera, corner);
            expect(Math.abs(ndc.x)).toBeLessThanOrEqual(1);
            expect(Math.abs(ndc.y)).toBeLessThanOrEqual(1);
            expect(ndc.z).toBeLessThan(1);
            expect(ndc.z).toBeGreaterThan(-1);
          }
          // Tight: the subject fills the frame on at least one axis (not a tiny object in a big image).
          const extent = Math.max(...boxCorners(subject).map((c) => Math.max(Math.abs(projectNdc(camera, c).x), Math.abs(projectNdc(camera, c).y))));
          expect(extent).toBeGreaterThan(0.85);
          expect(camera.fov).toBe(PHOTO_FOV_DEG);
        }
  });

  it("plans 1–3 clearly different views around the way the furniture faces", () => {
    const a = arrangement();
    const views = planPhotoViews(a, 3, 16 / 9);
    expect(views.map((v) => v.id)).toEqual(["front-right", "front-left", "front"]);
    const dirs = views.map((v) => new Vector3(...v.camera.position).sub(new Vector3(...v.camera.target)).normalize());
    for (let i = 0; i < 3; i++) for (let j = i + 1; j < 3; j++) expect((dirs[i].angleTo(dirs[j]) * 180) / Math.PI).toBeGreaterThan(25);
    expect(planPhotoViews(a, 1, 16 / 9)).toHaveLength(1);
    expect(() => planPhotoViews(a, 4, 16 / 9)).toThrow();
    // Against the back wall the furniture faces +Z; rotated to face +X, the views turn with it.
    expect(arrangementFacingDeg(a.modules)).toBe(0);
    const turned = { ...a, modules: a.modules.map((m) => ({ ...m, placement: { ...m.placement, rotationDeg: 90 } })) };
    expect(arrangementFacingDeg(turned.modules)).toBe(90);
    const front = planPhotoViews(turned, 3, 16 / 9)[2].camera;
    expect(front.position[0]).toBeGreaterThan(front.target[0]); // the camera stands at +X, in front of the fronts
  });

  it("hides only the walls the camera stands behind, and frames the whole arrangement", () => {
    let room = { ...DEFAULT_ROOM, width: 6000 };
    for (const wall of WALL_IDS) {
      const r = addOpening(room, "window", wall);
      if (!r.ok) throw new Error();
      room = r.value.room;
    }
    const a = { ...arrangement(), room };
    for (const view of planPhotoViews(a, 3, 16 / 9)) {
      // Every wall kept in the photo has the camera on its inner side: none stands in front of the lens.
      for (const wall of WALL_IDS.filter((w) => !view.hiddenWalls.includes(w))) expect(wallHiddenForCamera(a.room, wall, view.camera.position)).toBe(false);
      expect(view.hiddenWalls).not.toContain("back");
    }
    // A shallow room: the camera must stand beyond the front wall, which is left out of the photo.
    const shallow = { ...a, room: { ...room, depth: 1500 } };
    expect(planPhotoViews(shallow, 1, 16 / 9)[0].hiddenWalls).toContain("front");
    expect(a.room.openings).toHaveLength(4); // the configuration is untouched
    const subject = photoSubject(a);
    expect(subject.min[1]).toBe(0);
    expect(subject.max[0]).toBeGreaterThan(a.modules.length > 0 ? 1.6 : 0);
  });
});

describe("photo materials", () => {
  it("keeps the configured colour and decor image exactly; adds only surface physics", () => {
    const map = new Texture();
    map.colorSpace = SRGBColorSpace;
    const source = new MeshStandardMaterial({ color: "#67452F", roughness: 0.65, map });
    const board = photoMaterial("board", source);
    expect(board).toBeInstanceOf(MeshPhysicalMaterial);
    expect(board.color.getHexString()).toBe(new Color("#67452F").getHexString());
    expect(board.map).toBe(map);
    expect(board.roughness).toBe(0.65);
    expect(board.transparent).toBe(false);

    source.userData.decor = { texture: "7045-MG.jpg", code: "7045", structure: "MG", swatchSizeM: SWATCH_SIZE_M };
    expect(photoMaterial("board", source)).toMatchObject({ clearcoat: 1, roughness: 0.12 }); // high gloss
    source.userData.decor = { texture: null, code: "AL01", structure: "SM", swatchSizeM: SWATCH_SIZE_M };
    expect(photoMaterial("board", source).metalness).toBeGreaterThan(0.5); // metal decor

    // The supplied mattress fabric: hue kept, albedo capped at real white fabric (not a customer colour).
    const mattress = new Color("#E6E3DC");
    const fabric = photoMaterial("fabric", new MeshStandardMaterial({ color: "#E6E3DC" }));
    expect(fabric.sheen).toBeGreaterThan(0);
    expect(Math.max(fabric.color.r, fabric.color.g, fabric.color.b)).toBeCloseTo(FABRIC_MAX_ALBEDO, 5);
    expect(fabric.color.r / fabric.color.b).toBeCloseTo(mattress.r / mattress.b, 5);
    const grey = photoMaterial("fabric", new MeshStandardMaterial({ color: "#808080" }));
    expect(grey.color.getHexString()).toBe("808080"); // darker fabrics are untouched
    const glass = photoMaterial("glass", new MeshStandardMaterial({ color: "#A9CBE0", transparent: true, opacity: 0.35 }));
    expect(glass).toMatchObject({ transmission: 1, transparent: false });
    expect(glass.color.getHexString()).toBe(new Color(GLASS_TINT).getHexString());
    const wall = photoMaterial("wall", new MeshStandardMaterial({ color: "#D9D4CC" }));
    expect(wall.color.getHexString()).toBe(new Color("#D9D4CC").getHexString());
    // The source material is never modified.
    expect(source.color.getHexString()).toBe(new Color("#67452F").getHexString());
  });

  it("uses the HD decor image with the same orientation and placement, keeping the preview on failure", async () => {
    const { scene, panelMaterial } = liveScene();
    const preview = new Texture();
    preview.wrapS = preview.wrapT = RepeatWrapping;
    preview.repeat.set(1 / SWATCH_SIZE_M, 1 / SWATCH_SIZE_M);
    preview.colorSpace = SRGBColorSpace;
    panelMaterial.map = preview;
    panelMaterial.userData.decor = { texture: "K001-PW.jpg", code: "K001", structure: "PW", swatchSizeM: SWATCH_SIZE_M };
    const snapshot = takeSnapshot(scene);
    const load = vi.fn(async (url: string) => {
      expect(url).toBe("/textures/decors/hd/K001-PW.jpg");
      return new Texture();
    });
    expect(await applyHdDecors(snapshot, load)).toBe(1);
    const board = snapshot.items.find((i) => i.tag.role === "board")!.material;
    expect(board.map).not.toBe(preview);
    expect(board.map!.repeat.toArray()).toEqual(preview.repeat.toArray());
    expect(board.map!.wrapS).toBe(RepeatWrapping);
    expect(board.map!.colorSpace).toBe(SRGBColorSpace);

    const second = takeSnapshot(scene);
    expect(await applyHdDecors(second, async () => Promise.reject(new Error("404")))).toBe(0);
    expect(second.items.find((i) => i.tag.role === "board")!.material.map).toBe(preview);
    snapshot.dispose();
    second.dispose();
  });
});

describe("scene snapshot", () => {
  it("contains only the furniture and the room — never outlines, selection, collision or docking aids", () => {
    const { scene } = liveScene();
    const snapshot = takeSnapshot(scene);
    expect(snapshot.items.map((i) => i.tag.role).sort()).toEqual(["board", "floor", "glass", "wall", "wall"]);
    expect(snapshot.items.some((i) => i.name === "selection-volume" || i.name === "docking-ghost")).toBe(false);
    snapshot.dispose();
  });

  it("copies geometry and transforms exactly, independent of later edits", () => {
    const { scene, panel, panelMaterial } = liveScene();
    const snapshot = takeSnapshot(scene);
    const item = snapshot.items.find((i) => i.name === "side-left")!;
    expect(item.matrix.equals(panel.matrixWorld)).toBe(true);
    expect([...item.geometry.getAttribute("position").array]).toEqual([...panel.geometry.getAttribute("position").array]);
    expect(item.geometry).not.toBe(panel.geometry);
    // The customer keeps editing while the photo renders: the snapshot does not change.
    panel.position.x = 2;
    panelMaterial.color.set("#ffffff");
    scene.updateMatrixWorld(true);
    expect(item.matrix.equals(panel.matrixWorld)).toBe(false);
    expect(item.material.color.getHexString()).toBe(new Color("#67452F").getHexString());
    snapshot.dispose();
  });

  it("includes every bed part that is drawn — and the mattress only when it is configured", async () => {
    const root = new Group();
    const { root: bed } = prepareBedScene(await loadBed("clickbed-o"));
    applyBedVisibility(bed, "unfolded", false);
    root.add(bed);
    const without = takeSnapshot(root);
    expect(without.items.some((i) => i.tag.role === "fabric")).toBe(false);
    expect(without.items.filter((i) => i.tag.role === "board").length).toBeGreaterThan(0);
    applyBedVisibility(bed, "unfolded", true);
    const withMattress = takeSnapshot(root);
    expect(withMattress.items.filter((i) => i.tag.role === "fabric").length).toBeGreaterThan(0);
    // Same number of vertices as the drawn model.
    let drawn = 0;
    root.traverseVisible((o) => {
      if (o instanceof Mesh) drawn += o.geometry.getAttribute("position").count;
    });
    expect(withMattress.items.reduce((n, i) => n + i.geometry.getAttribute("position").count, 0)).toBe(drawn);
    without.dispose();
    withMattress.dispose();
  });

  it("counts models that are still loading", () => {
    const { scene } = liveScene();
    const placeholder = new Mesh(new BoxGeometry(), new MeshBasicMaterial());
    placeholder.userData = photoTag("loading");
    scene.add(placeholder);
    expect(takeSnapshot(scene).loading).toBe(1);
  });

  it("leaves out the walls the camera stands behind together with their openings, for that view only", () => {
    const { scene } = liveScene();
    const snapshot = takeSnapshot(scene);
    const photo = buildPhotoScene(snapshot, ["front"], null);
    const roles = photo.children.filter((c) => c instanceof Mesh).map((c) => (c.userData.photo as { role: string; wall?: string }));
    expect(roles.some((r) => r.wall === "front")).toBe(false);
    expect(roles.filter((r) => r.role === "wall")).toEqual([{ role: "wall", wall: "back" }]);
    expect(buildPhotoScene(snapshot, [], null).children.filter((c) => c instanceof Mesh)).toHaveLength(5);
    expect(photo.children.some((c) => c.type === "RectAreaLight")).toBe(true);
  });
});

describe("render engine", () => {
  const views = () => planPhotoViews(arrangement(), 3, 16 / 9);

  it("accumulates the quality's samples per view, reports progress and disposes the backend", async () => {
    const backends: ReturnType<typeof fakeBackend>[] = [];
    const progress: number[] = [];
    const photos = await renderPhotoViews(
      views(),
      PT,
      engineDeps({ createBackend: (mode) => (backends.push(fakeBackend(mode)), backends.at(-1)!) }),
      { onProgress: (p) => progress.push(p.fraction) },
    );
    expect(photos).toHaveLength(3);
    expect(photos.every((p) => p.mode === "pathtraced" && p.samples >= QUALITY_PRESETS.standard.samples)).toBe(true);
    expect(photos.map((p) => p.viewId)).toEqual(["front-right", "front-left", "front"]);
    expect(progress.every((v, i) => i === 0 || v >= progress[i - 1])).toBe(true);
    expect(progress.at(-1)).toBe(1);
    expect(backends).toHaveLength(1);
    expect(backends[0].disposed).toBe(true);
    expect(renderingMetadata(photos[0])).toMatchObject({ view: "front-right", mode: "pathtraced", width: 1920, height: 1080, fallbackReason: null });
  });

  it("can be cancelled; nothing is returned and the GPU resources are freed", async () => {
    const abort = new AbortController();
    const backend = fakeBackend("pathtraced", { perStep: 1 });
    const run = renderPhotoViews(views(), PT, engineDeps({ createBackend: () => backend }), {
      signal: abort.signal,
      onProgress: (p) => p.samples >= 5 && abort.abort(),
    });
    await expect(run).rejects.toMatchObject({ code: "cancelled" });
    expect(backend.disposed).toBe(true);
  });

  it("never returns a too-noisy image as a finished photorealistic render", async () => {
    const backend = fakeBackend("pathtraced", { perStep: 0.01 });
    const clock = { t: 0 };
    const deps = engineDeps({ createBackend: () => backend, now: () => (clock.t += 10_000) }, clock);
    await expect(renderPhotoViews(views().slice(0, 1), PT, deps)).rejects.toMatchObject({ code: "insufficient_samples" });
    expect(backend.disposed).toBe(true);
  });

  it("falls back to the labelled raster renderer when the GPU cannot run the path tracer", async () => {
    const log: string[] = [];
    const deps = engineDeps({ createBackend: (mode) => fakeBackend(mode, { failSetScene: mode === "pathtraced", log }) });
    const [photo] = await renderPhotoViews(views().slice(0, 1), PT, deps);
    expect(photo).toMatchObject({ mode: "raster", fallbackReason: "pathtracer_failed" });
    expect(photo.samples).toBe(QUALITY_PRESETS.fast.samples); // the fast renderer accumulates its frames
    expect(log).toEqual(["pathtraced:dispose", "raster:scene:0", "raster:dispose"]);
    await expect(
      renderPhotoViews(views().slice(0, 1), { ...PT, allowRasterFallback: false }, deps),
    ).rejects.toMatchObject({ code: "failed" });
  });

  it("reports unsupported browsers and labels detected fallbacks", async () => {
    await expect(renderPhotoViews(views(), PT, engineDeps({ choice: { mode: "unsupported", reason: "no_webgl" } }))).rejects.toBeInstanceOf(PhotoRenderError);
    const [raster] = await renderPhotoViews(views().slice(0, 1), PT, engineDeps({ choice: { mode: "raster", reason: "software_gpu" } }));
    expect(raster).toMatchObject({ mode: "raster", fallbackReason: "software_gpu" });
  });
});

describe("photo job", () => {
  beforeEach(() => clearPhotoCache());
  afterEach(() => vi.restoreAllMocks());

  function jobDeps(overrides: Partial<PhotoJobDeps> = {}) {
    const { scene } = liveScene();
    const a = arrangement();
    let t = 0;
    const created: ReturnType<typeof fakeBackend>[] = [];
    const captures = vi.fn(() => ({ arrangement: a, snapshot: takeSnapshot(scene) }));
    const deps: PhotoJobDeps = {
      capture: captures,
      choice: () => GPU,
      autoQuality: () => "standard",
      loadEnvironment: async () => new Texture(),
      upgradeTextures: async () => 0,
      createBackend: (mode) => (created.push(fakeBackend(mode)), created.at(-1)!),
      now: () => (t += 50),
      nextFrame: async () => {},
      sleep: async () => {},
      ...overrides,
    };
    return { deps, created, captures, arrangement: a, scene };
  }

  it("renders all views from one snapshot of the configuration", async () => {
    const { deps, captures } = jobDeps();
    const photos = await runPhotoJob({ count: 3 }, deps);
    expect(photos).toHaveLength(3);
    expect(captures).toHaveBeenCalledTimes(1);
    expect(new Set(photos.map((p) => p.settings)).size).toBe(1);
  });

  it("reuses completed renders of the same configuration and settings, and renders again on request", async () => {
    const { deps, created } = jobDeps();
    const first = await runPhotoJob({ count: 1 }, deps);
    const again = await runPhotoJob({ count: 2 }, deps);
    expect(again[0]).toBe(first[0]); // view 1 reused, only view 2 rendered
    expect(created).toHaveLength(2);
    const fresh = await runPhotoJob({ count: 1, reuse: false }, deps);
    expect(fresh[0]).not.toBe(first[0]);
    const draft = await runPhotoJob({ count: 1, settings: { quality: "high" } }, deps);
    expect(draft[0]).not.toBe(fresh[0]); // other settings: not reused
  });

  it("runs one job at a time", async () => {
    const { deps } = jobDeps();
    const first = runPhotoJob({ count: 1 }, deps);
    expect(isPhotoJobRunning()).toBe(true);
    await expect(runPhotoJob({ count: 1 }, deps)).rejects.toMatchObject({ code: "busy" });
    await first;
    expect(isPhotoJobRunning()).toBe(false);
  });

  it("waits for loading models, and gives up with a clear error instead of rendering placeholders", async () => {
    const { scene } = liveScene();
    const placeholder = new Mesh(new BoxGeometry(), new MeshBasicMaterial());
    placeholder.userData = photoTag("loading");
    scene.add(placeholder);
    const a = arrangement();
    let calls = 0;
    const { deps } = jobDeps({
      capture: () => {
        if (++calls === 3) scene.remove(placeholder); // loaded after two polls
        return { arrangement: a, snapshot: takeSnapshot(scene) };
      },
    });
    expect(await runPhotoJob({ count: 1 }, deps)).toHaveLength(1);
    scene.add(placeholder);
    let t = 0;
    const stuck = jobDeps({ capture: () => ({ arrangement: a, snapshot: takeSnapshot(scene) }), now: () => (t += 5000) });
    await expect(runPhotoJob({ count: 1 }, stuck.deps)).rejects.toMatchObject({ code: "models_loading" });
  });

  it("a failed render leaves the live scene and the configuration exactly as they were", async () => {
    const { deps, scene, arrangement: a } = jobDeps({ createBackend: () => fakeBackend("pathtraced", { failSetScene: true }) });
    const before = JSON.stringify(a);
    const sceneBefore = scene.children.map((c) => [c.uuid, c.visible, c.position.toArray()]);
    await expect(runPhotoJob({ count: 2, settings: { allowRasterFallback: false } }, deps)).rejects.toMatchObject({ code: "failed" });
    expect(JSON.stringify(a)).toBe(before);
    expect(scene.children.map((c) => [c.uuid, c.visible, c.position.toArray()])).toEqual(sceneBefore);
    expect(isPhotoJobRunning()).toBe(false);
    // and a retry works
    const ok = jobDeps();
    expect(await runPhotoJob({ count: 1 }, ok.deps)).toHaveLength(1);
  });

  it("covers every module of the arrangement (geometry and room unchanged)", async () => {
    let a = arrangement(["cabinet", "clickbed-o"]);
    const resized = updateModuleConfiguration(a, a.modules[0].id, { ...(a.modules[0].configuration as object) } as never);
    if (resized.ok) a = resized.value.arrangement;
    const subject = photoSubject(a);
    const views = planPhotoViews(a, 3, 16 / 9);
    for (const view of views)
      for (const corner of boxCorners(subject)) {
        const ndc = projectNdc(view.camera, corner);
        expect(Math.abs(ndc.x)).toBeLessThanOrEqual(1);
        expect(Math.abs(ndc.y)).toBeLessThanOrEqual(1);
      }
    expect(a.room).toEqual({ ...DEFAULT_ROOM, width: 6000 });
  });
});

describe("right mouse button", () => {
  it("opens the furniture menu on a click but not after a right-drag pan of the camera", () => {
    expect(opensContextMenu(0)).toBe(true);
    expect(opensContextMenu(3)).toBe(true);
    expect(opensContextMenu(40)).toBe(false);
  });
});

describe("render engine timing and previews", () => {
  const view = () => planPhotoViews(arrangement(), 1, 16 / 9);

  it("reports shader compilation separately and counts the time limit from the first sample", async () => {
    let steps = 0;
    const phases: string[] = [];
    const backend: PhotoBackend = {
      mode: "pathtraced",
      get compiling() {
        return steps < 5;
      },
      setScene: async () => {},
      step: () => (++steps < 5 ? 0 : (steps - 4) * 8),
      output: async () => new Blob(["x"], { type: "image/png" }),
      dispose: () => {},
    };
    // Each step "takes" 30 s: compilation (4 steps = 120 s) must not eat the standard 150 s budget.
    let t = 0;
    const [photo] = await renderPhotoViews(view(), PT, engineDeps({ createBackend: () => backend, now: () => (t += 30_000) }), {
      onProgress: (p) => phases.push(p.phase),
    });
    expect(phases.slice(1, 4)).toEqual(["compiling", "compiling", "compiling"]);
    expect(phases).toContain("rendering");
    expect(photo.samples).toBeGreaterThanOrEqual(QUALITY_PRESETS.standard.minSamples);
  });

  it("gives up on a path tracer that never produces a sample and uses the labelled fallback", async () => {
    const stuck: PhotoBackend = { ...fakeBackend("pathtraced"), compiling: true, step: () => 0 };
    let t = 0;
    const [photo] = await renderPhotoViews(view(), PT, engineDeps({ createBackend: (mode) => (mode === "pathtraced" ? stuck : fakeBackend("raster")), now: () => (t += 20_000) }));
    expect(photo).toMatchObject({ mode: "raster", fallbackReason: "pathtracer_failed" });
  });

  it("delivers the converging image while path tracing", async () => {
    const previews: Blob[] = [];
    let t = 0;
    await renderPhotoViews(view(), PT, engineDeps({ createBackend: () => fakeBackend("pathtraced", { perStep: 4 }), now: () => (t += 3_000) }), {
      onPreview: (_view, image) => previews.push(image),
    });
    expect(previews.length).toBeGreaterThan(2);
  });
});

describe("backend pool", () => {
  function pool() {
    const created: ReturnType<typeof fakeBackend>[] = [];
    const timers: (() => void)[] = [];
    const p = createBackendPool(
      (mode) => (created.push(fakeBackend(mode)), created.at(-1)!),
      1000,
      { set: (fn) => timers.push(fn), clear: () => {} },
    );
    return { p, created, timers };
  }

  it("keeps the renderer between renders (no second shader compilation) and frees it when idle", async () => {
    const { p, created, timers } = pool();
    const first = p.acquire("pathtraced", DEFAULT_PHOTO_SETTINGS);
    first.dispose();
    expect(created[0].disposed).toBe(false);
    const second = p.acquire("pathtraced", { ...DEFAULT_PHOTO_SETTINGS, quality: "high" });
    expect(created).toHaveLength(1);
    second.dispose();
    timers.at(-1)!(); // idle timeout
    expect(created[0].disposed).toBe(true);
    expect(p.idle).toBe(false);
  });

  it("forwards the output checks of the pooled backend (invalid pixels, exposure)", () => {
    const p = createBackendPool(() => ({ ...fakeBackend("raster"), invalidFraction: () => 0.3, exposure: 0.7 }));
    const leased = p.acquire("raster", DEFAULT_PHOTO_SETTINGS);
    expect(leased.invalidFraction?.()).toBe(0.3);
    expect(leased.exposure).toBe(0.7);
    expect(createBackendPool(() => fakeBackend("raster")).acquire("raster", DEFAULT_PHOTO_SETTINGS).invalidFraction).toBeUndefined();
  });

  it("never reuses a backend that failed, and replaces one of another size", async () => {
    const { p, created } = pool();
    const failing = p.acquire("pathtraced", DEFAULT_PHOTO_SETTINGS);
    created[0].step = () => {
      throw new Error("context lost");
    };
    expect(() => failing.step(10)).toThrow();
    failing.dispose();
    expect(created[0].disposed).toBe(true);
    p.acquire("pathtraced", DEFAULT_PHOTO_SETTINGS).dispose();
    expect(created).toHaveLength(2);
    p.acquire("pathtraced", { ...DEFAULT_PHOTO_SETTINGS, width: 2560, height: 1440 });
    expect(created).toHaveLength(3);
    expect(created[1].disposed).toBe(true);
  });
});

describe("output validity", () => {
  const view = () => planPhotoViews(arrangement(), 1, 16 / 9);

  it("never delivers an image with invalid (NaN / black) pixels; falls back to the labelled raster render", async () => {
    const corrupt = { ...fakeBackend("pathtraced"), invalidFraction: () => 0.22 };
    const [photo] = await renderPhotoViews(view(), PT, engineDeps({ createBackend: (mode) => (mode === "pathtraced" ? corrupt : fakeBackend("raster")) }));
    expect(photo).toMatchObject({ mode: "raster", fallbackReason: "pathtracer_failed" });
    await expect(
      renderPhotoViews(view(), { ...PT, allowRasterFallback: false }, engineDeps({ createBackend: () => ({ ...fakeBackend("pathtraced"), invalidFraction: () => 0.22 }) })),
    ).rejects.toMatchObject({ code: "failed" });
  });

  it("accepts a valid image (a few dark crevice pixels are fine)", async () => {
    const [photo] = await renderPhotoViews(view(), PT, engineDeps({ createBackend: () => ({ ...fakeBackend("pathtraced"), invalidFraction: () => 0.0002 }) }));
    expect(photo.mode).toBe("pathtraced");
  });
});

describe("automatic quality from measured performance", () => {
  function memoryStore() {
    const data = new Map<string, string>();
    return { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v) };
  }
  const timings = (sampling: number) => ({ setScene: 200, firstSample: 105_000, sampling });

  it("uses the fast renderer until this device has proven fast path tracing", () => {
    const store = memoryStore();
    expect(autoQuality(GPU, readPerformance(store))).toBe("fast"); // nothing measured yet
    // Intel UHD 620 as measured: 71 samples in 150 s at 1920×1080.
    const slow = recordPerformance({ mode: "pathtraced", samples: 71, width: 1920, height: 1080, timings: timings(150_000) }, store);
    expect(slow.pathtracedSppPerSecond).toBeCloseTo(0.47, 2);
    expect(slow.pathtracerStartupMs).toBe(105_200);
    expect(autoQuality(GPU, slow)).toBe("fast");
    // A GPU that reaches 192 samples in 40 s.
    const quick = recordPerformance({ mode: "pathtraced", samples: 192, width: 1920, height: 1080, timings: timings(40_000) }, store);
    expect(autoQuality(GPU, quick)).toBe("standard");
    // …but never where path tracing is unavailable.
    expect(autoQuality({ mode: "raster", reason: "software_gpu" }, quick)).toBe("fast");
  });

  it("normalizes to 1920×1080 and records the fast renderer's frame time", () => {
    const store = memoryStore();
    const half = recordPerformance({ mode: "pathtraced", samples: 100, width: 960, height: 540, timings: timings(25_000) }, store);
    expect(half.pathtracedSppPerSecond).toBe(1); // 4 spp/s at a quarter of the pixels
    const raster = recordPerformance({ mode: "raster", samples: 96, width: 1920, height: 1080, timings: timings(4800) }, store);
    expect(raster.rasterFrameMs).toBe(50);
    expect(raster.pathtracedSppPerSecond).toBe(1); // earlier measurements kept
  });

  it("resolves the requested 'auto' per device in the photo job", async () => {
    clearPhotoCache();
    const { scene } = liveScene();
    const a = arrangement();
    const settingsSeen: string[] = [];
    let t = 0;
    const deps: PhotoJobDeps = {
      capture: () => ({ arrangement: a, snapshot: takeSnapshot(scene) }),
      choice: () => GPU,
      autoQuality: () => "fast",
      loadEnvironment: async () => new Texture(),
      upgradeTextures: async () => 0,
      createBackend: (mode, s) => (settingsSeen.push(`${mode}:${s.quality}`), fakeBackend(mode)),
      now: () => (t += 50),
      nextFrame: async () => {},
      sleep: async () => {},
    };
    const [photo] = await runPhotoJob({ count: 1 }, deps);
    expect(settingsSeen).toEqual(["raster:fast"]);
    expect(photo.settings.quality).toBe("fast");
    expect(photo.timings).toMatchObject({ snapshot: expect.any(Number), prepare: expect.any(Number), job: expect.any(Number), sampling: expect.any(Number) });
  });
});


describe("highlight-protecting exposure", () => {
  it("meters light rooms down so the brightest surfaces keep their shading, and leaves dark rooms alone", () => {
    const room = (bright: number) => Float32Array.from({ length: 1000 }, (_, i) => (i / 1000) * bright);
    expect(highlightExposure(room(0.6))).toBe(1); // dark room: highlights below the shoulder
    const light = highlightExposure(room(1.15));
    expect(light).toBeLessThan(1);
    expect(light * 1.15 * HIGHLIGHT_PERCENTILE).toBeCloseTo(HIGHLIGHT_TARGET, 1);
    expect(highlightExposure(room(40))).toBe(MIN_EXPOSURE); // never more than −0.4 stops
    expect(highlightExposure(new Float32Array(0))).toBe(1);
    // Background pixels (0 in the mask) do not count.
    expect(highlightExposure(Float32Array.from([0, 0, 0, 0.5, 0.5]))).toBe(1);
  });
});

describe("main view avoids hidden furniture", () => {
  it("picks the side or height from which an unfolded bed does not hide the cabinet next to it", () => {
    let a = arrangement(["cabinet", "clickbed-o", "cabinet"]);
    const bed = a.modules[1];
    const r = setModuleState(a, bed.id, "unfolded");
    if (!r.ok) throw new Error();
    a = r.value.arrangement;
    const boxes = moduleBoxes(a.modules);
    const [main, second] = planPhotoViews(a, 2, 16 / 9);
    const defaultMain = fitPhotoCamera(photoSubject(a), viewDirection({ azimuthDeg: 34, elevationDeg: 18 }), 16 / 9);
    expect(occlusionScore(main.camera, boxes)).toBeLessThanOrEqual(occlusionScore(defaultMain, boxes));
    expect(main.id).not.toBe(second.id);
    // Furniture side by side along the wall hides nothing: the default views stay.
    expect(planPhotoViews(arrangement(), 3, 16 / 9).map((v) => v.id)).toEqual(["front-right", "front-left", "front"]);
  });

  it("scores a module hidden behind a nearer one", () => {
    const camera = fitPhotoCamera({ min: [0, 0, 0], max: [2, 2, 3] }, viewDirection({ azimuthDeg: 0, elevationDeg: 0 }), 16 / 9);
    const back: BoxM = { min: [0.5, 0, 0], max: [1.5, 1, 0.5] };
    const front: BoxM = { min: [0.4, 0, 2], max: [1.6, 1.2, 2.5] };
    expect(occlusionScore(camera, [[back], [front]])).toBeGreaterThan(0.9);
    expect(occlusionScore(camera, [[back], [{ min: [3, 0, 2], max: [4, 1, 2.5] }]])).toBe(0);
  });
});

describe("status outlines never reach the photos", () => {
  it("ignores the outline layers of live meshes: photo meshes are plain copies on the default layer", () => {
    const { scene, panel } = liveScene();
    panel.layers.enable(20); // as FurnitureOutlines does for a selected module
    panel.layers.enable(22);
    const snapshot = takeSnapshot(scene);
    const photo = buildPhotoScene(snapshot, [], null);
    const meshes = photo.children.filter((c) => c instanceof Mesh);
    expect(meshes.every((m) => m.layers.mask === 1)).toBe(true);
    // Outlines are not scene objects at all: the photo has exactly the tagged furniture and room meshes.
    expect(meshes).toHaveLength(5);
    snapshot.dispose();
  });
});
