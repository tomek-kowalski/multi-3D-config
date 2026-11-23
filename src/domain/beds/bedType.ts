import type { WooLineItem } from "../commerce/types";
import type { FurnitureTypeDefinition } from "../modules/types";
import { fail, ok, type Issue, type Result } from "../shared/issues";
import { computeBedVolumes, BED_STATES, type BedVolumes } from "./bedGeometry";
import { BED_PRODUCTS, findDecor, getBedModel, getBedOptions, offersMattress, type BedAddon, type BedProductOptions } from "./catalog";
import { BED_SPECS, displaySpec } from "./specs";

/**
 * Configuration of one ClickBed instance. Every field corresponds to a field of the shop's product
 * form; nothing here exists that the shop does not offer for this product.
 */
export interface BedConfiguration {
  /** Size key, e.g. "140x200". */
  readonly size: string;
  /** Decor category id (Standard, Color, …); front and body decors come from the same category, as in the shop. */
  readonly decorCategory: string;
  readonly frontDecor: string;
  readonly bodyDecor: string;
  /** Velora Silver mattress. */
  readonly mattress: boolean;
  /** Mattress firmness label (H3/H4); required with the mattress, absent without it. */
  readonly firmness: string | null;
  /** Yes/no add-ons the product offers (shelf, LED, electric opening, extra lock — per product). */
  readonly addons: Readonly<Record<string, boolean>>;
}

export const BED_CONFIGURATION_VERSION = 1;

const DEFAULT_SIZE = "140x200";
const DEFAULT_CATEGORY = "standard";
const DEFAULT_DECOR = "8685-SM";

function defaultConfiguration(options: BedProductOptions): BedConfiguration {
  const size = options.sizes.some((s) => s.key === DEFAULT_SIZE) ? DEFAULT_SIZE : options.sizes[0].key;
  const category = options.categories.find((c) => c.id === DEFAULT_CATEGORY) ?? options.categories[0];
  const decor = category.decors.find((d) => d.id === DEFAULT_DECOR) ?? category.decors[0];
  return {
    size,
    decorCategory: category.id,
    frontDecor: decor.id,
    bodyDecor: decor.id,
    mattress: false,
    firmness: null,
    addons: Object.fromEntries(options.addons.map((a) => [a.id, false])),
  };
}

export function validateBed(options: BedProductOptions, c: BedConfiguration): Issue[] {
  const issues: Issue[] = [];
  if (!options.sizes.some((s) => s.key === c.size)) issues.push({ code: "bed.unknown_size", path: "size", params: { value: c.size } });
  const category = options.categories.find((cat) => cat.id === c.decorCategory);
  if (!category) {
    issues.push({ code: "bed.unknown_category", path: "decorCategory", params: { value: c.decorCategory } });
  } else {
    if (!findDecor(options, c.decorCategory, c.frontDecor))
      issues.push({ code: "bed.decor_not_in_category", path: "frontDecor", params: { value: c.frontDecor, category: category.label } });
    if (!findDecor(options, c.decorCategory, c.bodyDecor))
      issues.push({ code: "bed.decor_not_in_category", path: "bodyDecor", params: { value: c.bodyDecor, category: category.label } });
  }
  if (c.mattress && !offersMattress(options)) issues.push({ code: "bed.mattress_not_offered", path: "mattress" });
  else if (c.mattress && !options.firmness!.values.some((v) => v.label === c.firmness))
    issues.push({ code: "bed.firmness_required", path: "firmness" });
  if (!c.mattress && c.firmness !== null) issues.push({ code: "bed.firmness_without_mattress", path: "firmness" });
  const offered = new Set(options.addons.map((a) => a.id));
  for (const [id, value] of Object.entries(c.addons)) {
    if (!offered.has(id as BedAddon["id"])) issues.push({ code: "bed.addon_not_offered", path: `addons.${id}`, params: { addon: id } });
    else if (typeof value !== "boolean") issues.push({ code: "bed.invalid_addon_value", path: `addons.${id}` });
  }
  for (const addon of options.addons) {
    if (!(addon.id in c.addons)) issues.push({ code: "bed.addon_missing", path: `addons.${addon.id}`, params: { addon: addon.id } });
  }
  return issues;
}

/**
 * The shop form for this configuration: every required field of the product page, with the exact
 * values that page would post. The terms checkbox is left to the customer (see WooLineItem).
 */
export function bedFormFields(options: BedProductOptions, c: BedConfiguration): Result<Record<string, string>> {
  const issues = validateBed(options, c);
  if (issues.length > 0) return fail(...issues);
  const size = options.sizes.find((s) => s.key === c.size)!;
  const category = options.categories.find((cat) => cat.id === c.decorCategory)!;
  const front = findDecor(options, c.decorCategory, c.frontDecor)!;
  const body = findDecor(options, c.decorCategory, c.bodyDecor)!;
  const fields: Record<string, string> = {
    [options.sizeField]: size.value,
    [size.categoryField]: category.value,
    [category.frontField]: front.frontValue,
    [category.bodyField]: body.bodyValue,
  };
  // The mattress is sent only as the shop's own mattress field ("Nie" unless explicitly selected), and
  // the firmness only with a selected mattress; nothing is sent for products without a mattress option.
  if (offersMattress(options)) {
    fields[size.mattressField!] = c.mattress ? options.mattress!.values.tak : options.mattress!.values.nie;
    if (c.mattress) fields[options.firmness!.field] = options.firmness!.values.find((v) => v.label === c.firmness)!.value;
  }
  for (const addon of options.addons) fields[addon.field] = c.addons[addon.id] ? addon.values.tak : addon.values.nie;
  return ok(fields);
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function parseBed(options: BedProductOptions, data: unknown): Result<BedConfiguration> {
  if (!isRecord(data) || data.schemaVersion !== BED_CONFIGURATION_VERSION || !isRecord(data.bed)) {
    return fail({ code: "bed.invalid_document" });
  }
  const b = data.bed;
  const strings = ["size", "decorCategory", "frontDecor", "bodyDecor"] as const;
  for (const key of strings) if (typeof b[key] !== "string") return fail({ code: "bed.invalid_document", path: key });
  if (typeof b.mattress !== "boolean") return fail({ code: "bed.invalid_document", path: "mattress" });
  if (!(b.firmness === null || typeof b.firmness === "string")) return fail({ code: "bed.invalid_document", path: "firmness" });
  if (!isRecord(b.addons)) return fail({ code: "bed.invalid_document", path: "addons" });
  const configuration: BedConfiguration = {
    size: b.size as string,
    decorCategory: b.decorCategory as string,
    frontDecor: b.frontDecor as string,
    bodyDecor: b.bodyDecor as string,
    mattress: b.mattress,
    firmness: b.firmness as string | null,
    addons: { ...(b.addons as Record<string, boolean>) },
  };
  const issues = validateBed(options, configuration);
  return issues.length > 0 ? fail(...issues) : ok(configuration);
}

export function createBedType(product: (typeof BED_PRODUCTS)[number]): FurnitureTypeDefinition<BedConfiguration> {
  const options = getBedOptions(product.productId);
  const volumeCache = new Map<string, BedVolumes>();
  const volumes = (c: BedConfiguration): BedVolumes => {
    let v = volumeCache.get(c.size);
    if (!v) {
      const spec = BED_SPECS[product.typeId][c.size];
      if (!spec) throw new Error(`No dimensions for ${product.typeId} ${c.size}`);
      v = computeBedVolumes(spec, getBedModel(product.typeId, c.size), product.hasDesk);
      volumeCache.set(c.size, v);
    }
    return v;
  };

  return {
    id: product.typeId,
    geometrySource: "imported",
    category: "bed",
    ...(product.wallMountingSource ? { wallMounting: { face: "back" as const, source: product.wallMountingSource } } : {}),
    nameKey: product.nameKey,
    createDefault: () => defaultConfiguration(options),
    footprint: (c) => volumes(c).footprint,
    states: () => BED_STATES,
    collisionBoxes: (c, state) => volumes(c).states[state === "unfolded" ? "unfolded" : "folded"],
    operationEnvelope: (c) => volumes(c).envelope,
    validate: (c) => validateBed(options, c),
    serialize: (c) => ({ schemaVersion: BED_CONFIGURATION_VERSION, bed: { ...c, addons: { ...c.addons } } }),
    parse: (data) => parseBed(options, data),
    productReference: () => ({ kind: "product", productId: product.productId, url: options.url }),
    orderItems: (c) => {
      const fields = bedFormFields(options, c);
      if (!fields.ok) return fields;
      const item: WooLineItem = {
        kind: "product-options",
        productId: product.productId,
        quantity: 1,
        fields: fields.value,
        termsField: options.termsField,
        termsValue: options.termsValue,
      };
      return ok([item]);
    },
    summary: (c) => {
      const spec = BED_SPECS[product.typeId][c.size];
      const front = findDecor(options, c.decorCategory, c.frontDecor);
      const body = findDecor(options, c.decorCategory, c.bodyDecor);
      const category = options.categories.find((cat) => cat.id === c.decorCategory);
      const rows = [
        { labelKey: "summary.size", value: options.sizes.find((s) => s.key === c.size)?.label ?? c.size },
        { labelKey: "summary.dimensions", value: `${displaySpec(spec?.W)} × ${displaySpec(spec?.H)} × ${displaySpec(spec?.D)} mm` },
        { labelKey: "summary.decorCategory", value: category?.label ?? c.decorCategory },
        { labelKey: "summary.frontDecor", value: front ? `${front.code} ${front.structure} ${front.name}`.replace(/\s+/g, " ") : c.frontDecor },
        { labelKey: "summary.bodyDecor", value: body ? `${body.code} ${body.structure} ${body.name}`.replace(/\s+/g, " ") : c.bodyDecor },
        { labelKey: "summary.mattress", value: c.mattress ? `Velora Silver ${c.firmness ?? ""}`.trim() : "—" },
      ];
      for (const addon of options.addons) rows.push({ labelKey: `addon.${addon.id}`, value: c.addons[addon.id] ? "✓" : "—" });
      return rows;
    },
  };
}

export const BED_TYPES = BED_PRODUCTS.map(createBedType);
