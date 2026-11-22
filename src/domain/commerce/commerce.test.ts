import { describe, expect, it } from "vitest";
import { addModule, duplicateModule, setPlacement, updateModuleConfiguration } from "../arrangement/operations";
import type { Arrangement } from "../arrangement/types";
import type { BedConfiguration } from "../beds/bedType";
import { splitCompartment } from "../compartments/tree";
import { DEFAULT_CABINET } from "../furniture/defaults";
import type { CabinetConfiguration } from "../furniture/types";
import { addDoor, addDrawers } from "../attachments/operations";
import { getFurnitureType } from "../modules/registry";
import { DEFAULT_ROOM } from "../room/defaults";
import { cabinetOrderItems, doorLeafValues, resolveBand } from "./cabinetSkus";
import { buildOrder, reconstructOrder } from "./order";

function unwrap<T>(r: { ok: true; value: T } | { ok: false; issues: readonly unknown[] }): T {
  if (!r.ok) throw new Error(JSON.stringify(r.issues));
  return r.value;
}

describe("cabinet catalog bands (docs/woocommerce-catalog-generation.md)", () => {
  it("resolves inclusive bands and rejects non-integers", () => {
    expect(unwrap(resolveBand("T", 16))).toBe("T16-18");
    expect(unwrap(resolveBand("T", 18))).toBe("T16-18");
    expect(unwrap(resolveBand("T", 19))).toBe("T19-22");
    expect(unwrap(resolveBand("W", 800))).toBe("W300-800");
    expect(unwrap(resolveBand("W", 801))).toBe("W801-1600");
    expect(unwrap(resolveBand("BT", 8))).toBe("T3-8");
    expect(resolveBand("W", 800.5).ok).toBe(false);
    expect(resolveBand("W", 2401).ok).toBe(false);
  });

  it("computes door leaves per the worked examples", () => {
    expect(doorLeafValues(600, 700, "single")).toEqual({ leaves: 1, width: 600, height: 700 });
    expect(doorLeafValues(1700, 2100, "double")).toEqual({ leaves: 2, width: 850, height: 2100 });
    expect(doorLeafValues(1601, 1201, "double")).toEqual({ leaves: 2, width: 801, height: 1201 }); // 800.5 → 801
    expect(unwrap(resolveBand("W", 250, { clampBelow: true }))).toBe("W300-800");
  });
});

describe("cabinet order lines", () => {
  it("orders the default cabinet as side and top/bottom pairs with their colour products", () => {
    const items = unwrap(cabinetOrderItems(DEFAULT_CABINET));
    expect(items).toEqual([
      { kind: "sku", sku: "KC-COLOR-NATURAL-OAK", quantity: 2, note: "KC-SIDE-T16-18-H1201-2000-W300-800" },
      { kind: "sku", sku: "KC-COLOR-NATURAL-OAK", quantity: 2, note: "KC-TOP-BOTTOM-T16-18-W300-800-D401-600" },
      { kind: "sku", sku: "KC-SIDE-T16-18-H1201-2000-W300-800", quantity: 2 },
      { kind: "sku", sku: "KC-TOP-BOTTOM-T16-18-W300-800-D401-600", quantity: 2 },
    ]);
  });

  it("follows the KC-SIDE rule: width changes the variation, depth does not", () => {
    const sku = (c: CabinetConfiguration) =>
      unwrap(cabinetOrderItems(c)).find((i) => i.kind === "sku" && i.sku.startsWith("KC-SIDE"))!;
    expect(sku({ ...DEFAULT_CABINET, width: 801 })).toMatchObject({ sku: "KC-SIDE-T16-18-H1201-2000-W801-1600" });
    expect(sku({ ...DEFAULT_CABINET, depth: 900 })).toMatchObject({ sku: "KC-SIDE-T16-18-H1201-2000-W300-800" });
  });

  it("orders a double door as two half-width leaves and drawers as their parts", () => {
    const tree = unwrap(
      ((r) => (r.ok ? { ok: true as const, value: r.tree } : { ok: false as const, issues: [r.error] }))(
        splitCompartment(DEFAULT_CABINET.compartments, "root", "horizontal"),
      ),
    );
    const base = { ...DEFAULT_CABINET, width: 1200, compartments: tree };
    const [bottom, top] = (tree as { children: readonly { id: string }[] }).children;
    const withDoor = addDoor(base, top.id, "double");
    if (!withDoor.ok) throw new Error(withDoor.error.message);
    const withDrawers = addDrawers(withDoor.configuration, bottom.id);
    if (!withDrawers.ok) throw new Error(withDrawers.error.message);
    const items = unwrap(cabinetOrderItems(withDrawers.configuration));
    const qty = (sku: string) => items.filter((i) => i.kind === "sku" && i.sku === sku && !i.note).reduce((n, i) => n + i.quantity, 0);
    const door = items.find((i) => i.kind === "sku" && i.sku.startsWith("KC-DOOR-") && !i.note)!;
    expect(door.quantity).toBe(2);
    const drawerCount = (withDrawers.configuration.attachments.find((a) => a.type === "drawer")!.configuration as { count: number }).count;
    expect(qty("KC-DRAWER-FRONT")).toBe(drawerCount);
    expect(qty("KC-DRAWER-SIDE")).toBe(2 * drawerCount);
    expect(qty("KC-DRAWER-BACK")).toBe(drawerCount);
    expect(qty("KC-DRAWER-BOTTOM")).toBe(drawerCount);
    expect(qty("KC-SHELF-T16-18-D401-600")).toBe(1);
    // Every component line has its colour line; handles have their finish.
    const handleLines = items.filter((i) => i.kind === "sku" && i.sku.startsWith("KC-HANDLE-") && !i.sku.startsWith("KC-HANDLE-FINISH"));
    const finishLines = items.filter((i) => i.kind === "sku" && i.sku.startsWith("KC-HANDLE-FINISH-"));
    expect(handleLines.reduce((n, i) => n + i.quantity, 0)).toBe(finishLines.reduce((n, i) => n + i.quantity, 0));
    expect(items.every((i) => i.kind === "sku" && !/LEFT|RIGHT/.test(i.sku))).toBe(true);
  });

  it("refuses non-integer dimensions instead of guessing a band", () => {
    expect(cabinetOrderItems({ ...DEFAULT_CABINET, width: 800.5 }).ok).toBe(false);
  });
});

describe("product mapping", () => {
  it("maps every furniture type to its WooCommerce product", () => {
    const ref = (id: string) => getFurnitureType(id).productReference(getFurnitureType(id).createDefault());
    expect(ref("clickbed-o")).toEqual({ kind: "product", productId: 4000, url: "https://clickbed.pl/nowoczesny-polkotapczan-clickbed-o/" });
    expect(ref("clickbed-o-classico")).toMatchObject({ kind: "product", productId: 10759 });
    expect(ref("clickbed-o-desk")).toMatchObject({ kind: "product", productId: 4184 });
    expect(ref("cabinet")).toMatchObject({ kind: "sku-bundle" });
  });

  it("leaves the shop's terms checkbox to the customer", () => {
    const type = getFurnitureType("clickbed-o-desk");
    const [item] = unwrap(type.orderItems(type.createDefault()));
    expect(item).toMatchObject({ kind: "product-options", productId: 4184, quantity: 1, termsField: "tmcp_checkbox_21_0" });
    if (item.kind === "product-options") expect(Object.keys(item.fields)).not.toContain("tmcp_checkbox_21_0");
  });
});

describe("order serialization", () => {
  function sampleArrangement(): Arrangement {
    let a: Arrangement = { room: { ...DEFAULT_ROOM, width: 7000 }, modules: [] };
    a = unwrap(addModule(a, "cabinet")).arrangement;
    a = unwrap(setPlacement(a, "module-1", { x: 3000 })).arrangement;
    a = unwrap(duplicateModule(a, "module-1", "right")).arrangement;
    a = unwrap(addModule(a, "clickbed-o-classico")).arrangement;
    const bed = a.modules.find((m) => m.id === "module-3")!;
    const config: BedConfiguration = { ...(bed.configuration as BedConfiguration), mattress: true, firmness: "H3", addons: { electricOpening: true, led: true, extraLock: false } };
    return unwrap(updateModuleConfiguration(a, "module-3", config)).arrangement;
  }

  it("serializes several modules of different types into one order", () => {
    const order = unwrap(buildOrder(sampleArrangement()));
    expect(order.scope).toBe("arrangement");
    expect(order.modules.map((m) => [m.moduleId, m.typeId])).toEqual([
      ["module-1", "cabinet"],
      ["module-2", "cabinet"],
      ["module-3", "clickbed-o-classico"],
    ]);
    const bed = order.modules[2];
    expect(bed.items).toHaveLength(1);
    expect(bed.items[0]).toMatchObject({ kind: "product-options", productId: 10759 });
    expect(bed.dimensions.width).toBeGreaterThan(2000);
    expect(bed.placement).toEqual(sampleArrangement().modules[2].placement);
    expect(JSON.parse(JSON.stringify(order))).toEqual(order); // JSON-safe
  });

  it("orders individual modules while keeping the whole arrangement for reconstruction", () => {
    const arrangement = sampleArrangement();
    const order = unwrap(buildOrder(arrangement, ["module-3"]));
    expect(order.scope).toBe("modules");
    expect(order.modules.map((m) => m.moduleId)).toEqual(["module-3"]);
    expect(order.arrangement.modules).toHaveLength(3);
  });

  it("reconstructs the arrangement from a stored order", () => {
    const arrangement = sampleArrangement();
    const stored = JSON.parse(JSON.stringify(unwrap(buildOrder(arrangement))));
    const rebuilt = unwrap(reconstructOrder(stored));
    expect(rebuilt.orderedModuleIds).toEqual(["module-1", "module-2", "module-3"]);
    expect(rebuilt.arrangement).toEqual(arrangement);
  });

  it("detects a tampered order whose lines no longer follow from the configuration", () => {
    const stored = JSON.parse(JSON.stringify(unwrap(buildOrder(sampleArrangement()))));
    stored.modules[2].items[0].fields.tmcp_select_0 = "180 x 200_2";
    expect(reconstructOrder(stored)).toMatchObject({ ok: false, issues: [{ code: "order_items_mismatch" }] });
  });

  it("refuses to order an empty selection", () => {
    expect(buildOrder({ room: DEFAULT_ROOM, modules: [] }).ok).toBe(false);
  });
});
