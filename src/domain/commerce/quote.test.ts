import { describe, expect, it } from "vitest";
import { addModule, updateModuleConfiguration } from "../arrangement/operations";
import type { Arrangement } from "../arrangement/types";
import type { BedConfiguration } from "../beds/bedType";
import { DEFAULT_ROOM } from "../room/defaults";
import { buildQuote, quoteNumber, type PriceLookup } from "./quote";

function unwrap<T>(r: { ok: true; value: T } | { ok: false; issues: readonly unknown[] }): T {
  if (!r.ok) throw new Error(JSON.stringify(r.issues));
  return r.value;
}

function arrangement(): Arrangement {
  let a: Arrangement = { room: { ...DEFAULT_ROOM, width: 6000 }, modules: [] };
  a = unwrap(addModule(a, "cabinet")).arrangement;
  a = unwrap(addModule(a, "clickbed-o")).arrangement;
  a = unwrap(addModule(a, "cabinet")).arrangement;
  const bed = a.modules[1].configuration as BedConfiguration;
  return unwrap(updateModuleConfiguration(a, "module-2", { ...bed, mattress: true, firmness: "H4" })).arrangement;
}

const PLN = (amount: number, name?: string) => ({ amount, currency: "PLN", ...(name ? { name } : {}) });

/** WooCommerce prices for the default cabinet lines and ClickBed O (product 4000). */
function prices(overrides: Partial<{ bed: number; side: number }> = {}): PriceLookup {
  return {
    byId: new Map([[4000, PLN(overrides.bed ?? 10390, "ClickBed O")]]),
    bySku: new Map([
      ["KC-SIDE-T16-18-H1201-2000-W300-800", PLN(overrides.side ?? 120)],
      ["KC-TOP-BOTTOM-T16-18-W300-800-D401-600", PLN(80)],
      ["KC-COLOR-NATURAL-OAK", PLN(15)],
    ]),
  };
}

const at = { number: "OF-20261124-ABCD", createdAt: new Date("2026-11-24T10:00:00Z") };

describe("quotation", () => {
  it("covers the complete arrangement with the configured options", () => {
    const quote = unwrap(buildQuote(arrangement(), prices(), at));
    expect(quote.modules.map((m) => [m.moduleId, m.typeId])).toEqual([
      ["module-1", "cabinet"],
      ["module-2", "clickbed-o"],
      ["module-3", "cabinet"],
    ]);
    expect(quote.order.scope).toBe("arrangement");
    expect(quote.modules[1].summary).toContainEqual({ labelKey: "summary.mattress", value: "Velora Silver H4" });
    expect(quote.order.arrangement.modules).toHaveLength(3);
  });

  it("uses WooCommerce prices per line, per module and in total", () => {
    const quote = unwrap(buildQuote(arrangement(), prices(), at));
    // Cabinet: 2 sides × 120 + 2 top/bottom × 80 + 4 colour lines × 15.
    expect(quote.modules[0].price).toBe(2 * 120 + 2 * 80 + 4 * 15);
    expect(quote.modules[1].price).toBe(10390);
    expect(quote.total).toBe(2 * 460 + 10390);
    expect(quote.currency).toBe("PLN");
    expect(quote.modules[1]).toMatchObject({ optionsPricedInCart: true });
    expect(quote.modules[0].optionsPricedInCart).toBe(false);
  });

  it("never guesses a missing price", () => {
    const missing: PriceLookup = { byId: new Map(), bySku: prices().bySku };
    const quote = unwrap(buildQuote(arrangement(), missing, at));
    expect(quote.modules[1].price).toBeNull();
    expect(quote.total).toBeNull();
    expect(quote.modules[0].price).toBe(460);
  });

  it("rejects invalid prices and mixed currencies", () => {
    const invalid = buildQuote(arrangement(), prices({ side: -5 }), at);
    expect(invalid.ok).toBe(false);
    if (!invalid.ok) expect(invalid.issues[0]).toMatchObject({ code: "quote_invalid_price", params: { reference: "KC-SIDE-T16-18-H1201-2000-W300-800" } });
    const mixed: PriceLookup = { byId: new Map([[4000, { amount: 2000, currency: "EUR" }]]), bySku: prices().bySku };
    expect(buildQuote(arrangement(), mixed, at)).toMatchObject({ ok: false, issues: [{ code: "quote_mixed_currency" }] });
  });

  it("refuses an empty arrangement", () => {
    expect(buildQuote({ room: DEFAULT_ROOM, modules: [] }, prices(), at).ok).toBe(false);
  });

  it("numbers quotations by date with a random suffix", () => {
    expect(quoteNumber(new Date(2026, 10, 24), () => 0)).toBe("OF-20261124-AAAA");
    expect(quoteNumber(new Date(2026, 0, 5), () => 0.999)).toMatch(/^OF-20260105-[A-Z2-9]{4}$/);
  });
});
