# Multi-furniture 3D configurator

A room-based furniture configurator (Next.js, React Three Fiber, Zustand). The customer works in four steps:

1. Define the room: dimensions, wall and floor colours, and precisely positioned windows and coloured doors.
2. Place several furniture modules, of different types, and duplicate them left or right.
3. Configure each module independently, with collisions checked throughout.
4. Order a single module or the whole arrangement through WooCommerce.

It is built on [kitchen-config](https://github.com/tomek-kowalski/kitchen-config). The parametric cabinet configurator is reused unchanged and runs as one furniture type among others. The standalone cabinet page is still available at `/configurator`.

Polish is the default language; English can be selected in the header.

## Furniture types

| Type | Geometry | Options | WooCommerce |
|---|---|---|---|
| Modular cabinet | parametric (kitchen-config) | dimensions, compartments, shelves, dividers, doors, drawers, handles, finishes | component SKUs per `docs/woocommerce-catalog-generation.md` |
| ClickBed O / O Classico / O Desk | supplied 3D models, folded + unfolded | the options of each product page | products 4000 / 10759 / 4184 with their product-options form |

See `docs/clickbed-assets.md` for the asset inspection, the options and the dimension discrepancies.

## Architecture

```
src/domain/
  room/          room model: walls, floor, colours, windows/doors (numeric), keep-free zones
  spatial/       coordinate system, placed boxes, separating-axis intersection
  modules/       FurnitureTypeDefinition (the common module interface) + registry; cabinet adapter
  beds/          ClickBed types: option snapshot, published specs, volumes per operational state
  arrangement/   module instances: add/move/rotate/snap/duplicate/add-beside, collision detection
  commerce/      WooCommerce line items, cabinet SKU resolution, order payload + reconstruction
  serialization/ versioned arrangement JSON (cabinet configs keep their own v5 format)
  …              the unchanged kitchen-config cabinet domain
src/store/       arrangement store (source of truth) + cabinet editing session binding
src/components/room/    main menus (A Układ mebli · B Moduł), room panel ("Wymiary pomieszczenia": dimensions,
                        walls, windows, doors), docking prompt and the order dialog
src/components/three/   room scene, module renderers (parametric cabinet, imported bed models)
src/i18n/        pl (reference catalog) / en
wordpress/multi3d-configurator/  WooCommerce bridge plugin
```

**Adding a furniture type** takes four steps; the room, arrangement, collision and order code needs no change.

1. Implement `FurnitureTypeDefinition`. It covers footprint, states, collision boxes, operation envelope, validation, serialization, product reference, order items and summary.
2. Register it in `src/domain/modules/registry.ts`.
3. Add a 3D renderer in `src/components/three/modules/moduleRenderers.tsx`.
4. Add an editor in `src/components/room/ModulePanel.tsx`, plus its i18n keys.

**Positions** are whole millimetres in room coordinates: X from the left wall, Z from the back wall, Y the elevation, and the rotation about the footprint centre. The numbers are authoritative, and dragging in 3D writes the same fields. Left and right for duplication follow the module's own orientation.

**Collisions** use real volumes:

- Modules are checked against the room boundaries, against openings together with their keep-free clearance, and against each other.
- Furniture below a window sill does not collide with the window.
- Transforming furniture is also checked with its operation envelope.

**Units:** room dimensions are shown and typed in centimetres (0.1 cm steps) and converted at the UI
boundary (`src/domain/room/units.ts`); the room, all geometry, saved files and every furniture dimension
stay in whole millimetres.

**Docking:** any module moved near the side of another module with the same orientation (cabinets,
beds, mixed) gets a previewed side-by-side position that is applied only after confirmation
(`src/domain/arrangement/docking.ts`). It is proposed only if the regular collision detection finds no
issue, including bed operation envelopes and wall-mounting requirements.

## WooCommerce

WooCommerce stays the only source of products and prices; the configurator stores no prices.

- **Prices:** base prices are read from the public Store API (`NEXT_PUBLIC_WOOCOMMERCE_URL`, see `.env.example`). Option prices are added by the shop in the cart.
- **Ordering:** "Go to cart" POSTs the order payload to the plugin, which adds every line to the cart. Bed options are posted exactly as the product page would post them. The plugin saves the arrangement JSON on the order.
- **Reconstruction:** the stored JSON can be imported again under Arrangement → Import.
- **Without a configured shop:** the order configuration can still be downloaded as JSON.

The plugin is in `wordpress/multi3d-configurator`. Copy it to `wp-content/plugins` and activate it. Optionally define `MULTI3D_ALLOWED_ORIGIN` in `wp-config.php` for cross-origin price reads.

## Quotations ("Drukuj ofertę")

The order dialog has two tabs: **Cały układ (N)** (cart hand-off of the complete arrangement) and
**Drukuj ofertę**. A quotation always covers the whole arrangement:

1. the arrangement is validated (`buildOrder`) and priced with WooCommerce Store API prices
   (`src/domain/commerce/quote.ts`). There is no pricing logic: a line the shop does not price shows
   "cena do potwierdzenia", and product options are priced by the shop in the cart;
2. 1–3 renderings (front right, front left, front) are captured from the live Three.js scene in
   presentation mode: no selection, collision, envelope, label or editing overlays, and walls between
   the camera and the furniture hidden. The previous camera, canvas size and UI state are restored
   afterwards (`src/components/three/presentation`);
3. one PDF is built with jsPDF and the embedded DejaVu Sans (Polish characters; `public/fonts`), then
   either downloaded or sent by e-mail. Both actions use the same cached quotation.

Quotations are stored through the configurator's own server (BFF route handlers in `src/app/api`),
which signs every call to the WordPress plugin. The server assigns the internal id (UUID) and a unique
number, and the PDF contains a link to the quoted configuration. A quotation is reachable only by the
anonymous browser session that created it. The quotation JSON (configuration plus pricing snapshot) is
post meta; the PDF and renderings are files in a protected uploads folder. Temporary quotations expire
after 60 days (daily WP-Cron); ordered ones are kept, and the order gets its own copy.

## Sessions, "Nowa konfiguracja" and "Udostępnij konfigurację"

Each browser tab has its own working configuration (sessionStorage); nothing is sent to a server while
editing. "Udostępnij konfigurację" stores an immutable snapshot and returns a link `/c/{token}`, valid for
60 days. Anyone with the link can open it and change their own copy. See
[docs/sessions-and-sharing.md](docs/sessions-and-sharing.md) for the architecture, security, database,
environment variables, `wp-config.php` and production deployment.

## Commands

```bash
npm install
npm run dev          # http://localhost:3000
npm test             # vitest (domain, store, i18n, BFF)
npm run test:php     # plugin security/lifecycle tests on a WordPress stub (PHP + pdo_sqlite)
npm run test:e2e     # Playwright, multiple customers: builds .next-e2e, ports 3210 + 8790
npm run typecheck
npm run lint
npm run build
npm run assets:clickbed -- "<path to 'Modele 3D łóżka Transforms'>"   # regenerate GLBs + manifest
```

The option snapshot is regenerated from saved product pages with `scripts/clickbed/extract_epo.py` and `build_bed_options.py`; see their headers.
