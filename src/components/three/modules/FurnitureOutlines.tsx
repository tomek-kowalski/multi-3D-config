"use client";

import { useFrame, useThree } from "@react-three/fiber";
import { useEffect, useRef } from "react";
import { Color, MeshBasicMaterial, ShaderMaterial, Vector2, WebGLRenderTarget, type Object3D } from "three";
import { FullScreenQuad } from "three/examples/jsm/postprocessing/Pass.js";
import type { ModuleId } from "@/domain/modules/types";
import { readPhotoTag } from "../photo/tags";
import { STATUS_COLORS, type FurnitureStatus } from "./furnitureStatus";

type OutlinedStatus = Exclude<FurnitureStatus, "normal">;

/** Render layers used only to draw the outline masks (never seen by the regular render or the photos). */
const LAYERS: Readonly<Record<OutlinedStatus, number>> = { selected: 20, valid: 21, collision: 22 };
/** Outline width in CSS pixels. */
const WIDTH_PX = 2.5;

const OUTLINE = () =>
  new ShaderMaterial({
    uniforms: { tMask: { value: null }, texel: { value: new Vector2() }, radius: { value: WIDTH_PX } },
    vertexShader: "varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }",
    fragmentShader: /* glsl */ `
      uniform sampler2D tMask; uniform vec2 texel; uniform float radius; varying vec2 vUv;
      void main() {
        // Inside a silhouette: nothing (the furniture itself stays untouched).
        if (texture2D(tMask, vUv).a > 0.5) discard;
        vec4 found = vec4(0.0);
        float nearest = 1e9;
        for (int i = 0; i < 16; i++) {
          float a = float(i) * 0.3926991;
          vec2 dir = vec2(cos(a), sin(a));
          for (int k = 1; k <= 3; k++) {
            float d = radius * float(k) / 3.0;
            vec4 m = texture2D(tMask, vUv + dir * d * texel);
            if (m.a > 0.5 && d < nearest) { nearest = d; found = m; }
          }
        }
        if (found.a < 0.5) discard;
        // Soft edge: full strength at the silhouette, fading over the outline width.
        gl_FragColor = vec4(found.rgb, 0.9 * (1.0 - 0.5 * (nearest / radius)));
        #include <colorspace_fragment>
      }`,
    transparent: true,
    depthTest: false,
    depthWrite: false,
    toneMapped: false,
  });

function createResources() {
  const masks = Object.fromEntries(
    (Object.keys(LAYERS) as OutlinedStatus[]).map((status) => [status, new MeshBasicMaterial({ color: new Color(STATUS_COLORS[status]) })]),
  ) as Record<OutlinedStatus, MeshBasicMaterial>;
  const outline = OUTLINE();
  return { target: new WebGLRenderTarget(1, 1), masks, outline, quad: new FullScreenQuad(outline) };
}

/**
 * Status outlines of the furniture (selected blue, valid green, collision red; see furnitureStatus.ts)
 * around the silhouette of the furniture actually drawn — the furniture meshes themselves, not their
 * volumes. Drawn as a screen-space pass after the regular render: the meshes of the outlined modules
 * are rendered into a mask in their status colour, and a thin edge is drawn around the mask. Materials
 * are never touched, nothing is added to the scene (no raycasting, no effect on the photo renderer).
 */
export function FurnitureOutlines({ statuses }: { statuses: ReadonlyMap<ModuleId, OutlinedStatus> }) {
  const invalidate = useThree((s) => s.invalidate);
  // WebGL resources: created on the first frame that needs them, disposed with the component.
  const resourcesRef = useRef<ReturnType<typeof createResources> | null>(null);

  useEffect(() => {
    invalidate();
  }, [statuses, invalidate]);

  useEffect(
    () => () => {
      const r = resourcesRef.current;
      if (!r) return;
      r.target.dispose();
      Object.values(r.masks).forEach((m) => m.dispose());
      r.outline.dispose();
      r.quad.dispose();
    },
    [],
  );

  // Priority 1: this callback renders the frame (the regular scene first, then the outlines).
  useFrame(({ gl, scene, camera }) => {
    gl.render(scene, camera);
    // Put the furniture meshes of each outlined module on its status layer (and nobody else's).
    const active = new Set<OutlinedStatus>();
    scene.traverse((object: Object3D) => {
      const id = object.userData.moduleId as ModuleId | undefined;
      if (!id) return;
      const status = statuses.get(id) ?? null;
      object.traverse((child) => {
        for (const layer of Object.values(LAYERS)) child.layers.disable(layer);
        const tag = readPhotoTag(child.userData);
        if (status && tag && tag.role !== "loading" && (child as { isMesh?: boolean }).isMesh) child.layers.enable(LAYERS[status]);
      });
      if (status) active.add(status);
    });
    if (active.size === 0) return;
    const resources = (resourcesRef.current ??= createResources());

    const size = gl.getDrawingBufferSize(new Vector2());
    if (resources.target.width !== size.x || resources.target.height !== size.y) resources.target.setSize(size.x, size.y);
    const mask = camera.layers.mask;
    const background = scene.background;
    const override = scene.overrideMaterial;
    const autoClear = gl.autoClear;
    const clearColor = gl.getClearColor(new Color());
    const clearAlpha = gl.getClearAlpha();
    scene.background = null;
    gl.setRenderTarget(resources.target);
    gl.setClearColor(0x000000, 0);
    gl.clear();
    gl.autoClear = false;
    // Collision last: where silhouettes overlap, the most important status wins.
    for (const status of ["selected", "valid", "collision"] as const) {
      if (!active.has(status)) continue;
      camera.layers.set(LAYERS[status]);
      scene.overrideMaterial = resources.masks[status];
      gl.render(scene, camera);
    }
    camera.layers.mask = mask;
    scene.overrideMaterial = override;
    scene.background = background;
    gl.setRenderTarget(null);
    resources.outline.uniforms.tMask.value = resources.target.texture;
    resources.outline.uniforms.texel.value.set(1 / size.x, 1 / size.y);
    resources.outline.uniforms.radius.value = WIDTH_PX * gl.getPixelRatio();
    resources.quad.render(gl);
    gl.autoClear = autoClear;
    gl.setClearColor(clearColor, clearAlpha);
  }, 1);

  return null;
}
