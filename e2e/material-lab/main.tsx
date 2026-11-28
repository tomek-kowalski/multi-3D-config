/**
 * TEST-ONLY material lab: drives the production material system in a real browser/GPU for
 * e2e/material-lab/material-system.labspec.ts (decor changes, environment initialization, photo generation and
 * cancellation, renderer fallback, multi-material geometry, missing/failed textures, resource
 * stability, registered vs authored isolation, the future-furniture fixture with an imported glTF).
 * Synthetic textures created here are test assets only — never manufacturer textures, never registered
 * in the application.
 */
import { Canvas, useThree } from "@react-three/fiber";
import { StrictMode, Suspense, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  BoxGeometry,
  CanvasTexture,
  DataTexture,
  Mesh,
  MeshStandardMaterial,
  NeutralToneMapping,
  PerspectiveCamera,
  RGBAFormat,
  SRGBColorSpace,
  Vector3,
  type Material,
  type Object3D,
  type Scene,
  type Texture,
  type WebGLRenderer,
} from "three";
import { GLTFExporter } from "three/examples/jsm/exporters/GLTFExporter.js";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { materialRegistry } from "@/domain/materials";
import { cabinetFinishSelection, hardwareFinishSelection } from "@/domain/materials/bindings";
import { SlotMesh } from "@/components/three/materials/SlotMesh";
import type { MeshMaterialBinding } from "@/domain/materials/contracts";
import { buildFixture, FIXTURE_REGISTRY_DATA } from "@/components/three/materials/futureFurniture.fixture";
import { MaterialRuntimeProvider, ROOM_LIGHTING, useMaterialRuntime } from "@/components/three/materials/MaterialRuntime";
import { attachMaterialBinding, createSlotMaterials, installMaterials, type MaterialRuntime, type SlotMaterialSet } from "@/components/three/materials/materialSlots";
import type { EnvironmentState } from "@/components/three/materials/SurfaceEnvironment";
import { useMaterialSlots } from "@/components/three/materials/useMaterialSlots";
import { BedModel } from "@/components/three/modules/BedModel";
import { createPathTracedBackend, createRasterBackend, loadEnvironment } from "@/components/three/photo/backends";
import { chooseRenderMode, probeGpu } from "@/components/three/photo/capabilities";
import { renderPhotoViews, type RenderedPhoto } from "@/components/three/photo/photoEngine";
import { buildPhotoScene, takeSnapshot } from "@/components/three/photo/photoScene";
import { resolvePhotoSettings, type PhotoQuality } from "@/components/three/photo/photoSettings";
import { photoTag } from "@/components/three/photo/tags";
import { NormalParity, PARITY_OBJECTS, PROBE, parity, parityGeometry, photoParity, viewportParity } from "./normalParity";

type Scenario =
  | { kind: "bed"; front: string; body: string; category: string; mattress: boolean; state: "folded" | "unfolded" }
  | { kind: "fixture" }
  | { kind: "multi" }
  | { kind: "failed" }
  | { kind: "many-textures"; count: number }
  | { kind: "chrome" }
  | { kind: "normal-parity" };

// ---- Test-only registry additions (lab page only) ----
materialRegistry.register(FIXTURE_REGISTRY_DATA);

/** A drawable 2×2 test texture (glTF export needs an image it can encode). */
function canvasTexture(colors: string[], srgb: boolean): CanvasTexture {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 2;
  const ctx = canvas.getContext("2d")!;
  colors.forEach((c, i) => {
    ctx.fillStyle = c;
    ctx.fillRect(i % 2, Math.floor(i / 2), 1, 1);
  });
  const texture = new CanvasTexture(canvas);
  if (srgb) texture.colorSpace = SRGBColorSpace;
  return texture;
}
const MISSING_URL = "/lab-test-only/does-not-exist.png";
materialRegistry.register({
  textures: [
    {
      id: "lab:missing-albedo",
      semantic: "baseColor",
      colorSpace: "srgb",
      variants: { standard: { url: MISSING_URL, width: 256, height: 256, format: "png" } },
      provenance: "TEST ONLY: deliberately missing file",
    },
  ],
  materials: [
    {
      id: "lab/missing-image",
      category: "laminate",
      color: { kind: "map", map: { assetId: "lab:missing-albedo", alignment: { kind: "surface-repeat", coverageM: [0.6, 0.6], directional: false } }, meanSrgbHex: "#7F6A55" },
      surfaceProfileId: "surface/smooth-board",
      finishProfileId: "finish/board-satin",
      provenance: "TEST ONLY",
    },
  ],
});

const lab: {
  gl: WebGLRenderer | null;
  scene: Object3D | null;
  runtime: MaterialRuntime | null;
  environment: EnvironmentState[];
  materialsAtState: Record<string, string[]>;
  setScenario: ((s: Scenario) => void) | null;
} = { gl: null, scene: null, runtime: null, environment: [], materialsAtState: {}, setScenario: null };

function meshMaterialIds(root: Object3D | null): string[] {
  const ids: string[] = [];
  root?.traverse((o) => {
    if (o instanceof Mesh) for (const m of Array.isArray(o.material) ? o.material : [o.material]) ids.push(m.uuid);
  });
  return ids;
}

function Expose() {
  const gl = useThree((s) => s.gl);
  const scene = useThree((s) => s.scene);
  const camera = useThree((s) => s.camera);
  const runtime = useMaterialRuntime();
  useEffect(() => {
    lab.gl = gl;
    lab.scene = scene;
    lab.runtime = runtime;
    (lab as unknown as { camera: unknown }).camera = camera;
  }, [gl, scene, runtime, camera]);
  return null;
}

/** A multi-material box: faces and edge bands as two slots on geometry groups. */
function BandedBox() {
  const ref = useRef<Mesh>(null);
  const geometry = useMemo(() => new BoxGeometry(0.6, 0.8, 0.02), []);
  const binding = useMemo<MeshMaterialBinding>(
    () => ({
      slots: [
        { slotId: "face", selection: cabinetFinishSelection("walnut"), mapping: { kind: "part-metres", convention: "box", grainAxis: "y", phaseM: [0, 0] }, side: "front" },
        { slotId: "edge", selection: cabinetFinishSelection("white-matte"), side: "front" },
      ],
      groups: [0, 1, 2, 3].map((i) => ({ materialIndex: i, slotId: "edge" })).concat([4, 5].map((i) => ({ materialIndex: i, slotId: "face" }))),
    }),
    [],
  );
  useMaterialSlots(ref, binding);
  return <mesh ref={ref} geometry={geometry} position={[0, 0.4, 0]} userData={photoTag("board")} />;
}

/** The future-furniture fixture plus a real imported glTF part (exported and re-loaded in the browser). */
function Fixture() {
  const runtime = useMaterialRuntime();
  const [root, setRoot] = useState<Object3D | null>(null);
  useEffect(() => {
    let disposed = false;
    const { root: built, sets } = buildFixture(runtime);
    // Synthetic imported part: embedded colour and normal textures, exported to GLB and loaded back.
    const shellMaterial = new MeshStandardMaterial({
      map: canvasTexture(["#c8b4a0", "#beaa96", "#d2beaa", "#b4a08c"], true),
      normalMap: canvasTexture(["#8080ff", "#827eff", "#7e82ff", "#8080ff"], false),
      roughness: 0.8,
    });
    const shell = new Mesh(new BoxGeometry(0.3, 0.3, 0.3), shellMaterial);
    shell.name = "imported";
    new GLTFExporter()
      .parseAsync(shell, { binary: true })
      .then((glb) => new GLTFLoader().parseAsync(glb as ArrayBuffer, ""))
      .then((gltf) => {
        if (disposed) return;
        const imported = gltf.scene.getObjectByProperty("type", "Mesh") as Mesh;
        imported.userData = photoTag("board");
        imported.position.set(1.2, 0.15, 0.3);
        // Imported glTF material, kept as authored with a selective finish override.
        const binding: MeshMaterialBinding = {
          slots: [{ slotId: "shell", selection: { kind: "authored", overrides: { finishProfileId: "finish/leather-semi-matte" } }, mapping: { kind: "authored-uv0", uvUnits: "normalized", coverageM: [0.3, 0.3] }, side: "authored" }],
          groups: [],
        };
        const source = imported.material as Material;
        (lab as unknown as { importedSource: Material }).importedSource = source;
        const set = createSlotMaterials(binding, runtime, { shell: source });
        installMaterials(imported, set, binding);
        attachMaterialBinding(imported, { binding, authored: { shell: source } });
        sets.push(set);
        built.add(imported);
        setRoot(built);
      });
    return () => {
      disposed = true;
      sets.forEach((s) => s.dispose());
    };
  }, [runtime]);
  return root ? <primitive object={root} /> : null;
}

/** A polished chrome sphere filling the view centre: shows only reflected environment (F-1 check). */
function ChromeSphere() {
  const camera = useThree((s) => s.camera);
  const invalidate = useThree((s) => s.invalidate);
  useEffect(() => {
    camera.position.set(0, 0.5, 1.6);
    camera.lookAt(0, 0.5, 0);
    invalidate();
  }, [camera, invalidate]);
  return (
    <SlotMesh selection={hardwareFinishSelection("chrome")} position={[0, 0.5, 0]} userData={photoTag("metal")}>
      <sphereGeometry args={[0.45, 48, 32]} />
    </SlotMesh>
  );
}

/** Bound mesh whose registered image does not exist (texture-load-failed path). */
function FailedImage() {
  const ref = useRef<Mesh>(null);
  const binding = useMemo<MeshMaterialBinding>(
    () => ({ slots: [{ slotId: "s", selection: { kind: "registered", id: "lab/missing-image" }, mapping: { kind: "part-metres", convention: "box", grainAxis: "x", phaseM: [0, 0] }, side: "front" }], groups: [] }),
    [],
  );
  useMaterialSlots(ref, binding);
  return (
    <mesh ref={ref} position={[0, 0.3, 0]} userData={photoTag("board")}>
      <boxGeometry args={[0.6, 0.6, 0.02]} />
    </mesh>
  );
}

/** Many distinct authored (synthetic) textures: more path-tracer layers than the standard budget. */
function ManyTextures({ count }: { count: number }) {
  const runtime = useMaterialRuntime();
  const [root, setRoot] = useState<Object3D | null>(null);
  useEffect(() => {
    let disposed = false;
    const group = new Mesh();
    const sets: SlotMaterialSet[] = [];
    {
      for (let i = 0; i < count; i++) {
        const shade = (i * 37) % 255;
        const map = new DataTexture(new Uint8Array([shade, 128, 255 - shade, 255, 0, shade, 128, 255, 255, 0, shade, 255, 128, 255, 0, 255]), 2, 2, RGBAFormat);
        map.colorSpace = SRGBColorSpace;
        map.needsUpdate = true;
        const source = new MeshStandardMaterial({ map });
        const mesh = new Mesh(new BoxGeometry(0.1, 0.1, 0.1));
        mesh.position.set((i % 6) * 0.15, 0.05 + Math.floor(i / 6) * 0.15, 0);
        mesh.userData = photoTag("board");
        const binding: MeshMaterialBinding = { slots: [{ slotId: "s", selection: { kind: "authored" }, side: "authored" }], groups: [] };
        const set = createSlotMaterials(binding, runtime, { s: source });
        installMaterials(mesh, set, binding);
        attachMaterialBinding(mesh, { binding, authored: { s: source } });
        group.add(mesh);
        sets.push(set);
      }
      queueMicrotask(() => !disposed && setRoot(group));
    }
    return () => {
      disposed = true;
      sets.forEach((s) => s.dispose());
    };
  }, [runtime, count]);
  return root ? <primitive object={root} /> : null;
}

function Lab() {
  const [scenario, setScenario] = useState<Scenario>({ kind: "bed", front: "K003-PW", body: "K003-PW", category: "standard", mattress: true, state: "unfolded" });
  useEffect(() => {
    lab.setScenario = setScenario;
  }, []);
  const onEnvironment = useMemo(
    () => (state: EnvironmentState) => {
      lab.environment.push(state);
      // Record which material objects are installed at each environment stage (rebuild detection).
      setTimeout(() => (lab.materialsAtState[state] = meshMaterialIds(lab.scene)), 50);
    },
    [],
  );
  return (
    <Canvas shadows="percentage" frameloop="demand" dpr={[1, 2]} gl={{ toneMapping: NeutralToneMapping, preserveDrawingBuffer: true }} camera={{ fov: 40, position: [2.2, 1.6, 2.6] }}>
      <color attach="background" args={["#ecebe8"]} />
      <MaterialRuntimeProvider lighting={ROOM_LIGHTING} onEnvironmentState={onEnvironment}>
        <ambientLight intensity={ROOM_LIGHTING.lighting.ambient} />
        <directionalLight position={[4, 8, 6]} intensity={ROOM_LIGHTING.lighting.key} />
        <Expose />
        <Suspense fallback={null}>
          {scenario.kind === "bed" && (
            <BedModel
              typeId="clickbed-o"
              productId={4000}
              configuration={{ size: "140x200", decorCategory: scenario.category, frontDecor: scenario.front, bodyDecor: scenario.body, mattress: scenario.mattress, firmness: scenario.mattress ? "H4" : null, addons: {} }}
              state={scenario.state}
            />
          )}
          {scenario.kind === "fixture" && <Fixture />}
          {scenario.kind === "multi" && <BandedBox />}
          {scenario.kind === "failed" && <FailedImage />}
          {scenario.kind === "many-textures" && <ManyTextures count={scenario.count} />}
          {scenario.kind === "chrome" && <ChromeSphere />}
          {scenario.kind === "normal-parity" && <NormalParity />}
        </Suspense>
      </MaterialRuntimeProvider>
    </Canvas>
  );
}

// ---- Test API ----

async function meanRgb(blob: Blob): Promise<[number, number, number]> {
  const bitmap = await createImageBitmap(blob);
  const canvas = document.createElement("canvas");
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  const ctx = canvas.getContext("2d")!;
  ctx.drawImage(bitmap, 0, 0);
  const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
  const sum = [0, 0, 0];
  for (let i = 0; i < data.length; i += 4) for (let c = 0; c < 3; c++) sum[c] += data[i + c];
  const n = data.length / 4;
  return [Math.round(sum[0] / n), Math.round(sum[1] / n), Math.round(sum[2] / n)];
}

function liveTextureState(): Record<string, number[]> {
  const out: Record<string, number[]> = {};
  lab.scene?.traverse((o) => {
    if (!(o instanceof Mesh)) return;
    for (const m of Array.isArray(o.material) ? o.material : [o.material]) {
      for (const value of Object.values(m as unknown as Record<string, unknown>)) {
        const t = value as Texture | null;
        if (t && t.isTexture) out[t.uuid] = [...t.matrix.elements, ...t.repeat.toArray(), ...t.offset.toArray(), t.version];
      }
    }
  });
  return out;
}

async function renderPhoto(options: { quality: PhotoQuality; width?: number; height?: number; abortAfterMs?: number }) {
  const scene = lab.scene!;
  const snapshot = takeSnapshot(scene);
  const before = liveTextureState();
  const controller = new AbortController();
  if (options.abortAfterMs !== undefined) setTimeout(() => controller.abort(), options.abortAfterMs);
  try {
    await snapshot.ready;
    const environment = await loadEnvironment();
    const settings = resolvePhotoSettings({ quality: options.quality, width: options.width ?? 480, height: options.height ?? 270 });
    const center = snapshot.bounds.getCenter(new Vector3());
    const size = snapshot.bounds.getSize(new Vector3()).length() || 1;
    const view = { id: "front-right", camera: { position: [center.x + size, center.y + size * 0.6, center.z + size * 1.2], target: center.toArray(), fov: 40 }, hiddenWalls: [] };
    let photo: RenderedPhoto | null = null;
    let error: string | null = null;
    try {
      [photo] = await renderPhotoViews(
        [view as never],
        settings,
        {
          choice: chooseRenderMode(probeGpu()),
          createBackend: (mode, s) => (mode === "pathtraced" ? createPathTracedBackend(s, environment) : createRasterBackend(s, environment)),
          buildView: () => {
            const camera = new PerspectiveCamera(40, settings.width / settings.height, 0.05, 100);
            camera.position.set(...(view.camera.position as [number, number, number]));
            camera.lookAt(center);
            camera.updateMatrixWorld();
            return { scene: buildPhotoScene(snapshot, [], environment), camera };
          },
          now: () => performance.now(),
          nextFrame: () => new Promise((r) => requestAnimationFrame(() => r())),
        },
        { signal: controller.signal },
      );
    } catch (e) {
      error = (e as { code?: string }).code ?? String(e);
    }
    const after = liveTextureState();
    return {
      error,
      mode: photo?.mode ?? null,
      fallbackReason: photo?.fallbackReason ?? null,
      reductions: photo?.reductions ?? [],
      samples: photo?.samples ?? 0,
      timings: photo?.timings ?? {},
      appearance: snapshot.diagnostics(),
      photoTextures: snapshot.textureStats(),
      meanRgb: photo ? await meanRgb(photo.blob) : null,
      liveTexturesUnchanged: JSON.stringify(before) === JSON.stringify(after),
      snapshotItems: snapshot.items.length,
    };
  } finally {
    snapshot.dispose();
  }
}

function stats() {
  const gl = lab.gl!;
  return {
    scope: lab.runtime?.textures.stats() ?? null,
    quality: lab.runtime?.quality.id ?? null,
    glTextures: gl.info.memory.textures,
    glGeometries: gl.info.memory.geometries,
    programs: gl.info.programs?.length ?? 0,
    environment: [...lab.environment],
    materialsAtState: lab.materialsAtState,
    materialIds: meshMaterialIds(lab.scene),
    pixelRatio: gl.getPixelRatio(),
  };
}

async function settle(frames = 10) {
  for (let i = 0; i < frames; i++) await new Promise((r) => requestAnimationFrame(() => r(null)));
}

Object.assign(window, {
  __lab: {
    setScenario: (s: Scenario) => lab.setScenario?.(s),
    stats,
    settle,
    renderPhoto,
    materialIssues: () => {
      const issues: string[] = [];
      lab.scene?.traverse((o) => {
        if (o instanceof Mesh) for (const m of Array.isArray(o.material) ? o.material : [o.material]) if (m.userData?.label) issues.push(`${m.userData.label}:${m.userData.availability}`);
      });
      return issues;
    },
    /** Material identity per bed model slot (front/body/mattress/hardware). */
    slotMaterials: () => {
      const out: Record<string, string> = {};
      lab.scene?.traverse((o) => {
        const slot = o.userData?.slot as string | undefined;
        if (o instanceof Mesh && slot && o.visible !== false) out[slot] = (o.material as Material).uuid;
      });
      return out;
    },
    importedSourceState: () => {
      const source = (lab as unknown as { importedSource?: MeshStandardMaterial }).importedSource;
      return source?.map ? { uuid: source.map.uuid, repeat: source.map.repeat.toArray(), version: source.map.version } : null;
    },
    ready: () => !!lab.gl && !!lab.scene && !!lab.runtime,
    /** Mean sRGB of the central 400×400 pixels of the canvas (after a fresh render). */
    centerPixels: () => {
      const gl = lab.gl!;
      gl.render(lab.scene as never, (lab as unknown as { camera: PerspectiveCamera }).camera);
      const ctx = gl.getContext();
      const w = ctx.drawingBufferWidth;
      const h = ctx.drawingBufferHeight;
      const n = 400;
      const px = new Uint8Array(n * n * 4);
      ctx.readPixels(Math.floor(w / 2) - n / 2, Math.floor(h / 2) - n / 2, n, n, ctx.RGBA, ctx.UNSIGNED_BYTE, px);
      const mean = [0, 0, 0];
      for (let i = 0; i < px.length; i += 4) for (let c = 0; c < 3; c++) mean[c] += px[i + c] / (n * n);
      return mean.map(Math.round);
    },
    floatLinearAvailable: () => !!lab.gl?.getContext().getExtension("OES_texture_float_linear"),
    /** Normal-map parity scene built and every relief map applied. */
    parityReady: () =>
      parity.objects.length === PARITY_OBJECTS &&
      parity.objects.every((o) => o.name === PROBE || !!(o.mesh.material as MeshStandardMaterial).normalMap),
    viewportParity: () => viewportParity(lab.gl!, lab.scene as Scene),
    parityGeometry,
    photoParity: (mode: "fast" | "standard", denoise: boolean, axes?: ("x" | "y")[]) => photoParity(lab.gl!, lab.scene as Scene, mode, denoise, axes),
  },
});

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Lab />
  </StrictMode>,
);
