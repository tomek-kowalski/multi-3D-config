# ClickBed models, options and dimensions

What the configurator uses for the three ClickBed products, where it comes from, and where the sources disagree. Inspected on 2026-11-21.

## Product ↔ asset mapping

| Furniture type | WooCommerce product | Product page | 3D asset folder (`lib/Modele 3D łóżka Transforms/`) |
|---|---|---|---|
| `clickbed-o` | 4000 | clickbed.pl/nowoczesny-polkotapczan-clickbed-o/ | `12_Click Bed O` (files are named `Click_Bec_O_*`) |
| `clickbed-o-classico` | 10759 | clickbed.pl/nowoczesny-polkotapczan-clickbed-o-classico/ | `17_Click Bed O Classico` |
| `clickbed-o-desk` | 4184 | clickbed.pl/lozko-z-biurkiem-clickbed-o-desk/ | `16_Click Bed O Desk` |

The brief named the ClickBed O folder `lib/Modele 3D/12_Click Bed O`. The actual folder is `lib/Modele 3D łóżka Transforms/12_Click Bed O`.

## The supplied 3D files

- Each size has an `.obj`, `.mtl` and `.3ds` file (Blender 2.93 OBJ export). The OBJ files are used. They are in metres, with Y up and the front facing +Z.
- **Every file contains the bed twice, side by side: folded (the platform stands inside the carcass) and unfolded (the platform lies on the floor).** These are the only operational states the configurator offers. There is no animation, rig or pivot data, so the transition is not animated.
- The files have one placeholder material (`None`, grey) and no textures. Material slots are assigned per component from the object names (`scripts/assets/convert-clickbed.mjs`). The names were identified from per-object bounds and orthographic renders:
  - `body` (decor "Kolor obudowy"): carcass `Box2035`/`Box021`, back panel `Box2032`, Desk top `Box1003`.
  - `front` (decor "Kolor frontu"): front panel `Box2047`/`Box873`, plus the zero-thickness front planes of ClickBed O.
  - `mattress`: `Meridiani…`, `mattress…`.
  - `hardware` (not configurable): platform, slats, gas-strut mechanism, legs, lock, handle.
- The ClickBed O folder also contains `100x200`, which the shop does not sell. It is not converted.
- Conversion: `npm run assets:clickbed -- "<path to Modele 3D łóżka Transforms>"` writes `public/models/clickbed/<type>/<size>.glb` (nodes `folded` and `unfolded`) and `src/domain/beds/data/clickbedModels.json` (measured bounds). Geometry is only translated, never scaled.

## Options (from the shop)

The product pages use WooCommerce with ThemeComplete Extra Product Options. `scripts/clickbed/extract_epo.py` reads the saved product pages, and `build_bed_options.py` writes `src/domain/beds/data/clickbedOptions.json` with the exact field names and posted values. No prices are copied.

| | ClickBed O | O Classico | O Desk |
|---|---|---|---|
| Sizes | 90, 120, 140, 160, 180 × 200 | 140, 160, 180 × 200 | 140, 160, 180 × 200 |
| Decor categories | Standard, Color, Contempo, Trends, Avant-garde, Metal | Standard, Color, Contempo | Standard, Color, Contempo, Trends, Avant-garde, Metal |
| Front / body decor | separate choices from the same category | same | same |
| Velora Silver mattress + firmness H3/H4 | ✓ | ✓ | ✓ |
| Add-ons | Półka, Oświetlenie LED | Otwieranie elektryczne na pilota, Oświetlenie LED, Dodatkowy zamek z kluczykiem | Oświetlenie LED |

Each page also has a required terms checkbox. Only the customer can tick it, in the order dialog.

Options found in the spec PDFs but **not** offered on the product pages are not offered in the configurator: push-pull opening, divided front, RAL lacquering, noga-półka.

## Decor previews

Decor previews are sampled from `lib/upholstery colors/Transforms_Katalog_Plyt_Meblowych_Premium_2026.pdf` (226 swatches; `scripts/clickbed/sample_decor_swatches.py`):

- **Exact code + structure match:** 379 of the 551 shop decor entries.
- **Same decor code, different structure:** 34 entries. The catalog states that the code defines the decor and the structure symbol only defines the surface.
- **No swatch:** 138 entries (46 codes, e.g. `0121 BS`, `8361 SN`, `AL01…AL06`). They stay orderable and are shown with a neutral hatched preview. No colour was invented for them.

## Dimensions: sources and discrepancies

`src/domain/beds/specs.ts` keeps each published value with its source. Collision volumes use the **largest** value of the product page, the spec PDF and the 3D model, so neither the drawing nor the model can protrude unnoticed.

| Item | Product page | Spec PDF | 3D model |
|---|---|---|---|
| Width (all) | O 2158; Classico/Desk 2162 | 2158 | O 2162, Classico 2180, Desk 2159 |
| Depth D | 400 | 400 | O 360, Classico 398, Desk 598 |
| Desk height H (140/160/180) | 1578 / 1778 / 1978 | 1589 / 1789 / 1989 | 1500 / 1700 / 1900 |
| Desk unfolded depth DU 180 | 1834 (same as 160) | 2040 | 2270 |
| Classico 140 carcass height | 1586 | 1586 | folded 1528, unfolded 1728 (the two copies differ) |
| ClickBed O 180 label | "200X180" in the spec table | — | — |
| ClickBed O widths | text says 80–180 cm | — | — |

No ClickBed O spec PDF was supplied (only O Classico, O Desk and O Voila).

## Operational states and collisions

- **Folded:** the carcass, plus for the Desk the deployed desk (WD × DD at HD, with the space below it kept free for use).
- **Unfolded:** the carcass, plus the bed in front of it up to DU, HU + HM high (or higher where the model's mattress is higher).
- **Operation envelope:** the platform swings between those states. The pivot and radius are not published, so the envelope is the conservative box W × H × max depth. It is checked against walls, openings and other furniture in every state.
