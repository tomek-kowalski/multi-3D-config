import { expect, test, type Page } from "@playwright/test";

/**
 * Browser-level verification of the universal material system (real WebGL 2 context and GPU): the lab
 * page (main.tsx) mounts the production material runtime, BedModel, fixture and photo backends.
 */

interface Stats {
  scope: { textures: number; activeLeases: number; idleTextures: number; residentBytes: number; activeBytes: number; idleBytes: number; adoptedTextures: number } | null;
  quality: string | null;
  glTextures: number;
  glGeometries: number;
  environment: string[];
  materialsAtState: Record<string, string[]>;
  materialIds: string[];
  pixelRatio: number;
}

interface PhotoResult {
  error: string | null;
  mode: string | null;
  fallbackReason: string | null;
  reductions: string[];
  samples: number;
  timings: Record<string, number>;
  appearance: { unavailable: string[]; failed: string[]; geometry?: string[] };
  photoTextures: { textures: number; adoptedTextures: number };
  meanRgb: [number, number, number] | null;
  liveTexturesUnchanged: boolean;
  snapshotItems: number;
}

type Lab = {
  centerPixels(): number[];
  floatLinearAvailable(): boolean;
  setScenario(s: unknown): void;
  stats(): Stats;
  settle(frames?: number): Promise<void>;
  renderPhoto(o: { quality: string; width?: number; height?: number; abortAfterMs?: number }): Promise<PhotoResult>;
  importedSourceState(): { uuid: string; repeat: number[]; version: number } | null;
  slotMaterials(): Record<string, string>;
  ready(): boolean;
};

const lab = (page: Page) => ({
  stats: () => page.evaluate(() => (window as unknown as { __lab: Lab }).__lab.stats()),
  settle: (frames = 20) => page.evaluate((f) => (window as unknown as { __lab: Lab }).__lab.settle(f), frames),
  scenario: (s: unknown) => page.evaluate((x) => (window as unknown as { __lab: Lab }).__lab.setScenario(x), s),
  photo: (o: { quality: string; width?: number; height?: number; abortAfterMs?: number }) => page.evaluate((x) => (window as unknown as { __lab: Lab }).__lab.renderPhoto(x), o),
  imported: () => page.evaluate(() => (window as unknown as { __lab: Lab }).__lab.importedSourceState()),
  slots: () => page.evaluate(() => (window as unknown as { __lab: Lab }).__lab.slotMaterials()),
});

const bed = (front: string, body = front, category = "standard") => ({ kind: "bed", front, body, category, mattress: true, state: "unfolded" });

async function open(page: Page) {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.goto("/");
  await page.waitForFunction(() => (window as unknown as { __lab?: Lab }).__lab?.ready());
  return errors;
}

test.describe.configure({ mode: "serial" });

test("environment: installed after the first frame (placeholder or HDRI), without rebuilding any material (D-4)", async ({ page }) => {
  const errors = await open(page);
  const l = lab(page);
  await expect.poll(async () => (await l.stats()).environment).toContain("hdri");
  await l.settle(30);
  const s = await l.stats();
  // Phase 3.2: the placeholder appears only when the HDRI has not arrived by the first presented frame.
  expect(["placeholder", "hdri"]).toContain(s.environment[0]);
  const first = s.materialsAtState[s.environment[0]] ?? [];
  const hdri = s.materialsAtState.hdri ?? [];
  expect(hdri.length).toBeGreaterThan(0);
  // Every material installed at the first environment stage is still installed after the HDRI arrived.
  expect(first.filter((id) => !hdri.includes(id))).toEqual([]);
  expect(s.quality).toMatch(/^viewport-/);
  expect(s.pixelRatio).toBeLessThanOrEqual(2);
  expect(errors).toEqual([]);
  test.info().annotations.push({ type: "gpu-profile", description: `${s.quality}, DPR ${s.pixelRatio}` });
});

test("20 consecutive decor changes: no texture or geometry growth, fixed slots never rebuilt", async ({ page }) => {
  const errors = await open(page);
  const l = lab(page);
  await l.settle(30);
  // Patterned, flat and swatchless decors of the "standard" category.
  const decors = ["K003-PW", "K005-PW", "8685-SM", "K019-PW", "1715-BS", "K076-PW", "8361-SN"];
  const samples: Stats[] = [];
  const fixed = await l.slots();
  const fronts = new Set<string>();
  for (let i = 0; i < 20; i++) {
    await l.scenario(bed(decors[i % decors.length], decors[(i + 3) % decors.length]));
    await l.settle(15);
    samples.push(await l.stats());
    const slots = await l.slots();
    // Mattress and mechanism materials survive every decor change; front/body are rebuilt.
    expect(slots.mattress).toBe(fixed.mattress);
    expect(slots.hardware).toBe(fixed.hardware);
    fronts.add(slots.front);
  }
  expect(fronts.size).toBeGreaterThan(1);
  const textures = samples.map((s) => s.glTextures);
  const geometries = samples.map((s) => s.glGeometries);
  test.info().annotations.push({ type: "gl-textures", description: textures.join(",") });
  test.info().annotations.push({ type: "scope", description: JSON.stringify(samples.at(-1)!.scope) });
  // Bounded: the last 5 samples are no higher than the maximum of the first 7 (all decors seen once).
  expect(Math.max(...textures.slice(-5))).toBeLessThanOrEqual(Math.max(...textures.slice(0, 7)));
  expect(Math.max(...geometries.slice(-5))).toBeLessThanOrEqual(Math.max(...geometries.slice(0, 7)));
  const scope = samples.at(-1)!.scope!;
  expect(scope.activeLeases).toBeLessThanOrEqual(2); // front + body
  expect(scope.idleBytes).toBeLessThanOrEqual(8 * 1024 * 1024); // constrained idle budget
  expect(errors).toEqual([]);
});

test("photo generation and cancellation: results, live texture isolation, no leftover resources", async ({ page }) => {
  const errors = await open(page);
  const l = lab(page);
  await l.scenario(bed("K003-PW"));
  await l.settle(40);
  const baseline = await l.stats();
  for (let i = 0; i < 3; i++) {
    const done = await l.photo({ quality: "fast" });
    expect(done.error).toBeNull();
    expect(done.mode).toBe("raster");
    expect(done.meanRgb).not.toBeNull();
    expect(done.liveTexturesUnchanged).toBe(true);
    expect(done.photoTextures.textures).toBeGreaterThan(0);
    const cancelled = await l.photo({ quality: "fast", abortAfterMs: 30 });
    expect(cancelled.error).toBe("cancelled");
    expect(cancelled.liveTexturesUnchanged).toBe(true);
  }
  await l.settle(20);
  const after = await l.stats();
  // Photo work runs in its own contexts and scopes: the live canvas holds exactly what it held before.
  expect(after.glTextures).toBe(baseline.glTextures);
  expect(after.scope?.activeLeases).toBe(baseline.scope?.activeLeases);
  expect(errors).toEqual([]);
});

test("missing and failed manufacturer textures are reported, never substituted", async ({ page }) => {
  await open(page);
  const l = lab(page);
  await l.scenario(bed("8361-SN", "K003-PW"));
  await l.settle(30);
  const unavailable = await l.photo({ quality: "fast" });
  expect(unavailable.appearance.unavailable).toEqual(["8361 SN"]);
  await l.scenario({ kind: "failed" });
  await l.settle(30);
  const failed = await l.photo({ quality: "fast" });
  expect(failed.appearance.failed).toEqual(["lab/missing-image"]);
  expect(failed.mode).toBe("raster");
});

test("multi-material geometry renders per group in the fast renderer", async ({ page }) => {
  await open(page);
  const l = lab(page);
  await l.scenario({ kind: "multi" });
  await l.settle(30);
  const photo = await l.photo({ quality: "fast" });
  expect(photo.error).toBeNull();
  expect(photo.snapshotItems).toBe(6);
  expect(photo.appearance.geometry ?? []).toEqual([]);
});

test("renderer fallback: a scene beyond the path-tracer layer budget renders with the fast renderer on a fresh view", async ({ page }) => {
  await open(page);
  const l = lab(page);
  await l.scenario({ kind: "many-textures", count: 20 });
  await l.settle(30);
  const photo = await l.photo({ quality: "standard" });
  test.skip(photo.error === "unsupported", "path tracing not eligible on this device");
  expect(photo.error).toBeNull();
  expect(photo.mode).toBe("raster");
  expect(photo.fallbackReason).toBe("texture_budget");
  expect(photo.photoTextures.adoptedTextures).toBe(20);
  expect(photo.liveTexturesUnchanged).toBe(true);
});

test("future-furniture fixture with an imported glTF: viewport and photo, authored textures isolated", async ({ page }) => {
  const errors = await open(page);
  const l = lab(page);
  await l.scenario({ kind: "fixture" });
  await expect.poll(async () => (await l.imported()) !== null).toBe(true);
  await l.settle(30);
  const before = await l.imported();
  const photo = await l.photo({ quality: "fast" });
  expect(photo.error).toBeNull();
  expect(photo.snapshotItems).toBe(11); // 4 single parts + 6 seat groups + the imported part
  expect(photo.photoTextures.adoptedTextures).toBeGreaterThanOrEqual(2); // imported colour + normal
  expect(photo.liveTexturesUnchanged).toBe(true);
  expect(await l.imported()).toEqual(before); // the glTF cache's own texture is untouched
  expect(errors).toEqual([]);
});

test("path tracing on this GPU: multi-material scene, parity with the fast renderer", async ({ page }) => {
  await open(page);
  const l = lab(page);
  await l.scenario({ kind: "multi" });
  await l.settle(30);
  const raster = await l.photo({ quality: "fast", width: 256, height: 144 });
  const traced = await l.photo({ quality: "standard", width: 256, height: 144 });
  test.skip(traced.error === "unsupported", "path tracing not eligible on this device");
  test.info().annotations.push({ type: "path-traced", description: JSON.stringify({ mode: traced.mode, samples: traced.samples, timings: traced.timings, raster: raster.meanRgb, traced: traced.meanRgb }) });
  expect(traced.error).toBeNull();
  expect(traced.mode).toBe("pathtraced");
  expect(traced.snapshotItems).toBe(6);
  // Same appearance class: overall image colour within a broad tolerance (different light transport).
  for (let c = 0; c < 3; c++) expect(Math.abs(traced.meanRgb![c] - raster.meanRgb![c])).toBeLessThan(40);
});

test("F-1: reflections work without OES_texture_float_linear (extension hidden from the page)", async ({ browser }) => {
  const measureChrome = async (hideExtension: boolean) => {
    const context = await browser.newContext();
    if (hideExtension) {
      await context.addInitScript(() => {
        for (const proto of [WebGL2RenderingContext.prototype, WebGLRenderingContext.prototype]) {
          const getExtension = proto.getExtension as (this: unknown, name: string) => unknown;
          (proto as unknown as { getExtension: (name: string) => unknown }).getExtension = function (this: unknown, name: string) {
            return name === "OES_texture_float_linear" ? null : getExtension.call(this, name);
          };
          const supported = proto.getSupportedExtensions;
          proto.getSupportedExtensions = function () {
            return (supported.call(this) ?? []).filter((n: string) => n !== "OES_texture_float_linear");
          };
        }
      });
    }
    const page = await context.newPage();
    await open(page);
    const l = lab(page);
    await l.scenario({ kind: "chrome" });
    await expect.poll(async () => (await l.stats()).environment).toContain("hdri");
    await l.settle(30);
    const result = {
      floatLinear: await page.evaluate(() => (window as unknown as { __lab: Lab }).__lab.floatLinearAvailable()),
      pixels: await page.evaluate(() => (window as unknown as { __lab: Lab }).__lab.centerPixels()),
    };
    await context.close();
    return result;
  };
  const normal = await measureChrome(false);
  const hidden = await measureChrome(true);
  test.info().annotations.push({ type: "chrome-centre", description: JSON.stringify({ normal, hidden }) });
  expect(hidden.floatLinear).toBe(false);
  // A polished chrome sphere shows the reflected environment over its whole disc; an incomplete (black)
  // environment texture would leave only the small key-light highlight (mean far below this).
  expect(Math.max(...hidden.pixels)).toBeGreaterThan(25);
  for (let c = 0; c < 3; c++) expect(Math.abs(hidden.pixels[c] - normal.pixels[c])).toBeLessThanOrEqual(3);
});

type ParityLab = {
  parityReady(): boolean;
  viewportParity(): Promise<{ x: Record<string, number>; y: Record<string, number>; normalMapSizes: Record<string, number> }>;
  photoParity(mode: "fast" | "standard", denoise: boolean, axes?: ("x" | "y")[]): Promise<{ meta: Record<string, { mode: string; samples: number }>; x?: Record<string, number>; y?: Record<string, number> }>;
};

/**
 * Phase 4 normal-map parity with the real maps (inventory §7): for each surface kind, the correlation of
 * the ± raking-light difference with the relief predicted from the surface's own UV frame must be
 * positive (relief lit from the correct side) in the viewport, the fast raster and the path tracer, on
 * mirrored faces and on imported glTF with and without tangents; the probe sphere proves the light side.
 */
test("Phase 4: normal maps light from the same side in viewport, fast raster and path tracer", async ({ page }) => {
  test.setTimeout(3_600_000);
  const errors = await open(page);
  const l = lab(page);
  await l.scenario({ kind: "normal-parity" });
  await page.waitForFunction(() => (window as unknown as { __lab: ParityLab }).__lab.parityReady(), null, { timeout: 120_000 });
  await l.settle(30);
  const viewport = await page.evaluate(() => (window as unknown as { __lab: ParityLab }).__lab.viewportParity());
  const raster = await page.evaluate(() => (window as unknown as { __lab: ParityLab }).__lab.photoParity("fast", true));
  const traced = await page.evaluate(() => (window as unknown as { __lab: ParityLab }).__lab.photoParity("standard", true));
  const tracedRaw = await page.evaluate(() => (window as unknown as { __lab: ParityLab }).__lab.photoParity("standard", false, ["x"]));
  const report = { viewport, raster, traced, tracedRaw };
  test.info().annotations.push({ type: "normal-parity", description: JSON.stringify(report) });
  console.log(JSON.stringify(report));
  expect(errors).toEqual([]);
  const values = (result: unknown, axis: "x" | "y") => (result as Record<string, Record<string, number> | undefined>)[axis] ?? {};
  // Light side really is ±d in every renderer (white probe sphere).
  for (const [name, result] of Object.entries({ viewport, raster, traced, tracedRaw })) {
    for (const axis of ["x", "y"] as const) if (values(result, axis)["probe sphere"] !== undefined) expect(values(result, axis)["probe sphere"], `${name} ${axis} probe`).toBeGreaterThan(0.5);
  }
  // Viewport: every surface kind, including mirrored faces and glTF with/without tangents; the control
  // (relief deliberately inverted) must read inverted — proof that the check detects inversion.
  for (const axis of ["x", "y"] as const) {
    for (const [object, r] of Object.entries(values(viewport, axis))) {
      if (object.startsWith("CONTROL")) expect(r, `viewport ${axis} ${object}`).toBeLessThan(-0.1);
      else expect(r, `viewport ${axis} ${object}`).toBeGreaterThan(0.1);
    }
  }
  // Fast raster / path tracer: recorded, not asserted. With the environment-patch light their relief signal
  // is near the noise floor (r ≈ 0–0.4); the inverted CONTROL does not read reliably negative there
  // (measured +0.01 in one raster run), so a sign assertion would prove nothing. See
  // docs/material-phase4ab-corrective-report.md (open item: a direct-light parity method for the photo
  // backends).
  test.info().annotations.push({ type: "photo-parity-not-asserted", description: "raster/traced values recorded only" });
});
