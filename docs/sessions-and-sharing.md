# Customer sessions, shared configurations and quotation security

## Audit findings (before this change)

| Area | Finding |
|---|---|
| Zustand stores | Module singletons, but only mutated in the browser (effects and handlers). Server rendering only reads the initial state. **Not a cause** of cross-customer sharing. |
| Browser persistence | One device-wide `localStorage` key (`multi3d.arrangement.v1`) for every tab and every person using the browser. On a shared computer the next customer received the previous customer's design, and two tabs overwrote each other (last write wins). **Confirmed cause.** |
| Quotations | Public, unauthenticated WordPress endpoints keyed only by the number `OF-YYYYMMDD-XXXX` (20 random bits from `Math.random`, generated in the browser). Anyone could e-mail any stored PDF anywhere, or upload renderings to it, by guessing a number. Two same-day quotes could collide: the second save then returned "already stored", and the e-mail sent **the first customer's PDF**. **Confirmed cause.** |
| Cart hand-off | The cart itself is per customer (top-level form post in the customer's own WooCommerce session). The form carried a client-provided quotation number, so anyone could attach another customer's quotation to their order. **Confirmed.** |
| Rendering cache, quotation cache | In-memory per tab, keyed by the complete configuration. Not shared between customers. |
| Next.js server | No API routes or server state existed. |

## Architecture

```
Browser ──(same origin, HttpOnly session cookie, CSRF header)──▶ Next.js route handlers (BFF, src/app/api)
                                                                      │  HMAC-signed, server-to-server
                                                                      ▼
                                                       WordPress plugin (MySQL, uploads, wp_mail, WP-Cron)
Browser ──(public Store API: prices)───────────────────────────────▶ WooCommerce
Browser ──(top-level form post: cart hand-off)──────────────────────▶ WooCommerce (customer's own cart)
```

- **Interactive editing stays in the browser** (Zustand). Nothing is sent to a server while editing.
- **Working configuration:** per tab in `sessionStorage` (`multi3d.workspace.v2`, debounced, flushed on
  `pagehide`). The former `localStorage` key is deleted on start and never restored.
- **Anonymous session:** created on the first save (sharing or quotation). The cookie is `__Host-m3d_sid`:
  256 random bits, HttpOnly, Secure, SameSite=Lax, Path=/, no Domain. It is a browser-session cookie, so
  the next person on a shared computer does not inherit the quotation list. WordPress stores only
  SHA-256(session id) as the owner of a resource.
- **Server-to-server:** every BFF→WordPress request is signed with HMAC-SHA256 over the method, REST
  route, timestamp (±5 min), a single-use nonce, the body hash, the session id and the client address.
  The secret proves only that the request comes from the BFF. **Access to a quotation or a link's e-mail
  requires the session id whose hash is the stored owner**, so the secret alone cannot reach any
  customer's data.

### Browser behaviour

| Situation | Result |
|---|---|
| New visitor, standard URL | Default configuration, new workspace id |
| Reload | This tab's configuration restored (including unsaved state) |
| New tab | Default configuration (tabs are independent) |
| Duplicated tab | Starts with a copy; afterwards both evolve independently |
| Browser closed, return later | Default configuration; the session (quotation list) has ended; shared links and the PDF/e-mail remain |
| "Nowa konfiguracja" | Confirmation when there are unsaved changes; new workspace, default room; temporary selection, rendering and quotation caches cleared; quotations, links and the shop cart untouched |
| Shared link `/c/{token}` | Token removed from the address bar at once; snapshot loaded as a new working copy (confirmation first if this tab has unsaved changes); a reload keeps the loaded copy |

"Unsaved" means changed since the last clean point: start, a loaded link, a share, or a stored quotation.

## Shared configurations

- **Create:** `POST /api/shares {snapshot}`. The server validates the snapshot with the domain parsers
  and stores only its canonical form (room, openings with open state, every module with dimensions,
  placement, rotation, operational state such as folded/unfolded, its complete configuration: shelves,
  dividers, doors, drawers, materials, accessories, mattress; plus presentation: camera, open fronts,
  wall labels). Unknown fields, such as personal data, carts or prices, cannot survive. Token: 256 random
  bits, returned once; WordPress stores only its SHA-256 hash.
- **Open:** `POST /api/shares/open {token}` (the token goes in the body, not in a URL). Read-only; 404 for
  unknown, 410 for expired; returns only the snapshot and its dates. No session is created.
- **Copy-on-write:** a snapshot is never updated. Sharing a changed copy creates a new snapshot and a new
  link; the original stays valid until it expires. An unchanged arrangement reuses its link.
- **E-mail:** `POST /api/shares/email {token, email}`. Only the session that created the link may send
  it; no new snapshot is created, so retries are safe. The address is used for that message only.
- **Prices on open:** current WooCommerce prices and stock are read. Unavailable products are listed and
  never substituted. A shared link is not a binding price offer.
- **Retention:** 60 days. Links printed in a quotation PDF follow the quotation: removed with it, or kept
  indefinitely once it is ordered.

## Quotations

1. Price and render in the browser (unchanged pipeline). The renderings must show exactly the quoted
   configuration.
2. `POST /api/quotes {snapshot}` reserves the quotation in one transaction. WordPress assigns an internal
   **UUID v4** and a human-readable number `OF-YYYYMMDD-XXXXXX` (30 bits from a CSPRNG). The number has a
   **unique index**; a collision is retried inside the transaction with a new number. The same transaction
   stores the configuration snapshot that the PDF links to.
3. The PDF is built with the server's number and the configuration link.
4. `PUT /api/quotes/{id}`, `POST …/pdf`, `POST …/renderings/{n}`: each part is written once, only by the
   owner, only with the reserved number, and only for the configuration it was reserved with (its
   SHA-256 is compared).
5. `POST …/email`, `GET …/pdf`, `GET /api/quotes` ("Twoje oferty"): owner only.
6. Cart: `POST …/cart-claim` returns a single-use claim valid for one hour. The cart form posts the
   claim, never a number. At checkout the quotation and its link are marked `ordered` (never purged),
   and the order receives `_multi3d_quote_id`, `_multi3d_quote_number`, `_multi3d_quote` (configuration
   and pricing snapshot) and `_multi3d_arrangement`.

The number is never an identifier or a credential. If the server cannot be reached, the PDF still
downloads, with a local number and without a link, and the customer is told that it was not stored.

**Legacy quotations** (stored before this change) have no table row and no owner. Their former public
endpoints are gone, no session can reach them, and the daily purge still removes them after 60 days.

## Database (WordPress prefix, created by `dbDelta` on activation and on update)

- `{prefix}multi3d_quotes`: `id` (UUID, PK), `number` (UNIQUE), `owner_hash` (index), `post_id`
  (`multi3d_quote` record holding the JSON documents), `share_id`, `arrangement_sha256`,
  `status` (reserved, stored, ordered), `has_pdf`, `created_at`, `expires_at` (index with status).
- `{prefix}multi3d_shared_configs`: `id` (UUID, PK), `token_hash` (UNIQUE), `snapshot` (JSON),
  `schema_version`, `owner_hash`, `quote_id`, `status` (active, ordered), `created_at`, `expires_at`.

No binaries in MySQL: PDFs and PNGs live in `uploads/multi3d-quotes/{id}/` (`Require all denied`).
The daily `multi3d_purge_quotes` cron removes expired quotations (with their record, files and link),
reservations abandoned for 24 hours, expired standalone links, unreferenced file directories older than a
day, and expired legacy quotations. Anything `ordered` is kept.

## Rate limits (WordPress transients; per client address and per session)

| Operation | Limit |
|---|---|
| Create shared link | 30/h per address, 20/h per session |
| Open shared link | 300/h per address |
| E-mail a link | 5/h per address, 10/day per session |
| Reserve quotation | 20/h per address, 10/h per session |
| E-mail a quotation | 5/h per address, 10/day per session |

## Other protections

- CSRF: SameSite=Lax cookie, plus `Origin` (or `Sec-Fetch-Site: same-origin`) equal to `MULTI3D_PUBLIC_URL`,
  plus the custom header `X-Multi3D-Request: 1` on every state-changing request.
- `Cache-Control: private, no-store` on every API response; `/c/*` pages are sent with
  `Referrer-Policy: no-referrer` and `X-Robots-Tag: noindex`.
- WordPress authentication failures are reported to the browser as 502 without details.
- No WooCommerce API credentials exist in the configurator, and the browser never sees the BFF secret.

## Production deployment changes

1. Run Next.js as a server (`next build && next start`, or a Node host). A static export cannot serve the BFF.
2. Server environment of the configurator (see `.env.example`): `MULTI3D_WP_URL`, `MULTI3D_BFF_SECRET`,
   `MULTI3D_PUBLIC_URL`, and, behind a proxy, `MULTI3D_TRUSTED_PROXY_HOPS`. Keep
   `NEXT_PUBLIC_WOOCOMMERCE_URL` for prices and the cart.
3. `wp-config.php`: `define( 'MULTI3D_BFF_SECRET', '<same value>' );`. `MULTI3D_ALLOWED_ORIGIN` is now only
   needed for cross-origin Store API price reads.
4. Update the plugin and reactivate it once (creates the tables and schedules the purge; an update without
   reactivation also creates them on `plugins_loaded`).
5. Serve the configurator over HTTPS (Secure cookie). The reverse proxy must overwrite, not trust,
   client-sent `X-Forwarded-For`.
6. The WordPress REST API must accept `PUT` and request bodies up to about 12 MB (renderings):
   `post_max_size`, and the web server and WAF limits.

## Tests

```bash
npm test             # vitest: domain, store/persistence, BFF route handlers (mocked WordPress)
npm run test:php     # the real plugin on a WordPress/WooCommerce stub (SQLite): auth, ownership,
                     # number collisions, rollback, retention, cart claim, order snapshots
npm run test:e2e     # Playwright: independent browser contexts → production build (port 3210)
                     # → BFF → real plugin via `php -S` (port 8790, test/php/server.php)
```

The end-to-end quotation test needs a GPU for the photorealistic renderings
(`MULTI3D_E2E_SOFTWARE_GL=1` forces software GL, but there the renderer cannot reach its sample targets).
The WordPress/WooCommerce stub in `test/php` is test code only. It translates the plugin's MySQL DDL to
SQLite and imitates the cart session. **The plugin has not been run against a real WordPress, WooCommerce
and MySQL installation.**
