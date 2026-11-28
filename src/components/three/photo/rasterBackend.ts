"use client";

import {
  Box3,
  Color,
  CubeCamera,
  DataUtils,
  DirectionalLight,
  HemisphereLight,
  HalfFloatType,
  Mesh,
  PCFShadowMap,
  PMREMGenerator,
  RectAreaLight,
  RGBAFormat,
  ShaderMaterial,
  Sphere,
  SRGBColorSpace,
  Vector3,
  WebGLCubeRenderTarget,
  WebGLRenderer,
  WebGLRenderTarget,
  type Material,
  type MeshStandardMaterial,
  type PerspectiveCamera,
  type Scene,
  type Texture,
  type ToneMapping,
} from "three";
import { GTAOPass } from "three/examples/jsm/postprocessing/GTAOPass.js";
import { FullScreenQuad } from "three/examples/jsm/postprocessing/Pass.js";
import type { PhotoMode } from "./capabilities";
import { GuidedDenoiser } from "./denoiser";
import { AutoExposure } from "./exposure";
import type { PhotoBackend } from "./photoEngine";
import { QUALITY_PRESETS, type PhotoSettings } from "./photoSettings";

/**
 * Fast photorealistic rasterization ("Szybki"): the same snapshot scene, PBR materials and HDRI as the
 * path tracer, rendered with WebGL rasterization many times and averaged:
 * - each frame is rendered with a sub-pixel camera offset (Halton sequence): antialiasing;
 * - each frame is lit by ONE shadow-casting light from a different direction, alternately
 *   - from a point on the ceiling softbox (the path tracer's area light): soft furniture shadows, and
 *   - from the open sky above the room (cosine-weighted hemisphere): soft contact shadows and
 *     occlusion in corners, under and inside furniture, computed from the real geometry;
 *   the average of many such frames is the soft, area-lit image;
 * - the HDRI (prefiltered) adds reflections and a weak unshadowed fill;
 * - ground-truth ambient occlusion (GTAO, screen space, computed once per view) adds the millimetre-scale
 *   occlusion shadow maps cannot resolve: panel grooves, joints, inner corners;
 * - the guided denoiser smooths the remaining shadow banding (lighting only; textures untouched).
 * Typical cost: tens of milliseconds per frame, so an image takes seconds; no long shader compilation
 * (standard three.js materials).
 */
export interface RasterLighting {
  /** HDRI contribution (unshadowed: reflections and fill). */
  readonly environmentIntensity: number;
  /**
   * Light bounced off the floor (the path tracer computes it; rasterization does not): a hemisphere
   * fill whose lower colour is the configured floor colour, so the room takes the floor's warmth.
   */
  readonly bounceIntensity: number;
  /** Average intensity of the softbox frames and of the sky frames. */
  readonly keyIntensity: number;
  readonly skyIntensity: number;
}

/**
 * Calibrated against the path-traced image of the same scene and camera (region means of walls, floor,
 * furniture): rasterization has no light bouncing between the room surfaces, so the direct light and
 * the unshadowed fill are stronger than the path tracer's.
 */
export const RASTER_LIGHTING: RasterLighting = { environmentIntensity: 0.35, bounceIntensity: 0.6, keyIntensity: 2.3, skyIntensity: 2.1 };

/**
 * Metals show almost nothing but reflections. The path tracer reflects the lit room itself (walls, floor,
 * furniture, the window's exterior) plus the HDRI. Phase 3 stood in for the room with the HDRI at 1.6×,
 * which made polished hardware a uniform white (handles read as white lines, knobs as dots: the studio
 * HDRI is bright almost everywhere). Since Phase 4AB.2 the fast renderer reflects the room too: one cube
 * capture of the lit photo scene per view (ROOM_PROBE_SIZE² per face, prefiltered for roughness) is the
 * metals' environment map, at its physical intensity. Per-view material copies — the snapshot's
 * materials and their appearance definition are unchanged.
 */
export const RASTER_METAL_ENVIRONMENT_INTENSITY = 1;
/** Face size of the room reflection capture (6 faces; RGBA16F; ~1.5 MiB plus its PMREM). */
export const ROOM_PROBE_SIZE = 256;
/** Height of the capture point above the floor (furniture hardware height, metres). */
const ROOM_PROBE_HEIGHT_M = 1.1;
const METALLIC = 0.5;

/**
 * Average colour of the HDRI's upper hemisphere (solid-angle weighted), normalized to luminance 1: the
 * colour of the daylight the sky frames bring in, so the fast image has the path tracer's colour cast.
 */
export function environmentTint(texture: Texture): Color {
  const image = texture.image as { data?: ArrayLike<number>; width?: number; height?: number } | undefined;
  const data = image?.data;
  const width = image?.width ?? 0;
  const height = image?.height ?? 0;
  if (!data || !width || !height) return new Color(1, 1, 1);
  const half = data instanceof Uint16Array;
  const value = (i: number) => (half ? DataUtils.fromHalfFloat(data[i]) : data[i]);
  const channels = data.length / (width * height);
  let r = 0;
  let g = 0;
  let b = 0;
  for (let y = 0; y < height / 2; y += 2) {
    // Equirectangular rows: solid angle ∝ cos(latitude); top row = zenith.
    const weight = Math.sin(((y + 0.5) / height) * Math.PI);
    for (let x = 0; x < width; x += 2) {
      const i = (y * width + x) * channels;
      r += value(i) * weight;
      g += value(i + 1) * weight;
      b += value(i + 2) * weight;
    }
  }
  const luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  return luminance > 0 ? new Color(r / luminance, g / luminance, b / luminance) : new Color(1, 1, 1);
}

function halton(index: number, base: number): number {
  let f = 1;
  let r = 0;
  for (let i = index; i > 0; i = Math.floor(i / base)) {
    f /= base;
    r += f * (i % base);
  }
  return r;
}

const AVERAGE = () =>
  new ShaderMaterial({
    uniforms: { tAccum: { value: null }, tFrame: { value: null }, weight: { value: 1 } },
    vertexShader: "varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }",
    fragmentShader: /* glsl */ `
      uniform sampler2D tAccum, tFrame; uniform float weight; varying vec2 vUv;
      void main() { gl_FragColor = mix(texture2D(tAccum, vUv), texture2D(tFrame, vUv), weight); }`,
    depthTest: false,
    depthWrite: false,
  });

/** Applies the ambient occlusion to the accumulated image (strength 0–1). */
const APPLY_AO = () =>
  new ShaderMaterial({
    uniforms: { tColor: { value: null }, tAO: { value: null }, strength: { value: 0.65 } },
    vertexShader: "varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }",
    fragmentShader: /* glsl */ `
      uniform sampler2D tColor, tAO; uniform float strength; varying vec2 vUv;
      void main() { vec4 c = texture2D(tColor, vUv); gl_FragColor = vec4(c.rgb * mix(1.0, texture2D(tAO, vUv).r, strength), c.a); }`,
    depthTest: false,
    depthWrite: false,
  });

const OUTPUT = () =>
  new ShaderMaterial({
    uniforms: { map: { value: null } },
    vertexShader: "varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }",
    fragmentShader: `uniform sampler2D map; varying vec2 vUv;
      void main() { gl_FragColor = vec4(texture2D(map, vUv).rgb, 1.0);
      #include <tonemapping_fragment>
      #include <colorspace_fragment>
      }`,
    depthTest: false,
    depthWrite: false,
  });

function canvasToBlob(canvas: HTMLCanvasElement, format: "png" | "jpeg"): Promise<Blob> {
  return new Promise((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("Image encoding failed"))), format === "png" ? "image/png" : "image/jpeg", 0.85),
  );
}

export function createFastRasterBackend(
  initial: PhotoSettings,
  environment: Texture,
  toneMapping: (s: PhotoSettings) => ToneMapping,
  lighting: RasterLighting = RASTER_LIGHTING,
): PhotoBackend & { configure(settings: PhotoSettings): void } {
  let settings = initial;
  const canvas = document.createElement("canvas");
  canvas.width = settings.width;
  canvas.height = settings.height;
  const renderer = new WebGLRenderer({ canvas, antialias: false, alpha: false, preserveDrawingBuffer: true, powerPreference: "high-performance" });
  renderer.setPixelRatio(1);
  renderer.setSize(settings.width, settings.height, false);
  renderer.outputColorSpace = SRGBColorSpace;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = PCFShadowMap;
  renderer.shadowMap.autoUpdate = true;
  const pmrem = new PMREMGenerator(renderer);
  const prefiltered = pmrem.fromEquirectangular(environment).texture;
  const probeTarget = new WebGLCubeRenderTarget(ROOM_PROBE_SIZE, { type: HalfFloatType });
  const probeCamera = new CubeCamera(0.05, 80, probeTarget);
  let roomReflections: WebGLRenderTarget | null = null;
  const make = () => new WebGLRenderTarget(settings.width, settings.height, { type: HalfFloatType, format: RGBAFormat, depthBuffer: true });
  const frameTarget = make();
  let accum = [make(), make()];
  const average = AVERAGE();
  const output = OUTPUT();
  const applyAo = APPLY_AO();
  const occluded = make();
  const aoScratch = make();
  let gtao: GTAOPass | null = null;
  let aoReady = false;
  const quad = new FullScreenQuad(average);
  const denoiser = new GuidedDenoiser(renderer);
  const metering = new AutoExposure(renderer);
  let exposure = 1;
  const light = new DirectionalLight("#fffaf2", 1);
  const keyColor = new Color("#fffaf2");
  const skyColor = environmentTint(environment);
  const bounce = new HemisphereLight(skyColor, new Color("#b79d7c"), lighting.bounceIntensity);
  light.castShadow = true;
  light.shadow.mapSize.set(2048, 2048);
  light.shadow.bias = -0.0004;
  light.shadow.normalBias = 0.015;
  const probe = new Uint16Array(4);

  let scene: Scene | null = null;
  let camera: PerspectiveCamera | null = null;
  const metalCopies = new Map<Material, MeshStandardMaterial>();
  let frames = 0;
  let sphere = new Sphere();
  let softbox: { center: Vector3; u: Vector3; v: Vector3 } | null = null;

  const configure = (next: PhotoSettings) => {
    settings = next;
    renderer.toneMapping = toneMapping(next);
    renderer.toneMappingExposure = next.exposure;
  };
  configure(initial);

  /** Light direction (towards the light) for frame i: softbox point (even frames) or sky (odd frames). */
  const lightFor = (i: number): { direction: Vector3; intensity: number; color: Color } => {
    const a = halton(i + 1, 5);
    const b = halton(i + 1, 7);
    if (i % 2 === 0 && softbox) {
      const point = softbox.center.clone().addScaledVector(softbox.u, a - 0.5).addScaledVector(softbox.v, b - 0.5);
      return { direction: point.sub(sphere.center).normalize(), intensity: lighting.keyIntensity * 2, color: keyColor };
    }
    // Cosine-weighted direction over the upper hemisphere, at least 12° above the horizon.
    const phi = 2 * Math.PI * a;
    const cosTheta = Math.sqrt(1 - b * 0.96);
    const sinTheta = Math.sqrt(1 - cosTheta * cosTheta);
    return { direction: new Vector3(Math.cos(phi) * sinTheta, cosTheta, Math.sin(phi) * sinTheta), intensity: lighting.skyIntensity * 2, color: skyColor };
  };

  const renderFrame = () => {
    if (!scene || !camera) return;
    const { direction, intensity, color } = lightFor(frames);
    light.intensity = intensity;
    light.color.copy(color);
    light.position.copy(sphere.center).addScaledVector(direction, sphere.radius * 2);
    light.target.position.copy(sphere.center);
    const cam = light.shadow.camera;
    Object.assign(cam, { left: -sphere.radius, right: sphere.radius, top: sphere.radius, bottom: -sphere.radius, near: 0.05, far: sphere.radius * 4 });
    cam.updateProjectionMatrix();
    light.target.updateMatrixWorld();
    light.updateMatrixWorld();
    // Sub-pixel jitter (antialiasing).
    const jx = halton(frames + 1, 2) - 0.5;
    const jy = halton(frames + 1, 3) - 0.5;
    camera.setViewOffset(settings.width, settings.height, jx, jy, settings.width, settings.height);
    renderer.setRenderTarget(frameTarget);
    renderer.render(scene, camera);
    camera.clearViewOffset();
    // Running average: accum = mix(accum, frame, 1 / (n + 1)).
    average.uniforms.tAccum.value = accum[0].texture;
    average.uniforms.tFrame.value = frameTarget.texture;
    average.uniforms.weight.value = 1 / (frames + 1);
    quad.material = average;
    renderer.setRenderTarget(accum[1]);
    quad.render(renderer);
    accum = [accum[1], accum[0]];
    frames++;
  };

  return {
    mode: "raster" as PhotoMode,
    compiling: false,
    get exposure() {
      return exposure;
    },
    configure,
    async setScene(next: Scene, nextCamera: PerspectiveCamera) {
      scene = next;
      camera = nextCamera;
      frames = 0;
      // The path tracer's area light becomes the softbox the key frames sample (raster area lights cast no shadows).
      softbox = null;
      const areas: RectAreaLight[] = [];
      scene.traverse((o) => o instanceof RectAreaLight && areas.push(o));
      for (const area of areas) {
        area.updateMatrixWorld();
        const center = new Vector3().setFromMatrixPosition(area.matrixWorld);
        const u = new Vector3(1, 0, 0).transformDirection(area.matrixWorld).multiplyScalar(area.width);
        const v = new Vector3(0, 1, 0).transformDirection(area.matrixWorld).multiplyScalar(area.height);
        softbox = { center, u, v };
        area.removeFromParent();
      }
      scene.environment = prefiltered;
      scene.environmentIntensity = lighting.environmentIntensity;
      // The room's extent (the window exteriors are far outside it and must not widen light or shadows).
      const roomBox = new Box3();
      scene.traverse((o) => {
        if (o instanceof Mesh && o.userData.photo?.role !== "exterior") roomBox.expandByObject(o);
      });
      sphere = roomBox.getBoundingSphere(new Sphere());
      // The walls also cast shadows here: they shade the room from low sky directions.
      scene.traverse((o) => {
        if (o instanceof Mesh && o.userData.photo?.role === "wall") o.castShadow = true;
      });
      metalCopies.forEach((m) => m.dispose());
      metalCopies.clear();
      scene.traverse((o) => {
        if (!(o instanceof Mesh)) return;
        const swap = (m: Material) => {
          const metal = m as MeshStandardMaterial;
          if (!metal.isMeshStandardMaterial || metal.metalness < METALLIC) return m;
          let copy = metalCopies.get(m);
          if (!copy) {
            copy = metal.clone();
            copy.envMap = prefiltered;
            copy.envMapIntensity = RASTER_METAL_ENVIRONMENT_INTENSITY;
            metalCopies.set(m, copy);
          }
          return copy;
        };
        o.material = Array.isArray(o.material) ? o.material.map(swap) : swap(o.material);
      });
      // Floor bounce in the floor's mean albedo (walls and furniture take its warmth, as in path tracing):
      // a textured floor's colour factor is only a gain, so the factory's measured mean is used.
      let floorColor: Color | null = null;
      scene.traverse((o) => {
        if (!(o instanceof Mesh) || o.userData.photo?.role !== "floor") return;
        const m = o.material as { color: Color; userData?: { meanLinearAlbedo?: [number, number, number] } };
        const mean = m.userData?.meanLinearAlbedo;
        floorColor = mean ? new Color(mean[0], mean[1], mean[2]) : m.color;
      });
      if (floorColor) bounce.groundColor.copy(floorColor);
      scene.add(light, light.target, bounce);
      scene.updateMatrixWorld(true);
      // Compile all programs up front (three's parallel compile), then the guide buffers for the denoiser.
      await renderer.compileAsync(scene, camera);
      // The room as the metals see it: one cube capture of the lit scene (first frame's light), prefiltered.
      // Same CubeUV environment format as the HDRI, so the compiled metal programs are reused.
      {
        const started = performance.now();
        const { direction, intensity, color } = lightFor(0);
        light.intensity = intensity;
        light.color.copy(color);
        light.position.copy(sphere.center).addScaledVector(direction, sphere.radius * 2);
        light.target.position.copy(sphere.center);
        light.target.updateMatrixWorld();
        light.updateMatrixWorld();
        const metals: Mesh[] = [];
        scene.traverse((o) => {
          const copies = new Set<Material>(metalCopies.values());
          if (o instanceof Mesh && o.visible && (Array.isArray(o.material) ? o.material : [o.material]).some((m) => copies.has(m))) metals.push(o);
        });
        // Metals do not see themselves (no self-reflection from the capture point).
        metals.forEach((m) => (m.visible = false));
        probeCamera.position.set(sphere.center.x, ROOM_PROBE_HEIGHT_M, sphere.center.z);
        probeCamera.updateMatrixWorld();
        probeCamera.update(renderer, scene);
        metals.forEach((m) => (m.visible = true));
        roomReflections?.dispose();
        roomReflections = pmrem.fromCubemap(probeTarget.texture);
        metalCopies.forEach((copy) => {
          copy.envMap = roomReflections!.texture;
          copy.envMapIntensity = RASTER_METAL_ENVIRONMENT_INTENSITY;
        });
        performance.measure?.("photo:raster:room-reflections", { start: started, end: performance.now() });
      }
      gtao?.dispose();
      gtao = new GTAOPass(scene, camera, settings.width, settings.height);
      gtao.output = GTAOPass.OUTPUT.Denoise;
      gtao.updateGtaoMaterial({ radius: 0.3, distanceExponent: 1, thickness: 1, scale: 1, samples: 16 });
      aoReady = false;
      denoiser.prepare(scene, camera, settings.width, settings.height);
    },
    step(budgetMs: number) {
      const target = QUALITY_PRESETS.fast.samples;
      const started = performance.now();
      do {
        renderFrame();
        // Wait for the GPU (1-pixel read), so a step never queues more work than its budget.
        renderer.readRenderTargetPixels(accum[0], 0, 0, 1, 1, probe);
      } while (performance.now() - started < budgetMs && frames < target);
      return frames;
    },
    invalidFraction() {
      const pixels = new Uint16Array(settings.width * settings.height * 4);
      renderer.readRenderTargetPixels(accum[0], 0, 0, settings.width, settings.height, pixels);
      let invalid = 0;
      // Half floats: exponent bits all set = Inf/NaN; all three channels zero = black.
      for (let i = 0; i < pixels.length; i += 4) {
        const bad = [0, 1, 2].some((c) => (pixels[i + c] & 0x7c00) === 0x7c00);
        if (bad || (pixels[i] | pixels[i + 1] | pixels[i + 2]) === 0) invalid++;
      }
      return invalid / (settings.width * settings.height);
    },
    async output(format = "png") {
      // Ambient occlusion of this view (the camera is fixed): computed once, applied to every output.
      if (gtao && !aoReady && scene && camera) {
        camera.clearViewOffset();
        gtao.render(renderer, aoScratch, aoScratch, 0, false);
        aoReady = true;
      }
      let lit = accum[0].texture;
      if (gtao && aoReady) {
        applyAo.uniforms.tColor.value = lit;
        applyAo.uniforms.tAO.value = gtao.gtaoMap;
        quad.material = applyAo;
        renderer.setRenderTarget(occluded);
        quad.render(renderer);
        lit = occluded.texture;
      }
      const image = settings.denoise ? denoiser.denoise(lit) : lit;
      // Highlight protection: the camera exposure for this room (light rooms are metered down).
      exposure = metering.measure(image, denoiser.surfaceMask);
      renderer.toneMappingExposure = settings.exposure * exposure;
      output.uniforms.map.value = image;
      quad.material = output;
      renderer.setRenderTarget(null);
      renderer.clear();
      quad.render(renderer);
      return canvasToBlob(renderer.domElement, format);
    },
    dispose() {
      metalCopies.forEach((m) => m.dispose());
      for (const t of [frameTarget, ...accum, occluded, aoScratch]) t.dispose();
      gtao?.dispose();
      applyAo.dispose();
      average.dispose();
      output.dispose();
      quad.dispose();
      denoiser.dispose();
      metering.dispose();
      prefiltered.dispose();
      roomReflections?.dispose();
      probeTarget.dispose();
      pmrem.dispose();
      renderer.dispose();
      renderer.forceContextLoss();
    },
  };
}
