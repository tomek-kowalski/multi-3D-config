import modelsJson from "./data/clickbedModels.json";
import optionsJson from "./data/clickbedOptions.json";

/**
 * ClickBed option snapshot: the WooCommerce product-options form of each product page
 * (scripts/clickbed/extract_epo.py + build_bed_options.py). It mirrors what the shop offers so the
 * 3D view can show it; WooCommerce stays the authority and validates the posted form again.
 */
export interface DecorSwatch {
  readonly hex: string;
  /** File name in /textures/decors. */
  readonly texture: string;
  /** Polish decor name in the supplied catalog. */
  readonly namePl: string;
  readonly catalogCode: string;
  /** `exact`: same decor code and structure; `code`: same decor code, other surface structure. */
  readonly match: "exact" | "code";
}

export interface BedDecor {
  readonly id: string;
  readonly code: string;
  readonly structure: string;
  readonly name: string;
  /** Exact values the shop form posts for the front and the body radio. */
  readonly frontValue: string;
  readonly bodyValue: string;
  /** null: the decor is not in the supplied catalog, so no preview colour is known. */
  readonly swatch: DecorSwatch | null;
}

export interface BedDecorCategory {
  readonly id: string;
  readonly label: string;
  readonly value: string;
  readonly frontField: string;
  readonly bodyField: string;
  readonly decors: readonly BedDecor[];
}

export interface BedSizeOption {
  readonly key: string;
  readonly label: string;
  readonly value: string;
  readonly categoryField: string;
  /** The size's mattress yes/no field; absent when the product offers no mattress. */
  readonly mattressField?: string;
}

export interface BedAddon {
  readonly id: "shelf" | "led" | "electricOpening" | "extraLock";
  readonly label: string;
  readonly field: string;
  readonly values: { readonly nie: string; readonly tak: string };
}

export interface BedProductOptions {
  readonly productId: number;
  readonly url: string;
  readonly sizeField: string;
  readonly sizes: readonly BedSizeOption[];
  readonly categories: readonly BedDecorCategory[];
  /** Mattress option of the shop form; absent when the product offers no mattress. */
  readonly mattress?: { readonly values: { readonly nie: string; readonly tak: string } };
  readonly firmness?: { readonly field: string; readonly values: readonly { readonly label: string; readonly value: string }[] };
  readonly addons: readonly BedAddon[];
  readonly termsField: string;
  readonly termsValue: string;
  readonly termsLabel: string;
}

export interface ModelBounds {
  readonly min: { readonly x: number; readonly y: number; readonly z: number };
  readonly size: { readonly width: number; readonly height: number; readonly depth: number };
}

export interface ModelStateGeometry {
  readonly carcass: ModelBounds;
  readonly body: ModelBounds;
  readonly overall: ModelBounds;
  /** Geometry more than 2 cm in front of the carcass (unfolded bed, deployed desk), or null. */
  readonly extension: ModelBounds | null;
  readonly triangles: number;
}

export interface ModelSizeEntry {
  /** Path below /models/clickbed. */
  readonly file: string;
  readonly states: Readonly<Record<"folded" | "unfolded", ModelStateGeometry>>;
}

const OPTIONS = optionsJson as unknown as { readonly products: readonly BedProductOptions[]; readonly missingSwatches: readonly string[] };
const MODELS = modelsJson as unknown as { readonly models: Readonly<Record<string, { readonly sizes: Readonly<Record<string, ModelSizeEntry>> }>> };

/** Decor codes of the shop that have no swatch in the supplied catalog. */
export const DECORS_WITHOUT_SWATCH: readonly string[] = OPTIONS.missingSwatches;

/** The three ClickBed products: furniture type ↔ WooCommerce product ↔ supplied 3D asset folder. */
export const BED_PRODUCTS = [
  // `wallMountingSource`: where the "must be fixed to the wall" requirement is published. The spec sheets
  // of O Classico and O Desk state "PRODUKT WYMAGA TRWAŁEGO MONTAŻU DO ŚCIANY!"; no such statement was
  // found for ClickBed O (no spec sheet supplied, not on its product page), so none is assumed.
  { typeId: "clickbed-o", nameKey: "furniture.clickbedO", productId: 4000, hasDesk: false, wallMountingSource: null },
  { typeId: "clickbed-o-classico", nameKey: "furniture.clickbedOClassico", productId: 10759, hasDesk: false, wallMountingSource: "lib/furniture-spec/Clickbed O Classico.pdf" },
  { typeId: "clickbed-o-desk", nameKey: "furniture.clickbedODesk", productId: 4184, hasDesk: true, wallMountingSource: "lib/furniture-spec/Clickbed O Desk.pdf" },
] as const;

export type BedTypeId = (typeof BED_PRODUCTS)[number]["typeId"];

export function getBedOptions(productId: number): BedProductOptions {
  const options = OPTIONS.products.find((p) => p.productId === productId);
  if (!options) throw new Error(`No option snapshot for product ${productId}`);
  return options;
}

export function getBedModel(typeId: string, size: string): ModelSizeEntry | null {
  return MODELS.models[typeId]?.sizes[size] ?? null;
}

/**
 * Whether the product's shop form offers a mattress (a yes/no field for every size and a firmness
 * choice). Only then is the mattress control shown, validated and sent to the shop.
 */
export function offersMattress(options: BedProductOptions): boolean {
  return (
    options.mattress !== undefined &&
    options.firmness !== undefined &&
    options.firmness.values.length > 0 &&
    options.sizes.every((s) => typeof s.mattressField === "string")
  );
}

export function findDecor(options: BedProductOptions, categoryId: string, decorId: string): BedDecor | null {
  return options.categories.find((c) => c.id === categoryId)?.decors.find((d) => d.id === decorId) ?? null;
}
