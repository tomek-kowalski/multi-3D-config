import {
  BufferAttribute,
  BufferGeometry,
  Color,
  DataTexture,
  LinearFilter,
  LinearMipmapLinearFilter,
  Mesh,
  MeshStandardMaterial,
  RepeatWrapping,
  ClampToEdgeWrapping,
  DoubleSide,
  RGBAFormat,
  SRGBColorSpace,
  Vector3,
  type Camera,
  type Scene,
} from "three";

/**
 * Daytime exterior seen through the windows in photos (fast raster and path tracing).
 *
 * The photo scene stands on a neutral studio backdrop, which used to show through clear glazing as a
 * near-white pane. For each visible window, a distant exterior panel is placed outside it: a plane
 * `EXTERIOR.distanceM` behind the glazing, sized to exactly the region the photo camera can see through
 * that window (the window's corners projected from the camera onto the plane, plus a small margin hidden
 * by the frame and wall). It can therefore never appear beside, above or around the room — the backdrop
 * stays neutral everywhere else, and the viewport is not affected (photo scenes only).
 *
 * The panel shows a procedural, deterministic landscape (soft sky gradient with light clouds, a hazy tree
 * line and fields) mapped by world position, so it moves with correct parallax between views like a real
 * distant scene; its horizon is set relative to each window (see EXTERIOR.horizonInWindow).
 * It is emissive and unlit: its radiance matches a bright overcast-to-clear daytime sky at
 * the photo exposure. In the path tracer it also lets a little daylight in through the glazing; the sky
 * is kept low in saturation so the room takes no blue cast. Cost: one 1024 × 512 RGBA texture (2.7 MiB
 * with mips, generated once — time measured in the report) and one quad per window.
 */
export const EXTERIOR = {
  /**
   * Distance of the exterior plane behind the glazing (metres): at most this, less when the camera's far
   * plane is closer (the panel must stay well inside it for the rasterizer; the path tracer has none).
   */
  distanceM: 25,
  minDistanceM: 6,
  /**
   * World size one image covers (metres, repeats horizontally). The landscape's horizon is placed at this
   * fraction of each window's height (archviz backplate convention): the glazing shows mostly sky with the
   * tree line and fields below, from any camera height. (An eye-level horizon showed mostly fields from the
   * elevated photo cameras, tinting the room green.)
   */
  horizonInWindow: 0.3,
  imageWidthM: 64,
  imageHeightM: 32,
  /** Emitted radiance scale (linear), calibrated against the walls at the photo exposure. */
  radiance: 1.15,
  /** Extra size beyond the projected aperture, hidden by frame and wall (fraction). */
  margin: 0.04,
} as const;

const W = 1024;
const H = 512;

/** Deterministic hash → [0, 1). */
function hash(x: number, y: number, seed: number): number {
  let h = (x * 374761393 + y * 668265263 + seed * 144269504) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/** Value noise, periodic in x with `period` cells (seamless horizontal repeat). */
function noise(x: number, y: number, period: number, seed: number): number {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const fx = x - xi;
  const fy = y - yi;
  const sx = fx * fx * (3 - 2 * fx);
  const sy = fy * fy * (3 - 2 * fy);
  const p = (i: number) => ((i % period) + period) % period;
  const a = hash(p(xi), yi, seed);
  const b = hash(p(xi + 1), yi, seed);
  const c = hash(p(xi), yi + 1, seed);
  const d = hash(p(xi + 1), yi + 1, seed);
  return a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy;
}

function fbm(x: number, y: number, period: number, seed: number, octaves = 4): number {
  let sum = 0;
  let amp = 0.5;
  let f = 1;
  for (let o = 0; o < octaves; o++) {
    sum += amp * noise(x * f, y * f, period * f, seed + o);
    amp *= 0.5;
    f *= 2;
  }
  return sum;
}

const mix = (a: number, b: number, t: number) => a + (b - a) * Math.min(1, Math.max(0, t));

/** A noise field sampled on a coarse grid (seamless in x), looked up bilinearly per pixel. */
function field(gw: number, gh: number, sample: (u: number, v: number) => number): (u: number, v: number) => number {
  const grid = new Float32Array(gw * (gh + 1));
  for (let j = 0; j <= gh; j++) for (let i = 0; i < gw; i++) grid[j * gw + i] = sample(i / gw, j / gh);
  return (u, v) => {
    const x = u * gw;
    const y = Math.min(gh, Math.max(0, v * gh));
    const i0 = Math.floor(x);
    const j0 = Math.min(gh - 1, Math.floor(y));
    const fx = x - i0;
    const fy = y - j0;
    const i1 = (i0 + 1) % gw;
    const a = grid[j0 * gw + (i0 % gw)];
    const b = grid[j0 * gw + i1];
    const c = grid[(j0 + 1) * gw + (i0 % gw)];
    const d = grid[(j0 + 1) * gw + i1];
    return a + (b - a) * fx + (c - a) * fy + (a - b - c + d) * fx * fy;
  };
}

/** The landscape image (sRGB bytes, rows bottom-up: row 0 is the lowest ground). */
export function exteriorPixels(): Uint8Array {
  const data = new Uint8Array(W * H * 4);
  const horizon = H / 2;
  const zenith = [100, 143, 200];
  const skyLow = [188, 208, 230];
  const haze = [214, 220, 222];
  // Noise layers on coarse grids (the image is soft and distant; per-pixel noise adds nothing visible).
  const clouds = field(256, 64, (u, v) => fbm(u * 6, v * 4.5, 6, 3, 5));
  const fields = field(256, 64, (u, v) => fbm(u * 14, v * 6, 14, 7, 4));
  const foliage = field(512, 16, (u, v) => fbm(u * 90, v * 4, 90, 5, 3));
  const treeTop = new Float32Array(W);
  for (let x = 0; x < W; x++) treeTop[x] = 6 + 22 * fbm((x / W) * 24, 3.7, 24, 11, 5);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const u = x / W;
      let r: number;
      let g: number;
      let b: number;
      const trees = treeTop[x];
      if (y >= horizon + trees) {
        // Sky: gradient from the hazy horizon to a soft blue, with light clouds.
        const t = (y - horizon) / (H - horizon);
        const k = Math.pow(t, 0.7);
        r = mix(skyLow[0], zenith[0], k);
        g = mix(skyLow[1], zenith[1], k);
        b = mix(skyLow[2], zenith[2], k);
        const cover = Math.max(0, (clouds(u, t) - 0.48) * 2.6) * Math.min(1, t * 3);
        r = mix(r, 246, cover * 0.8);
        g = mix(g, 247, cover * 0.8);
        b = mix(b, 248, cover * 0.8);
      } else if (y >= horizon) {
        // Distant trees: dark green softened by atmospheric haze.
        const v = foliage(u, (y - horizon) / 32);
        r = mix(92, haze[0], 0.42) - 14 * v;
        g = mix(108, haze[1], 0.42) - 12 * v;
        b = mix(90, haze[2], 0.42) - 10 * v;
      } else {
        // Fields: muted greens and straw, sharper and more saturated towards the viewer (bottom).
        const t = (horizon - y) / horizon;
        const f = fields(u, t);
        const near = Math.pow(t, 0.6);
        r = mix(mix(150, 128, near), haze[0], 0.35 * (1 - near)) + 22 * (f - 0.5);
        g = mix(mix(158, 140, near), haze[1], 0.35 * (1 - near)) + 18 * (f - 0.5);
        b = mix(mix(126, 98, near), haze[2], 0.35 * (1 - near)) + 10 * (f - 0.5);
      }
      const i = (y * W + x) * 4;
      data[i] = Math.round(Math.min(255, Math.max(0, r)));
      data[i + 1] = Math.round(Math.min(255, Math.max(0, g)));
      data[i + 2] = Math.round(Math.min(255, Math.max(0, b)));
      data[i + 3] = 255;
    }
  }
  return data;
}

let texture: DataTexture | null = null;

/** The shared exterior image (generated once; never disposed: tiny and reused by every photo). */
export function exteriorTexture(): DataTexture {
  if (texture) return texture;
  texture = new DataTexture(exteriorPixels(), W, H, RGBAFormat);
  texture.name = "photo:exterior";
  texture.colorSpace = SRGBColorSpace;
  texture.wrapS = RepeatWrapping;
  texture.wrapT = ClampToEdgeWrapping;
  texture.generateMipmaps = true;
  texture.minFilter = LinearMipmapLinearFilter;
  texture.magFilter = LinearFilter;
  texture.needsUpdate = true;
  return texture;
}

interface Aperture {
  /** Outward unit normal of the window plane (away from the camera). */
  readonly normal: Vector3;
  readonly corners: Vector3[];
  readonly center: Vector3;
}

const UP = new Vector3(0, 1, 0);

/** World corners of a mesh's bounding box. */
function worldCorners(mesh: Mesh): Vector3[] {
  mesh.geometry.computeBoundingBox();
  const b = mesh.geometry.boundingBox!;
  const out: Vector3[] = [];
  for (const x of [b.min.x, b.max.x]) for (const y of [b.min.y, b.max.y]) for (const z of [b.min.z, b.max.z]) out.push(new Vector3(x, y, z).applyMatrix4(mesh.matrix));
  return out;
}

/** Glass panes grouped into windows (same plane, adjacent), each with the camera-facing normal. */
export function windowApertures(scene: Scene, eye: Vector3): Aperture[] {
  const panes: Aperture[] = [];
  for (const o of scene.children) {
    if (!(o instanceof Mesh) || o.userData.photo?.role !== "glass") continue;
    // Photo meshes carry their world transform in `matrix` (matrixAutoUpdate off): read it, never recompose it.
    // The pane's thin axis is its local z.
    const normal = new Vector3().setFromMatrixColumn(o.matrix, 2).normalize();
    const corners = worldCorners(o);
    const center = corners.reduce((s, c) => s.add(c), new Vector3()).multiplyScalar(1 / corners.length);
    if (normal.dot(center.clone().sub(eye)) < 0) normal.negate();
    if (Math.abs(normal.y) > 0.5) continue;
    panes.push({ normal, corners, center });
  }
  const groups: Aperture[] = [];
  for (const pane of panes) {
    const g = groups.find(
      (w) => w.normal.dot(pane.normal) > 0.99 && Math.abs(w.center.clone().sub(pane.center).dot(w.normal)) < 0.15 && w.corners.some((a) => pane.corners.some((b) => a.distanceTo(b) < 0.25)),
    );
    if (!g) {
      groups.push({ normal: pane.normal.clone(), corners: [...pane.corners], center: pane.center.clone() });
      continue;
    }
    g.corners.push(...pane.corners);
    g.center.copy(g.corners.reduce((s, c) => s.add(c), new Vector3()).multiplyScalar(1 / g.corners.length));
  }
  return groups;
}

/**
 * Exterior panels for the windows visible from `camera` (added to `scene`, tagged role "exterior").
 * Returns the panels (the caller's scene owns them).
 */
export function addWindowExteriors(scene: Scene, camera: Camera): Mesh[] {
  camera.updateMatrixWorld();
  const eye = new Vector3().setFromMatrixPosition(camera.matrixWorld);
  const far = (camera as Camera & { far?: number }).far ?? Infinity;
  const material = new MeshStandardMaterial({ color: new Color(0, 0, 0), emissive: new Color(1, 1, 1), emissiveMap: exteriorTexture(), emissiveIntensity: EXTERIOR.radiance, roughness: 1, metalness: 0, envMapIntensity: 0, side: DoubleSide });
  material.name = "photo:exterior";
  const panels: Mesh[] = [];
  windowApertures(scene, eye).forEach((w, index) => {
    // Each window its own plane (slightly staggered): panels of separate windows never overlap.
    // A distant view, inside the camera's far plane (oblique corners are farther than the plane distance).
    const toWindow = w.center.distanceTo(eye);
    const distance = Math.max(EXTERIOR.minDistanceM, Math.min(EXTERIOR.distanceM, far * 0.6 - toWindow)) + index * 0.5;
    const planePoint = w.center.clone().addScaledVector(w.normal, distance);
    const right = new Vector3().crossVectors(UP, w.normal).normalize();
    const up = new Vector3().crossVectors(w.normal, right).normalize();
    let minR = Infinity;
    let maxR = -Infinity;
    let minU = Infinity;
    let maxU = -Infinity;
    for (const c of w.corners) {
      const dir = c.clone().sub(eye);
      const denom = dir.dot(w.normal);
      if (denom <= 1e-6) return; // the camera is not in front of this window
      const t = planePoint.clone().sub(eye).dot(w.normal) / denom;
      const p = eye.clone().addScaledVector(dir, t);
      const r = p.dot(right);
      const u = p.dot(up);
      minR = Math.min(minR, r);
      maxR = Math.max(maxR, r);
      minU = Math.min(minU, u);
      maxU = Math.max(maxU, u);
    }
    // Horizon height on the panel: the ray through the window at horizonInWindow of its height.
    const ys = w.corners.map((c) => c.y);
    const windowY = Math.min(...ys) + (Math.max(...ys) - Math.min(...ys)) * EXTERIOR.horizonInWindow;
    const throughWindow = w.center.clone().setY(windowY).sub(eye);
    const horizonY = eye.y + (throughWindow.y * planePoint.clone().sub(eye).dot(w.normal)) / throughWindow.dot(w.normal);
    const mr = (maxR - minR) * EXTERIOR.margin;
    const mu = (maxU - minU) * EXTERIOR.margin;
    [minR, maxR, minU, maxU] = [minR - mr, maxR + mr, minU - mu, maxU + mu];
    const base = planePoint.clone().sub(right.clone().multiplyScalar(planePoint.dot(right))).sub(up.clone().multiplyScalar(planePoint.dot(up)));
    const at = (r: number, u: number) => base.clone().addScaledVector(right, r).addScaledVector(up, u);
    const quad = [at(minR, minU), at(maxR, minU), at(maxR, maxU), at(minR, maxU)];
    const positions = new Float32Array(quad.flatMap((p) => [p.x, p.y, p.z]));
    // UV from world position: horizontal along the plane, vertical from the eye-level horizon.
    const uv = new Float32Array(
      quad.flatMap((p) => [p.dot(right) / EXTERIOR.imageWidthM, 0.5 + (p.y - horizonY) / EXTERIOR.imageHeightM]),
    );
    const geometry = new BufferGeometry();
    geometry.setAttribute("position", new BufferAttribute(positions, 3));
    geometry.setAttribute("uv", new BufferAttribute(uv, 2));
    // Wound to face the room (right × up = outward normal, so the reversed order faces the camera).
    geometry.setIndex([0, 2, 1, 0, 3, 2]);
    geometry.computeVertexNormals();
    const mesh = new Mesh(geometry, material);
    mesh.name = "photo:exterior";
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    mesh.userData.photo = { role: "exterior" };
    mesh.updateMatrix();
    mesh.matrixAutoUpdate = false;
    scene.add(mesh);
    panels.push(mesh);
  });
  return panels;
}
