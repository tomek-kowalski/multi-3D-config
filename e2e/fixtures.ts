import { request as playwrightRequest, type BrowserContext, type Page } from "@playwright/test";
import { addModule, setModuleState, setPlacement, setRoom, updateModuleConfiguration } from "../src/domain/arrangement/operations";
import type { Arrangement } from "../src/domain/arrangement/types";
import { getBedOptions } from "../src/domain/beds/catalog";
import { DEFAULT_ROOM } from "../src/domain/room/defaults";
import { addOpening } from "../src/domain/room/operations";
import { toArrangementDocument } from "../src/domain/serialization/arrangementJson";
import { PHP_URL } from "./playwright.config";

export const WORKSPACE_KEY = "multi3d.workspace.v2";

function must<T>(result: { ok: true; value: T } | { ok: false; issues: readonly unknown[] }): T {
  if (!result.ok) throw new Error(JSON.stringify(result.issues));
  return result.value;
}

/**
 * A configuration with every kind of state a shared link must restore: room size and colours, an open
 * window, a rotated cabinet, an unfolded bed with a mattress.
 */
export function richArrangement(width = 5600): Arrangement {
  let a: Arrangement = { room: { ...DEFAULT_ROOM, width, depth: 4300, wallColors: { ...DEFAULT_ROOM.wallColors, left: "#AABBCC" }, floorColor: "#8A6E52" }, modules: [] };
  const opened = must(addOpening(a.room, "window", "back"));
  a = setRoom(a, { ...opened.room, openings: opened.room.openings.map((o) => ({ ...o, open: true })) });
  a = must(addModule(a, "cabinet")).arrangement;
  const bed = must(addModule(a, "clickbed-o"));
  a = bed.arrangement;
  const options = getBedOptions(4000);
  const bedModule = a.modules.find((m) => m.id === bed.id)!;
  const firmness = options.firmness?.values[0].label ?? null;
  a = must(updateModuleConfiguration(a, bed.id, { ...(bedModule.configuration as object), mattress: true, firmness })).arrangement;
  a = must(setModuleState(a, bed.id, "unfolded")).arrangement;
  a = must(setPlacement(a, a.modules[0].id, { rotationDeg: 90, x: 2600, z: 900 })).arrangement;
  return a;
}

export function documentOf(a: Arrangement) {
  return toArrangementDocument(a);
}

/** Starts this tab with a given working configuration (as if the customer had built it). */
export async function seedWorkspace(page: Page, arrangement: Arrangement) {
  const stored = { v: 2, id: crypto.randomUUID(), origin: "new", arrangement: documentOf(arrangement), baselineKey: "{}" };
  await page.addInitScript(
    ([key, value]) => {
      if (!sessionStorage.getItem("e2e-seeded")) {
        sessionStorage.setItem(key, value);
        sessionStorage.setItem("e2e-seeded", "1");
      }
    },
    [WORKSPACE_KEY, JSON.stringify(stored)] as const,
  );
}

export interface StoredWorkspace {
  id: string;
  origin: string;
  arrangement: ReturnType<typeof documentOf>;
}

/** This tab's working configuration as persisted (waits for the debounced write). */
export async function workspace(page: Page): Promise<StoredWorkspace> {
  await page.waitForTimeout(450);
  return page.evaluate((key) => JSON.parse(sessionStorage.getItem(key) ?? "null"), WORKSPACE_KEY);
}

export async function openConfigurator(page: Page, path = "/") {
  await page.goto(path);
  await page.getByRole("button", { name: "Udostępnij konfigurację" }).waitFor();
  await page.waitForFunction(() => !(document.querySelector("[data-workspace-actions] button") as HTMLButtonElement)?.disabled);
}

/** "Udostępnij konfigurację" → the link shown in the dialog. */
export async function share(page: Page): Promise<string> {
  await page.getByRole("button", { name: "Udostępnij konfigurację" }).click();
  const field = page.locator("[data-share-url]");
  await field.waitFor();
  return field.inputValue();
}

export async function closeShareDialog(page: Page) {
  await page.locator("[data-share-dialog]").getByRole("button", { name: "Zamknij" }).click();
}

/** Inspection endpoints of the WordPress test harness (test/php/server.php). */
export async function harness<T = unknown>(query: string): Promise<T> {
  const api = await playwrightRequest.newContext();
  const response = await api.get(`${PHP_URL}/?harness=${query}`);
  const body = (await response.json()) as T;
  await api.dispose();
  return body;
}

export async function sessionCookie(context: BrowserContext) {
  return (await context.cookies()).find((c) => c.name.endsWith("m3d_sid"));
}
