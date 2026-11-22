import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { BED_PRODUCTS, getBedOptions } from "@/domain/beds/catalog";
import { MATERIAL_CATALOG, MATERIAL_SLOTS } from "@/domain/furniture/materials";
import { HANDLE_TYPES, HARDWARE_FINISHES } from "@/domain/hardware/catalog";
import { listFurnitureTypes } from "@/domain/modules/registry";
import { WALL_IDS } from "@/domain/room/types";
import { DEFAULT_LOCALE, formatIssue, isMessageKey, translate, useLocaleStore } from "./index";
import { en } from "./messages/en";
import { pl } from "./messages/pl";

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.tsx?$/.test(name) && !name.endsWith(".test.ts") ? [path] : [];
  });
}

describe("localization", () => {
  it("uses Polish by default and switches to English", () => {
    expect(DEFAULT_LOCALE).toBe("pl");
    expect(useLocaleStore.getState().locale).toBe("pl");
    expect(translate("pl", "menu.space")).toBe("Przestrzeń");
    expect(translate("en", "menu.space")).toBe("Room");
    expect(translate("en", "arrangement.placed", { count: 3 })).toBe("Furniture in the room (3)");
  });

  it("translates every message into English, with the same placeholders", () => {
    for (const key of Object.keys(pl) as (keyof typeof pl)[]) {
      expect(en[key], key).toBeTruthy();
      if (pl[key] === "{message}") continue; // cabinet messages: Polish shows the domain text itself
      const placeholders = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
      expect(placeholders(en[key]), key).toEqual(placeholders(pl[key]));
    }
  });

  it("defines every literal message key used in the source", () => {
    const missing: string[] = [];
    for (const file of sourceFiles(join(__dirname, ".."))) {
      const source = readFileSync(file, "utf8");
      for (const m of source.matchAll(/\bt\(\s*"([^"]+)"/g)) if (!isMessageKey(m[1])) missing.push(`${file}: ${m[1]}`);
      for (const m of source.matchAll(/(?:nameKey|labelKey): "([^"]+)"/g)) if (!isMessageKey(m[1])) missing.push(`${file}: ${m[1]}`);
    }
    expect(missing).toEqual([]);
  });

  it("defines the keys built from domain identifiers", () => {
    const keys = [
      ...WALL_IDS.map((w) => `wall.${w}`),
      ...MATERIAL_CATALOG.map((m) => `material.${m.id}`),
      ...MATERIAL_SLOTS.map((s) => `materialSlot.${s}`),
      ...MATERIAL_SLOTS.filter((s) => s !== "body").map((s) => `materialSlot.${s}.unavailable`),
      ...HARDWARE_FINISHES.map((f) => `hardware.${f.id}`),
      ...HANDLE_TYPES.map((h) => `handle.${h}`),
      ...listFurnitureTypes().map((t) => t.nameKey),
      ...listFurnitureTypes().flatMap((t) => t.states(t.createDefault()).map((s) => `state.${s}`)),
      ...BED_PRODUCTS.flatMap((p) => getBedOptions(p.productId).addons.map((a) => `addon.${a.id}`)),
      ...["W", "H", "D", "DU", "HU", "HM", "HD", "DD", "WD"].map((k) => `bedSpec.${k}`),
      ...["width", "height", "depth", "panelThickness", "backPanel.thickness", "plinth.height", "plinth.setback"].map((f) => `cabinetField.${f}`),
    ];
    expect(keys.filter((k) => !isMessageKey(k))).toEqual([]);
  });

  it("localizes domain issues by code, in both languages", () => {
    const t = (key: Parameters<typeof translate>[1], params?: Record<string, string | number>) => translate("en", key, params);
    expect(formatIssue(t, { code: "below_minimum", params: { min: 1000 } })).toBe("The minimum is 1000 mm.");
    expect(formatIssue(t, { code: "no_space_beside", params: { side: "left" } })).toMatch(/No space/);
    expect(formatIssue(t, { code: "something_new" })).toBe("This change is not allowed (something_new).");
  });
});
