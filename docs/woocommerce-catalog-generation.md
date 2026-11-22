# WooCommerce catalog generation

This document explains how `woocommerce_szafka_optimized_variants.xlsx` is built from `scripts/woocommerce-catalog/catalog_config.json` and the configurator source, and how to rebuild or change it. No other input file is needed. Read it before touching the catalog. Everything below describes the generator as implemented in `scripts/woocommerce-catalog/`.

**Key rules:**
- `KC-SIDE` (Panel boczny) is one product for the **left and right** side panels. It is priced by **thickness × height × width**: attributes `Grubość płyty (mm)`, `Wysokość (mm)`, `Szerokość (mm)`, in that order. Depth is **not** a `KC-SIDE` attribute.
- `KC-TOP-BOTTOM` (Panel górny/dolny) is one product for the **top and bottom** panels. It is priced by **thickness × width × depth**: attributes `Grubość płyty (mm)`, `Szerokość (mm)`, `Głębokość (mm)`.
- `KC-DOOR` (Drzwi) has a **constant 12 mm** thickness and is priced **per leaf by width × height of the door opening**: attributes `Szerokość (mm)`, `Wysokość (mm)`.
  - A **single door** (pojedyncze) is 1 leaf with the full opening width.
  - A **double door** (skrzydłowe) is 2 leaves, each with half the opening width.
  - Leaf sizes below the first band (width < 300 or height < 400) use the first band. Odd half-widths are rounded half up (800.5 → 801).
- `KC-DRAWER-FRONT` (Front szuflady) has a **constant 12 mm** thickness and is a simple product.
- Colours are separate WooCommerce products, never variation attributes.
- Dimensions are integer millimetres (1 mm). Bands are inclusive and non-overlapping.
- Fixed thicknesses: drawer box panels 12 mm, drawer bottom 8 mm, door and drawer front 12 mm.

**Summary:** the workbook is never edited by hand. Change `catalog_config.json` (or the configurator source, or `prices.csv`) and run one command. The generator checks itself and refuses to write a workbook that violates any rule in this document.

---

## 1. Source of truth

All paths are relative to the repository root (`kitchen-config/`).

| What | Path | Used for |
|---|---|---|
| Generator | `scripts/woocommerce-catalog/generate_catalog.py` | Builds and validates the workbook |
| Generator configuration | `scripts/woocommerce-catalog/catalog_config.json` | Pricing bands, product definitions (including each product's band axes and their order), consolidation, BOM positions, dependency notes, expected counts and attributes. **The only place these rules are defined.** |
| Regression tests | `scripts/woocommerce-catalog/test_generate_catalog.py` | KC-SIDE / KC-TOP-BOTTOM axes, band resolution, unrelated products unchanged, identical output on repeated runs |
| Python dependency | `scripts/woocommerce-catalog/requirements.txt` | `openpyxl>=3.1,<4` |
| Optional prices | `scripts/woocommerce-catalog/prices.csv` | Prices per SKU (does not exist yet; see §10) |
| Cabinet limits and defaults | `src/domain/furniture/defaults.ts` (`CABINET_LIMITS`, `CONSTRUCTION_LIMITS`, `DEFAULT_CABINET`, `DEFAULT_BACK_PANEL`) | Band coverage check, parent default attribute values |
| Board finishes and material slots | `src/domain/furniture/materials.ts` (`MATERIAL_CATALOG`, `MATERIAL_SLOTS`) | Colour products `KC-COLOR-*` |
| Hardware finishes and handle types | `src/domain/hardware/catalog.ts` (`HARDWARE_FINISHES`, `HANDLE_TYPE_NAMES`) | `KC-HANDLE` variations, `KC-HANDLE-FINISH-*` products |
| Panel types | `src/domain/geometry/types.ts` (`PanelType`) | Every panel type must belong to a product |
| Panel geometry and part IDs | `src/domain/geometry/buildCabinet.ts` | Which cabinet dimension drives which part; BOM positions |
| Door/drawer parts and rules | `src/domain/attachments/geometry.ts`, `layout.ts`, `rules.ts` (`DRAWER_RULES`, `DOOR_RULES`), `validateAttachments.ts`, `types.ts` | Fixed thicknesses (12 / 8 mm), drawer composition, handle placement |
| Validation rules | `src/domain/constraints/validateCabinet.ts` | Dependencies sheet |
| Output | `woocommerce_szafka_optimized_variants.xlsx` (repository root) | Generated, never edited by hand |

**Drift guard.** On every run the generator parses the TypeScript files above and compares them with `catalog_config.json` → `configurator`. The values it compares:
- cabinet limits and defaults
- back-panel thickness range and default
- `DRAWER_RULES.boxPanelThickness` and `bottomThickness`
- `MATERIAL_CATALOG` ids and names, in order
- `MATERIAL_SLOTS`
- `HARDWARE_FINISHES`
- handle types
- the `PanelType` union

Any difference stops the run with a list of findings (exit code 1), so the catalog cannot silently drift away from the application.

**No external workbook is used.** The earlier source workbook `woocommerce_szafka_file.xlsx` was wrong and has been deleted (2026-11-20). Everything it used to provide (product names, categories, short descriptions, informational attribute labels) now lives in `catalog_config.json` → `products[]`. Do not recreate or reintroduce it.

---

## 2. Product structure

The import contains three kinds of rows:

| WooCommerce type | What | SKU pattern |
|---|---|---|
| `variable` | A component whose price depends on pricing bands (or on handle type) | `KC-SIDE`, `KC-TOP-BOTTOM`, `KC-SHELF`, `KC-DIVIDER`, `KC-BACK-PANEL`, `KC-PLINTH`, `KC-DOOR`, `KC-HANDLE` |
| `variation` | One combination of the parent's band values | `<parent>-<band>-<band>…`, e.g. `KC-SIDE-T16-18-H400-1200-W300-800` |
| `simple` | Components with nothing to vary (fixed-thickness drawer parts and drawer front) and every colour / finish | `KC-DRAWER-FRONT`, `KC-DRAWER-SIDE`, `KC-DRAWER-BACK`, `KC-DRAWER-BOTTOM`, `KC-COLOR-<ID>`, `KC-HANDLE-FINISH-<ID>` |

An order for one configured cabinet consists of:
- one line per component occurrence (variation or simple product), quantity = number of occurrences, and
- for each component, the colour product of its material slot (or handle finish).

The exact millimetre values and the part positions stay in the configuration (`CabinetConfiguration`, the saved JSON and the BOM). WooCommerce only receives the band-level product.

---

## 3. Component consolidation

Positions that are the same physical product (same dimensions, thickness, material slot and pricing rule) share one WooCommerce product:

| WooCommerce product | Configurator positions (part IDs) | Why equivalent (from `buildCabinet.ts`) | Pricing bands |
|---|---|---|---|
| `KC-SIDE` – Panel boczny | `cabinet/left-side`, `cabinet/right-side` | Both `width=t, height=height−plinth, depth=depth`, slot `body`; only X position differs | thickness × height × width |
| `KC-TOP-BOTTOM` – Panel górny/dolny | `cabinet/top`, `cabinet/bottom` | Both `width=width−2t, height=t, depth=depth`, slot `body`; only Y position differs | thickness × width × depth |
| `KC-DRAWER-SIDE` (already one product) | `drawer/<a>/<i>/side-left`, `/side-right` | Same box panel | — |
| `KC-DOOR` (already one product) | `door/<a>` (single), `door/<a>/left` + `door/<a>/right` (double) | Every leaf is the same part; a double door orders two leaves of the half-width variation | width × height per leaf (12 mm) |

The earlier products `KC-LEFT-SIDE`, `KC-RIGHT-SIDE`, `KC-TOP` and `KC-BOTTOM` are **not** generated. They are listed in `replaces` in the config, and the generator fails if any of them, or a variation of one, reappears. Placement never appears in a SKU or attribute. One cabinet orders the same variation twice, for example `KC-SIDE-T16-18-H1201-2000-W300-800 ×2` (sides) and `KC-TOP-BOTTOM-T16-18-W300-800-D401-600 ×2` (top and bottom).

**Deliberately not merged**, because the code treats them differently:
- shelf vs top/bottom: different slot (`interior` vs `body`) and the width comes from the compartment
- divider vs side: different slot, and the height comes from the compartment
- door vs drawer front: different slot (`doorFront` vs `drawerFront`), and the door has hinges
- drawer side vs drawer back: they run along different axes

Rules for future consolidation (enforced in `build()`):
1. Verify geometric equivalence in `buildCabinet.ts` or `attachments/geometry.ts`: same dimension formulas, same thickness and same material slot. The generator cannot check geometry.
2. Give the product all the merged `part_types`. Each `PanelType` may belong to only one product (checked).
3. List the SKUs of products that no longer exist in `replaces` (checked: they must not reappear).
4. Add every position to `positions`, then update `expected` and the tests.

---

## 4. Pricing bands

Defined once, in `catalog_config.json` → `bands`. Current values (owner specification of 2026-11-20):

| Key | Attribute (WooCommerce) | Configurator field | Range 1 | Range 2 | Range 3 | SKU prefix |
|---|---|---|---|---|---|---|
| `T` | Grubość płyty (mm) | `panelThickness` (16–25) | 16–18 | 19–22 | 23–25 | `T` |
| `BT` | Grubość pleców (mm) | `backPanel.thickness` (3–18) | 3–8 | 9–14 | 15–18 | `T` |
| `W` | Szerokość (mm) | `width` (300–2400) | 300–800 | 801–1600 | 1601–2400 | `W` |
| `H` | Wysokość (mm) | `height` (400–2800) | 400–1200 | 1201–2000 | 2001–2800 | `H` |
| `D` | Głębokość (mm) | `depth` (200–900) | 200–400 | 401–600 | 601–900 | `D` |

Attribute values in WooCommerce are the bare band, e.g. `16-18`, `300-800` (hyphen, no unit). Band IDs (`T1`, `W2`, …) appear in the Variants and Pricing_Bands sheets only.

Which bands apply to which product (`products[].thickness` / `products[].dims`):

The axis order (= attribute order = SKU token order) is the config's `thickness`, then `dims` as listed. It is pinned in `expected.attributes`.

| Product | Axes in order | Attributes | Variations |
|---|---|---|---|
| KC-SIDE | T, H, W | Grubość płyty, Wysokość, Szerokość | 27 |
| KC-TOP-BOTTOM | T, W, D | Grubość płyty, Szerokość, Głębokość | 27 |
| KC-SHELF | T, D | Grubość płyty, Głębokość | 9 |
| KC-DIVIDER | T, D | Grubość płyty, Głębokość | 9 |
| KC-BACK-PANEL | BT, W, H | Grubość pleców, Szerokość, Wysokość | 27 |
| KC-PLINTH | W | Szerokość | 3 |
| KC-DOOR | W, H (per leaf, 12 mm fixed) | Szerokość, Wysokość | 9 |
| KC-DRAWER-FRONT | – (fixed 12 mm) | informational thickness only | 0 (simple) |
| KC-DRAWER-SIDE / -BACK / -BOTTOM | – (fixed 12 / 12 / 8 mm) | informational thickness only | 0 (simple) |
| KC-HANDLE | handle type | Uchwyt | 3 |

Every band is looked up from the customer-selected **cabinet** value of its field (`W` → `width`, `H` → `height`, `D` → `depth`, `T` → `panelThickness`, `BT` → `backPanel.thickness`). For `KC-SIDE` this means its `Szerokość` band comes from the cabinet `width` (an owner pricing rule). The side panel's geometry (thickness × height × depth) does not change with the cabinet width, and the cabinet depth does not affect the `KC-SIDE` price.

**Doors are the exception: `KC-DOOR` uses its own lookup values** (`band_lookup` in the config, owner rule 2026-11-20). They are computed by `door_leaf_values()` and `resolve()`:

| Door type (`layout`) | Leaves (quantity) | Width value | Height value |
|---|---|---|---|
| `single` (pojedyncze) | 1 | door opening width | door opening height |
| `double` (skrzydłowe) | 2 | door opening width / 2 | door opening height |

- Values are rounded to whole mm, half up (800.5 → 801, 799.5 → 800).
- A value below the first band uses the first band (leaf 180–299 → `300-800`, height 250–399 → `400-1200`).
- Single and double leaves of the same size share one variation.
- Examples:
  - single 600 × 700 → `KC-DOOR-W300-800-H400-1200` ×1
  - double 1700 × 2100 → leaf 850 → `KC-DOOR-W801-1600-H2001-2800` ×2
  - double 1601 × 1201 → leaf 800.5 → 801 → `KC-DOOR-W801-1600-H1201-2000` ×2

Apart from these two exceptions (KC-SIDE width and doors), a dimension band is applied **only where the part spans the customer-selected cabinet dimension along that axis**, so the selected value maps to a band unambiguously. Where a part's size comes from compartment splits, setbacks or drawer rules, the band is left out, because those sizes can fall below the lowest band:
- shelf width, divider height (min 150 mm)
- drawer front (min height 80 mm; no bands defined, so it is a simple 12 mm product)
- plinth depth (depth − setback, can be < 200)
- drawer box sizes (depth min 150 mm)

The reason for each product is in the Components sheet.

---

## 5. Dimensional rules

- All dimensions are **integer millimetres** with 1 mm resolution. Band limits must be integers (checked when the config loads).
- Bands are **inclusive at both ends** and, within one attribute, **contiguous and non-overlapping**: each band starts at the previous band's max + 1. The first band starts at the configurator minimum and the last ends at the configurator maximum. Every integer in the configurator range is tested and must hit exactly one band.
- The lookup uses the **customer-selected cabinet value** (`width`, `height`, `depth`, `panelThickness`, `backPanel.thickness`), never a derived part size. Example: the side panel is priced by cabinet `height`, not by `height − plinth`.
- The bands do not change any configurator limit. The limits stay as defined in `defaults.ts`:
  - width 300–2400, height 400–2800, depth 200–900, panelThickness 16–25
  - back panel 3–18, plinth height 50–250, setback 0–150
  - compartment ≥ 150 × 150, nesting ≤ 6 levels, ≤ 32 compartments
  - drawer rules as in `rules.ts`
- **Known mismatch (not fixed, app unchanged):** the configurator's text input accepts decimals (`validateCabinet.ts` has no integer check), but the catalog treats values like `800.5` as invalid. The integration that builds orders must reject or block non-integer values. The generator's `resolve()` raises on non-integers.

---

## 6. Variant generation algorithm

Implemented in `build()` in `generate_catalog.py`:

1. **Load and check.**
   - Load the config and convert each band range into a band item (`id`, `min`, `max`, `value`).
   - Run the drift guard (§1).
   - Run `validate_bands()`: contiguity, coverage of the configurator range, one hit per integer.
2. **Check the product list** (`products[]` in the config):
   - every product has `name`, `category` and `short_description`
   - every `PanelType` belongs to exactly one product's `part_types`
   - every product has a BOM position, and every position names a part type of its product
   - SKUs in `replaces` are unique and are not product SKUs
3. **Select the axes per product:**
   - `variation: "handle_type"`: one axis with the handle types (`Gałka`, `Uchwyt`, `Frezowany`). The type `none` creates no product.
   - Otherwise: the thickness band (`T` or `BT`) first, if any, then the product's `dims` **in the order listed** (`product_axes()`). For example, KC-SIDE `dims: ["H", "W"]` gives T, H, W, and KC-TOP-BOTTOM `dims: ["W", "D"]` gives T, W, D.
   - No axes at all: the product becomes `simple`. This is only allowed for fixed-thickness parts.
4. **Generate variations** as the cartesian product of the axis values, one per combination, so each combination exists exactly once and nothing is generated per millimetre.
   - **SKU:** `<parent>-` + the axis tokens joined by `-`. Each token is `<sku_prefix><min>-<max>`, or the uppercased handle-type id. Examples:
     - `KC-SIDE-T16-18-H1201-2000-W300-800`
     - `KC-TOP-BOTTOM-T19-22-W801-1600-D200-400`
     - `KC-BACK-PANEL-T3-8-W300-800-H400-1200`
     - `KC-PLINTH-W801-1600`
     - `KC-DOOR-W801-1600-H2001-2800`
     - `KC-HANDLE-BAR`
   - **Name:** `<parent name> – <Attribute> <band> mm, …`, e.g. `Panel boczny – Grubość płyty 16-18 mm, Wysokość 400-1200 mm, Szerokość 300-800 mm`.
   - **Parent defaults:** the band containing the configurator default (18 mm → `16-18`, 8 mm back → `3-8`, width 800 → `300-800`, height 1800 → `1201-2000`, depth 500 → `401-600`).
5. **Colour products** come from the material and hardware catalogues (§7).
6. **Validate** (§11), run the self-tests (band edges, worked examples), then write the workbook.

---

## 7. Colour handling

- Colour is **never** a variation attribute, never part of a variation SKU, and never a value of a parent's attribute. The generator checks every variation SKU against all colour ids and every attribute value against all colour names.
- One `simple` product per colour, reused by every component:
  - Board finishes (`MATERIAL_CATALOG`): `KC-COLOR-<ID>`, category `Kolory`. There are 8: WHITE-MATTE, BLACK-MATTE, ANTHRACITE, NATURAL-OAK, SONOMA-OAK, WALNUT, LIGHT-GREY, CASHMERE.
  - Hardware finishes (`HARDWARE_FINISHES`): `KC-HANDLE-FINISH-<ID>`, category `Uchwyty`, name `Wykończenie uchwytu – <name>`. There are 5: CHROME, BRUSHED-STEEL, BLACK-MATTE, BRASS, WHITE.
  - `Czarny mat` exists in both catalogues as different items, so it has two products.
- The configuration keeps **one colour per material slot**. Each component takes the colour of its slot:

| Slot (`materials.<slot>`) | Products |
|---|---|
| `body` | KC-SIDE, KC-TOP-BOTTOM |
| `interior` | KC-SHELF, KC-DIVIDER, KC-DRAWER-SIDE, KC-DRAWER-BACK, KC-DRAWER-BOTTOM |
| `backPanel` | KC-BACK-PANEL |
| `plinth` | KC-PLINTH |
| `doorFront` | KC-DOOR |
| `drawerFront` | KC-DRAWER-FRONT |
| `handle.finish` (per door / drawer assembly) | KC-HANDLE → KC-HANDLE-FINISH-* |

The order integration must attach the colour product of the component's slot to every component line, so the colour stays associated with the configured part.

---

## 8. Fixed-thickness components

| Product | Thickness | Source |
|---|---|---|
| KC-DRAWER-SIDE (2 per drawer) | 12 mm | `DRAWER_RULES.boxPanelThickness` |
| KC-DRAWER-BACK (1 per drawer) | 12 mm | `DRAWER_RULES.boxPanelThickness` |
| KC-DRAWER-BOTTOM (1 per drawer) | 8 mm | `DRAWER_RULES.bottomThickness` |
| KC-DRAWER-FRONT (1 per drawer) | 12 mm | owner rule (`fixed_thickness.frontThickness`) |
| KC-DOOR (1 or 2 leaves) | 12 mm | owner rule (`fixed_thickness.frontThickness`), variable by width × height |

- The general plate bands are never applied to these parts.
- Doors and drawer fronts have no editable dimensions or thickness in the configurator, and their thickness is not displayed (by design, it stays that way). The 12 mm is therefore a catalog rule set by the owner. It is not compared with the TypeScript source, and no app change is needed.
- Their box dimensions can be smaller than the lowest band (drawer depth from 150 mm, box height from 50 mm, internal width from 100 mm). So no dimension band applies, and nothing is left to vary.
- The drawer parts and the drawer front are generated as `simple` products. The thickness is kept as an informational attribute (`Grubość płyty skrzynki: 12 mm`, `Grubość dna: 8 mm`, `Grubość płyty: 12 mm`, visible, not used for variations). KC-DOOR is variable, and its 12 mm is stated in the short description. The label comes from `info_attribute` in the config. The value is built from `DRAWER_RULES` through `configurator.fixed_thickness`, which the drift guard checks.
- Colour comes from the `interior` slot.

---

## 9. Excel structure

Output: `woocommerce_szafka_optimized_variants.xlsx`. All text is Arial 10, headers have a blue fill, and the first row is frozen with an autofilter. Orange fill marks a missing price. Formulas are written without cached values. `fullCalcOnLoad` is set, so Excel or LibreOffice computes them on open.

| # | Sheet | Rows (current) | Content |
|---|---|---|---|
| 1 | `WooCommerce_Import` | 139 + header | Import-ready rows, values only (CSV-compatible) |
| 2 | `Products` | 25 | 12 component products + 13 colour products, with configurator positions and replaced earlier SKUs |
| 3 | `Variants` | 114 | One row per variation |
| 4 | `Pricing_Bands` | 15 | Bands from the config |
| 5 | `Colors` | 13 | Colour / finish products |
| 6 | `Components` | 12 + BOM table | Product → configurator mapping, plus a table of BOM positions (part ID → product, quantity) |
| 7 | `Variant_Mapping` | — | Selected value/range → band → attribute value; lookup pattern per product; colour mapping; worked examples |
| 8 | `Dependencies` | 19 | Existing configurator restrictions (from `catalog_config.json` → `dependencies`) |
| 9 | `Coverage` | — | Variations per parent (formula) vs expected (config), formula checks (TRUE = pass), validation results |

### WooCommerce_Import columns

`ID, Type, SKU, Name, Published, Short description, Categories, Parent, Regular price`, then for N = 1..3: `Attribute N name, Attribute N value(s), Attribute N visible, Attribute N global, Attribute N default`. This is the standard WooCommerce product CSV layout.

| Column | variable | variation | simple |
|---|---|---|---|
| ID | empty | empty | empty |
| Type | `variable` | `variation` | `simple` |
| SKU | parent SKU | generated SKU | product SKU |
| Published | config `published` (default 0) | as parent | 0 |
| Categories | config `category` | empty | config `category` / `Kolory` / `Uchwyty` |
| Parent | empty | **parent SKU** (WooCommerce resolves by SKU) | empty |
| Regular price | empty | price or empty | price or empty |
| Attribute N value(s) | all allowed values, `, `-separated | exactly one value | fixed thickness (drawer parts) or empty |
| Attribute N visible / global | 1 / 0 (local attributes) | 1 / 0 | 1 / 0 |
| Attribute N default | band of the configurator default | empty | empty |

Variation attribute values never contain commas (checked), because WooCommerce splits values on commas.

### Other sheets, columns

- **Products:** `SKU, Name, WooCommerce type, Role, Category, Configurator source, Material slot / use, Variation attributes, Configurator positions, Replaces previous SKUs, Variations` (=COUNTIF over Variants), `Price (simple) / status`.
- **Variants:** `Variation SKU, Parent SKU, Name, Plate thickness band, Back thickness band, Width band, Height band, Depth band, Handle type, Band IDs, Regular price, Price status`.
- **Pricing_Bands:** `Attribute, Band ID, Supplied range, Min (mm), Max (mm), WooCommerce value, WooCommerce attribute, Configurator field, Configurator range (unchanged), Check`.
- **Colors:** `Colour SKU, Name, Catalogue, Configurator ID, Configuration field, Material slots, Used with products, Regular price, Price status`.
- **Components:** `Parent SKU, Name, Configurator part, Material slot, Colour product, Thickness pricing, Width band, Height band, Depth band, Variations, Geometry (source), Reason`. Below it, the BOM positions: `Configurator part ID, PanelType, Material slot, WooCommerce parent, Quantity, Colour product, Source`.
- **Variant_Mapping:** `Mapping, Configurator field, Selected value / range (mm), Min, Max, Band ID, WooCommerce attribute, WooCommerce value, Resolves to, Note`.
- **Dependencies:** `Type, Applies to, Restriction (existing), Source`.
- **Coverage:** `Parent SKU, Name, Type, Variations (formula), Expected (config), Match`, then the formula checks and the validation table (§11).

### Importing into WooCommerce

1. Open the workbook and export `WooCommerce_Import` as CSV (UTF-8). Alternatively, read it with any tool that keeps UTF-8 (Polish characters).
2. WooCommerce → Products → Import. Map the columns automatically. Parents come before their variations in the file.
3. If an earlier catalog was ever imported into the shop: the old products `KC-LEFT-SIDE`, `KC-RIGHT-SIDE`, `KC-TOP`, `KC-BOTTOM` and all old colour-based variations (e.g. `KC-SHELF-16-WHITE-MATTE`) are **not** deleted by an import. Remove them in WooCommerce first or afterwards.
4. `KC-DRAWER-SIDE`, `KC-DRAWER-BACK` and `KC-DRAWER-BOTTOM` change from `variable` to `simple`. Delete the old products before importing if the importer refuses the type change (not tested here).
5. Nothing in this repository writes to WordPress or WooCommerce. Importing is a manual step.

---

## 10. Pricing data

- **Only source of prices:** `scripts/woocommerce-catalog/prices.csv`, matched by exact SKU, for variations, simple components and colour products alike (status `prices.csv`).
- **Current state:** no `prices.csv` exists. So every variation, simple product and colour product shows `NOT DEFINED` (label from `price_missing_label`), and `Regular price` is left empty in the import sheet. WooCommerce cannot import a text value as a price.
- No price is ever computed or estimated.
- **`prices.csv` format** (UTF-8, header required, `.` or `,` as the decimal separator, no currency symbol):

  ```csv
  SKU,regular_price
  KC-SIDE-T16-18-H400-1200-W300-800,120.00
  KC-COLOR-WALNUT,15.00
  ```

  Generate a complete template with every priceable SKU (131 today: 114 variations, 4 simple components, 13 colours):

  ```bash
  python -X utf8 scripts/woocommerce-catalog/generate_catalog.py --price-template scripts/woocommerce-catalog/prices.csv
  ```

  The template columns are `SKU, regular_price, name`. The `name` column is ignored on input. A SKU in `prices.csv` that the generator does not produce, a duplicate SKU, or a negative or unparseable price stops the run.

---

## 11. Validation

The generator aborts on the first failed check, so a written workbook means every check passed.

**Configuration and configurator source:**
- the drift guard (§1)
- band limits are integers, min ≤ max, contiguous, non-overlapping, and cover exactly the configurator range
- every integer value in each range hits exactly one band
- band-edge self-test: each band's max and the next band's min fall into different bands, and min − 1 / max + 1 are outside every band
- every product has a name, category and short description
- every `PanelType` belongs to exactly one product, every product has a BOM position, and every position names a part type of its product
- `replaces` has no duplicates and no current product SKU

**Output:**
- unique SKUs
- every variation's `Parent` is a `variable` row
- no commas in variation attribute values
- no colour code in any variation SKU and no colour name in any attribute value
- no `LEFT` / `RIGHT` tokens in variation SKUs
- no band combination is duplicated
- the count per product equals the product of its band counts
- the replaced positional products (`KC-LEFT-SIDE`, `KC-RIGHT-SIDE`, `KC-TOP`, `KC-BOTTOM`) and their variations are absent
- every product's axes and their order equal `expected.attributes` (KC-SIDE = T, H, W; KC-TOP-BOTTOM = T, W, D), and its variations use exactly those attributes
- the counts equal `expected` in the config
- the worked examples resolve:
  - 16 mm and 18 mm give the same variation, and 19 mm gives a different one
  - for KC-SIDE, width 801 changes the variation, while depth 900 does not

**In the workbook (Coverage sheet):**
- formula checks that show TRUE when Excel opens the file: unique SKUs, parent references, Variants = import variations, colour count, component products present, no positional products, number of variations with a price
- the validation table
- per-parent counts (COUNTIF) compared with `expected.variations`

### Expected counts (current configuration)

| | Count |
|---|---|
| Component products | 12 (8 variable, 4 simple) |
| Variations | **114** |
| Colour products | 13 (8 board + 5 hardware) |
| Import rows (without header) | 139 = 12 + 114 + 13 |
| Priceable SKUs (template) | 131 = 114 + 4 + 13 |

| Parent | Axes | Variations |
|---|---|---|
| KC-SIDE | T × H × W | 27 |
| KC-TOP-BOTTOM | T × W × D | 27 |
| KC-SHELF | T × D | 9 |
| KC-DIVIDER | T × D | 9 |
| KC-BACK-PANEL | BT × W × H | 27 |
| KC-PLINTH | W | 3 |
| KC-DOOR | W × H (per leaf) | 9 |
| KC-DRAWER-FRONT | – (12 mm) | 0 (simple) |
| KC-DRAWER-SIDE / -BACK / -BOTTOM | – | 0 (simple) |
| KC-HANDLE | handle type | 3 |

---

## 12. Regeneration procedure

Requirements: Python 3.10+ (tested with 3.12) and openpyxl 3.1 (tested with 3.1.5). No LibreOffice and no Node.js are needed.

From the repository root (`kitchen-config/`):

```bash
# 1. once: install the dependency
python -m pip install -r scripts/woocommerce-catalog/requirements.txt

# 2. generate (overwrites woocommerce_szafka_optimized_variants.xlsx in the repository root)
python -X utf8 scripts/woocommerce-catalog/generate_catalog.py
```

`-X utf8` keeps the Polish console output intact on Windows. It does not change the workbook.

Expected output ends with:

```
Variations 114; colour products 13; import rows 139; prices applied from CSV 0
  KC-SIDE            variable   27
  ...
All checks passed.
```

Options:
- `--output PATH`: write somewhere else, e.g. for a trial run.
- `--config PATH`: use another config.
- `--prices PATH`: use another price file (default `scripts/woocommerce-catalog/prices.csv`, optional).
- `--price-template PATH`: also write the price template.

Exit code 0 means the workbook was written and all checks passed. Exit code 1 means nothing was written and the error is printed on stderr.

Then run the regression tests. They generate into a temporary folder and do not touch the real workbook:

```bash
python -X utf8 -m unittest discover -s scripts/woocommerce-catalog -p "test_*.py" -v
```

All tests must pass. They cover:
- the KC-SIDE attributes, SKUs and names (thickness × height × width, no depth)
- KC-TOP-BOTTOM unchanged (thickness × width × depth)
- the left/right → KC-SIDE and top/bottom → KC-TOP-BOTTOM mapping
- band resolution: width changes the KC-SIDE variation, depth does not
- unique SKUs and valid parents
- no positional or colour SKUs
- expected counts
- a fingerprint of all non-KC-SIDE import rows
- two runs give byte-identical package parts (except `docProps/core.xml`, which holds the save time)

Optionally, open the workbook in Excel: every formula check in `Coverage` must show TRUE, and the totals must equal the table in §11.

---

## 13. Maintenance

Always change `catalog_config.json` (and `expected`), never the workbook or the generated rows. Then regenerate. A failing run tells you what is inconsistent.

| Change in the configurator | What to do |
|---|---|
| New finish in `MATERIAL_CATALOG` | The drift guard fails. Add it to `configurator.materials`, in the same order. Update `expected.color_products` and `expected.import_rows`, and refresh the test fingerprint (`UNRELATED_ROWS_*`). |
| New hardware finish / handle type | As above, with `hardware_finishes` / `handle_types`. A new handle type adds a `KC-HANDLE` variation, so update `expected.variations.KC-HANDLE`, `total_variations` and `import_rows`. |
| Changed limit (e.g. depth max 1000) | The drift guard fails. Update `configurator.limits`. Then `validate_bands` fails until the outer band ends at the new limit. Ask the owner for the new band, never extend one on your own. |
| New / changed pricing bands | Edit `bands[].ranges` (integers, contiguous, covering the configurator range). The number of bands changes the variation counts: update `expected`. |
| New `PanelType` | The drift guard fails. Add it to `configurator.panel_types`, then either add a product with it in `part_types` or add it to an existing product after verifying equivalence (§3). A new product needs `name`, `category` and `short_description`. Add its BOM position(s), update `expected` (counts and `attributes`), and update the tests. |
| New material slot | Update `configurator.material_slots`, the product's `slot`, and the slot table in §7. |
| Changed drawer thickness rule | The drift guard fails. Update `configurator.fixed_thickness`. The product's informational attribute value follows automatically. |
| Renamed product / category / description | Edit `products[]` (`name`, `category`, `short_description`, `info_attribute`, `variation_attribute`). Refresh the test fingerprint if the product isn't KC-SIDE. |
| A product should use another band (e.g. doors priced by height) | Edit `products[].dims` (the order is the attribute and SKU order). Update `expected.attributes`, the counts in `expected`, and the Components `reason`. Check that every valid customer value maps into the bands (§4). In `test_generate_catalog.py`, update the product's assertions and refresh `UNRELATED_ROWS_SHA256` / `UNRELATED_ROWS_COUNT` (they fingerprint every row except the products in `FINGERPRINT_EXCLUDES`). The test failure prints the new digest. |
| Prices arrive | Fill `prices.csv` (§10) and regenerate. |
| Workbook layout / column changes | Edit `write_workbook()` in the generator, and update §9. |

After any change: regenerate, run the tests, check the console summary against the new `expected` values, update §4, §7 and §11 of this document if the rules or counts changed, and commit the config, the script, the document and (if tracked) both workbooks together.

---

## Assumptions and open points

1. **Dimension bands follow the customer-selected cabinet dimension**, not derived part sizes. For parts that only partly span the cabinet (shelf width, divider height, drawer fronts, plinth depth, drawer boxes), dimension bands are not applied. Doors are the exception (see 10). Pricing those by size would need bands that cover their real minimum sizes, which is an owner decision.
2. **Plinth** is priced by width only. Its height (50–250 mm) has no band.
3. **Handle finishes** are separate products, like board colours ("each existing color or finish").
4. **Category `Kolory`** is new, because no existing category fits board colours.
5. **No prices exist.** Every price is `NOT DEFINED` until `prices.csv` is provided.
6. **Decimal input** in the configurator is not yet blocked (§5).
7. **WooCommerce re-import** over the old catalog needs a manual cleanup of the old products and variations (§9).
8. **KC-SIDE width band** (owner rule, 2026-11-20): KC-SIDE is priced by thickness × height × cabinet width, replacing the earlier thickness × height × depth. Two side panels with the same height and thickness but different cabinet depths share one variation and price.
9. The earlier source workbook `woocommerce_szafka_file.xlsx` was wrong and has been deleted. The generator does not depend on it, and there is no "before/after" variation comparison any more. All product data is in `catalog_config.json`.
10. **Doors** (owner rule, 2026-11-20): constant 12 mm, priced per leaf by the door opening (single: width × height; double: width / 2 × height, 2 leaves), rounded half up, with small leaves in the first band. The order integration must pass the opening width, the opening height and the door layout (`single` / `double`) and order the resulting quantity.
11. **Drawer fronts** (owner rule, 2026-11-20): constant 12 mm, simple product without dimension bands. Tell the generator owner if they should be priced by width × height like doors.
