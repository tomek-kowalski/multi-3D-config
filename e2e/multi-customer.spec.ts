import { readFileSync } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { expect, test, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { DEFAULT_ROOM } from "../src/domain/room/defaults";
import {
  closeShareDialog,
  documentOf,
  harness,
  openConfigurator,
  richArrangement,
  seedWorkspace,
  sessionCookie,
  share,
  workspace,
} from "./fixtures";
import { APP_URL, PHP_URL } from "./playwright.config";

type Customer = { context: BrowserContext; page: Page };

async function customer(browser: Browser): Promise<Customer> {
  const context = await browser.newContext();
  const page = await context.newPage();
  return { context, page };
}

async function addFurniture(page: Page, name: string) {
  const row = page.locator("li", { has: page.getByText(name, { exact: true }) }).filter({ has: page.getByRole("button", { name: "Dodaj" }) });
  await row.getByRole("button", { name: "Dodaj" }).first().click();
}

const shareRows = () => harness<{ id: string; token_hash: string; snapshot: string; owner_hash: string | null; quote_id: string | null }[]>("shares");
const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
const tokenOf = (url: string) => url.split("/c/")[1];

test.describe.configure({ mode: "serial" });

test("three simultaneous customers get independent configurations (session isolation 1–5, 9)", async ({ browser }) => {
  const [a, b, c] = await Promise.all([customer(browser), customer(browser), customer(browser)]);
  await Promise.all([a, b, c].map(({ page }) => openConfigurator(page)));

  // 1. Each new customer starts with the default configuration, in its own workspace.
  const initial = await Promise.all([a, b, c].map(({ page }) => workspace(page)));
  for (const w of initial) {
    expect(w.arrangement.modules).toHaveLength(0);
    expect(w.arrangement.room.width).toBe(DEFAULT_ROOM.width);
  }
  expect(new Set(initial.map((w) => w.id)).size).toBe(3);

  // 2./3. Changes at the same time in different sessions.
  await Promise.all([addFurniture(a.page, "Szafka modułowa"), addFurniture(b.page, "ClickBed O"), addFurniture(c.page, "Szafka modułowa")]);
  await addFurniture(c.page, "ClickBed O");
  const [wa, wb, wc] = await Promise.all([a, b, c].map(({ page }) => workspace(page)));
  expect(wa.arrangement.modules.map((m) => m.typeId)).toEqual(["cabinet"]);
  expect(wb.arrangement.modules.map((m) => m.typeId)).toEqual(["clickbed-o"]);
  expect(wc.arrangement.modules.map((m) => m.typeId)).toEqual(["cabinet", "clickbed-o"]);

  // 4. Removing furniture in A affects A only.
  await a.page.getByRole("button", { name: "Usuń moduł" }).first().click();
  expect((await workspace(a.page)).arrangement.modules).toHaveLength(0);
  expect((await workspace(c.page)).arrangement.modules).toHaveLength(2);

  // 5. A reload restores each customer's own configuration.
  await Promise.all([a, b, c].map(({ page }) => page.reload()));
  await Promise.all([a, b, c].map(({ page }) => openConfigurator(page, page.url())));
  expect((await workspace(a.page)).arrangement.modules).toHaveLength(0);
  expect((await workspace(b.page)).arrangement.modules.map((m) => m.typeId)).toEqual(["clickbed-o"]);
  expect((await workspace(c.page)).arrangement.modules).toHaveLength(2);

  // Editing never talks to the server, so no session exists yet.
  for (const { context } of [a, b, c]) expect(await sessionCookie(context)).toBeUndefined();
  await Promise.all([a, b, c].map(({ context }) => context.close()));
});

test("tabs of one customer do not overwrite each other (10)", async ({ browser }) => {
  const { context, page } = await customer(browser);
  await openConfigurator(page);
  await addFurniture(page, "Szafka modułowa");
  // A new tab of the same browser starts with the default, not with the first tab's work.
  const second = await context.newPage();
  await openConfigurator(second);
  expect((await workspace(second)).arrangement.modules).toHaveLength(0);
  await addFurniture(second, "ClickBed O");
  await addFurniture(second, "ClickBed O");
  await page.reload();
  await openConfigurator(page, page.url());
  expect((await workspace(page)).arrangement.modules.map((m) => m.typeId)).toEqual(["cabinet"]);
  expect((await workspace(second)).arrangement.modules).toHaveLength(2);
  await context.close();
});

test("a complete configuration is shared, opened by several recipients at once and copied on write (11–23, 26)", async ({ browser }) => {
  const author = await customer(browser);
  const rich = richArrangement();
  await seedWorkspace(author.page, rich);
  await openConfigurator(author.page);

  const url = await share(author.page);
  expect(url).toMatch(new RegExp(`^${APP_URL}/c/[A-Za-z0-9_-]{43}$`)); // 256-bit token
  const dialog = author.page.locator("[data-share-dialog]");
  await expect(dialog).toContainText("dostępna przez 60 dni");
  await expect(dialog).toContainText("Każda osoba, która ma ten link, może ją otworzyć");
  await expect(dialog).toContainText("Odbiorcy mogą zmieniać własne kopie");
  for (const name of ["Kopiuj link", "Wyślij link e-mailem", "Zamknij"]) await expect(dialog.getByRole("button", { name })).toBeVisible();

  // 11. No registration: an anonymous, HttpOnly, Secure, SameSite=Lax first-party session cookie.
  const cookie = await sessionCookie(author.context);
  expect(cookie).toMatchObject({ httpOnly: true, secure: true, sameSite: "Lax" });
  expect(cookie!.expires).toBe(-1); // browser session
  await closeShareDialog(author.page);

  // The server stores the hash of the token only.
  const stored = (await shareRows()).find((r) => r.token_hash === sha256(tokenOf(url)))!;
  expect(stored).toBeTruthy();
  const original = stored.snapshot;
  expect(original).not.toContain(tokenOf(url));

  // 20. Two recipients open the same link at the same time.
  const [r1, r2] = await Promise.all([customer(browser), customer(browser)]);
  const openResponses = await Promise.all(
    [r1, r2].map(async ({ page }) => {
      const answer = page.waitForResponse((r) => r.url().endsWith("/api/shares/open"));
      await page.goto(url);
      return answer;
    }),
  );
  for (const response of openResponses) {
    const body = (await response.json()) as Record<string, unknown>;
    // 26. Only the snapshot: no owner, session, cart, quotation or e-mail data.
    expect(Object.keys(body).sort()).toEqual(["createdAt", "expiresAt", "snapshot"]);
    expect(JSON.stringify(body)).not.toMatch(/owner|session|cart|@|quote/i);
    expect(response.headers()["cache-control"]).toContain("no-store");
  }
  for (const { page } of [r1, r2]) {
    await expect(page.locator("[data-action-notice]")).toContainText("Wczytano udostępnioną konfigurację");
    // The token leaves the address bar (history, bookmarks, analytics, referrers).
    expect(new URL(page.url()).pathname).toBe("/");
    // 13.–19. Everything is restored exactly.
    const w = await workspace(page);
    expect(w.origin).toBe("shared");
    expect(w.arrangement).toEqual(documentOf(rich));
  }
  const restored = (await workspace(r1.page)).arrangement;
  expect(restored.room).toMatchObject({ width: 5600, depth: 4300, floorColor: "#8A6E52" });
  expect(restored.room.wallColors.left).toBe("#AABBCC");
  expect(restored.room.openings[0]).toMatchObject({ kind: "window", open: true });
  expect(restored.modules[0].placement).toMatchObject({ rotationDeg: 90, x: 2600, z: 900 });
  expect(restored.modules[1]).toMatchObject({ typeId: "clickbed-o", state: "unfolded" });
  expect(restored.modules[1].configuration).toMatchObject({ bed: { mattress: true, firmness: "H3" } });

  // 33. Current shop prices and availability are shown for the opened configuration.
  await expect(r1.page.locator("[data-shared-status=prices]")).toBeVisible();

  // 21./22. A recipient changes their copy and shares it: a new link; the original snapshot is unchanged.
  await addFurniture(r1.page, "Szafka modułowa");
  const changedUrl = await share(r1.page);
  expect(changedUrl).not.toBe(url);
  expect((await shareRows()).find((r) => r.token_hash === sha256(tokenOf(url)))!.snapshot).toBe(original);

  // 23. The original link still opens the original arrangement, for anyone.
  const r3 = await customer(browser);
  await r3.page.goto(url);
  await expect(r3.page.locator("[data-action-notice]")).toContainText("Wczytano");
  expect((await workspace(r3.page)).arrangement).toEqual(documentOf(rich));
  // … and the changed link opens the changed one.
  await r3.page.goto(changedUrl);
  await expect.poll(async () => (await workspace(r3.page)).arrangement.modules.length).toBe(3);

  // The author's own working configuration was never touched.
  expect((await workspace(author.page)).arrangement).toEqual(documentOf(rich));
  // Opening links created no session for the recipients who only looked.
  expect(await sessionCookie(r2.context)).toBeUndefined();
  for (const x of [author, r1, r2, r3]) await x.context.close();
});

test("sharing an unchanged configuration again reuses its link; e-mail retries never create snapshots (27, 28)", async ({ browser }) => {
  const { context, page } = await customer(browser);
  await seedWorkspace(page, richArrangement(5100));
  await openConfigurator(page);
  const url = await share(page);
  await closeShareDialog(page);
  expect(await share(page)).toBe(url);
  const before = (await shareRows()).length;

  const dialog = page.locator("[data-share-dialog]");
  await dialog.getByRole("button", { name: "Wyślij link e-mailem" }).click();
  await dialog.getByLabel("Adres e-mail odbiorcy").fill("doradca@");
  await dialog.getByRole("button", { name: "Wyślij", exact: true }).click();
  await expect(dialog.getByRole("alert")).toContainText("Podaj poprawny adres e-mail");
  await dialog.getByLabel("Adres e-mail odbiorcy").fill("doradca@example.pl");
  for (let i = 0; i < 2; i++) {
    await dialog.getByRole("button", { name: "Wyślij", exact: true }).click();
    await expect(dialog.getByRole("status").last()).toContainText("Link został wysłany na adres doradca@example.pl");
  }
  const mails = (await harness<{ recipient: string; body: string }[]>("mail")).filter((m) => m.recipient === "doradca@example.pl");
  expect(mails).toHaveLength(2);
  for (const m of mails) {
    expect(m.body).toContain(url);
    expect(m.body).toContain("60 dni");
  }
  expect((await shareRows()).length).toBe(before);
  // The recipient address is not stored with the configuration.
  expect(JSON.stringify(await shareRows())).not.toContain("doradca@");
  await context.close();
});

test("invalid and expired links are refused with a clear message (24, 25)", async ({ browser }) => {
  const { context, page } = await customer(browser);
  await page.goto(`/c/${randomBytes(32).toString("base64url")}`);
  await expect(page.locator("[data-shared-status=share_not_found]")).toContainText("Nieprawidłowy link");

  const author = await customer(browser);
  await seedWorkspace(author.page, richArrangement(4700));
  await openConfigurator(author.page);
  const url = await share(author.page);
  await harness(`expire-share&hash=${sha256(tokenOf(url))}`);
  await page.goto(url);
  const expired = page.locator("[data-shared-status=share_expired]");
  await expect(expired).toContainText("Link wygasł");
  await expired.getByRole("button", { name: "Nowa konfiguracja" }).click();
  await expect(expired).toHaveCount(0);
  expect((await workspace(page)).arrangement.modules).toHaveLength(0);
  await context.close();
  await author.context.close();
});

test("a link opened over unsaved changes asks first; Nowa konfiguracja resets but keeps links (6–8)", async ({ browser }) => {
  const author = await customer(browser);
  await seedWorkspace(author.page, richArrangement(4900));
  await openConfigurator(author.page);
  const url = await share(author.page);
  await closeShareDialog(author.page);

  const b = await customer(browser);
  await openConfigurator(b.page);
  await addFurniture(b.page, "Szafka modułowa");
  await b.page.goto(url); // same tab: B's unsaved work is in this tab
  await expect(b.page.getByRole("dialog", { name: "Wczytać udostępnioną konfigurację?" })).toBeVisible();
  await b.page.getByRole("button", { name: "Zachowaj bieżącą" }).click();
  expect((await workspace(b.page)).arrangement.modules.map((m) => m.typeId)).toEqual(["cabinet"]);
  await b.page.goto(url);
  await b.page.getByRole("button", { name: "Wczytaj konfigurację" }).click();
  await expect.poll(async () => (await workspace(b.page)).arrangement.room.width).toBe(4900);

  // 6. Nowa konfiguracja (with changes: confirmation) → default room, new workspace.
  await addFurniture(b.page, "Szafka modułowa");
  const before = await workspace(b.page);
  await b.page.getByRole("button", { name: "Nowa konfiguracja" }).click();
  await b.page.getByRole("button", { name: "Rozpocznij nową" }).click();
  const after = await workspace(b.page);
  expect(after.arrangement.modules).toHaveLength(0);
  expect(after.arrangement.room.width).toBe(DEFAULT_ROOM.width);
  expect(after.id).not.toBe(before.id);
  await b.page.reload();
  await openConfigurator(b.page, b.page.url());
  expect((await workspace(b.page)).arrangement.modules).toHaveLength(0); // the old one does not come back

  // 8. The previously generated link is still valid.
  const c = await customer(browser);
  await c.page.goto(url);
  await expect.poll(async () => (await workspace(c.page)).arrangement.room.width).toBe(4900);
  for (const x of [author, b, c]) await x.context.close();
});

test("the BFF rejects cross-site requests and foreign quotations (17, 35)", async ({ playwright }) => {
  const api = await playwright.request.newContext();
  const evil = await api.post(`${APP_URL}/api/shares`, { headers: { Origin: "https://evil.example", "X-Multi3D-Request": "1" }, data: {} });
  expect(evil.status()).toBe(403);
  const noHeader = await api.post(`${APP_URL}/api/shares`, { headers: { Origin: APP_URL }, data: {} });
  expect(noHeader.status()).toBe(403);
  // WordPress refuses requests that do not come from the BFF (no or wrong signature).
  const direct = await api.post(`${PHP_URL}/?rest_route=/multi3d/v1/quotes`, { data: { anything: 1 } });
  expect(direct.status()).toBe(401);
  const oldPublic = await api.post(`${PHP_URL}/?rest_route=/multi3d/v1/quotes/OF-20261124-ABCD/email`, { data: { email: "x@y.pl" } });
  expect(oldPublic.status()).toBe(404);
  await api.dispose();
});

test("quotations: PDF with the configuration link, isolation between customers, cart and order (29–41)", async ({ browser }) => {
  test.setTimeout(420_000);
  const a = await customer(browser);
  const b = await customer(browser);
  const rich = richArrangement(5300);
  await seedWorkspace(a.page, rich);
  await openConfigurator(a.page);
  const otherRich = richArrangement(6200);
  await seedWorkspace(b.page, otherRich);
  await openConfigurator(b.page);

  // 36. Two customers generate quotations at the same time.
  const generate = async (page: Page) => {
    await page.getByRole("button", { name: "Zamówienie" }).click();
    await page.getByRole("tab", { name: "Drukuj ofertę" }).click();
    const download = page.waitForEvent("download", { timeout: 300_000 });
    await page.getByRole("button", { name: "Zapisz PDF na komputerze" }).click();
    const file = await (await download).path();
    await expect(page.locator("[data-quote-panel] [role=status]").last()).toContainText(/Oferta OF-\d{8}-[A-Z2-9]{6} została zapisana jako PDF\./, { timeout: 120_000 });
    return readFileSync(file!).toString("latin1");
  };
  const [pdfA, pdfB] = await Promise.all([generate(a.page), generate(b.page)]);

  const quotes = await harness<{ id: string; number: string; owner_hash: string; status: string; has_pdf: string | number }[]>("quotes");
  const numberIn = (pdf: string) => quotes.find((q) => pdf.includes(q.number))!;
  const qa = numberIn(pdfA);
  const qb = numberIn(pdfB);
  expect(qa.id).not.toBe(qb.id);
  expect(qa.owner_hash).not.toBe(qb.owner_hash);

  // 31. Each PDF links to its own configuration snapshot; 32. the link reopens exactly that arrangement.
  const linkOf = (pdf: string) => /\/URI \((http[^)]+\/c\/[A-Za-z0-9_-]{43})\)/.exec(pdf)![1];
  const linkA = linkOf(pdfA);
  expect(linkOf(pdfB)).not.toBe(linkA);
  // A keeps working after the quotation: the link still opens the quoted arrangement, not the new one.
  await a.page.getByRole("dialog").getByRole("button", { name: "Zamknij" }).click();
  await addFurniture(a.page, "Szafka modułowa");
  expect((await workspace(a.page)).arrangement.modules).toHaveLength(3);
  const viewer = await customer(browser);
  await viewer.page.goto(linkA);
  await expect.poll(async () => (await workspace(viewer.page)).arrangement).toEqual(documentOf(rich));
  await a.page.getByRole("button", { name: "Usuń moduł" }).click(); // back to the quoted arrangement
  await a.page.getByRole("button", { name: "Zamówienie" }).click();
  await a.page.getByRole("tab", { name: "Drukuj ofertę" }).click();

  // 35. Quotations are private to their session.
  const listA = (await (await a.page.request.get("/api/quotes")).json()) as { quotes: { id: string }[] };
  expect(listA.quotes.map((q) => q.id)).toContain(qa.id);
  expect(listA.quotes.map((q) => q.id)).not.toContain(qb.id);
  expect((await b.page.request.get(`/api/quotes/${qa.id}/pdf`)).status()).toBe(404);
  expect((await viewer.page.request.get(`/api/quotes/${qa.id}/pdf`)).status()).toBe(401);
  const own = await a.page.request.get(`/api/quotes/${qa.id}/pdf`);
  expect(own.status()).toBe(200);
  expect(own.headers()["cache-control"]).toContain("no-store");
  expect((await own.body()).subarray(0, 5).toString()).toBe("%PDF-");
  expect((await b.page.request.post(`/api/quotes/${qa.id}/email`, { headers: { "X-Multi3D-Request": "1", Origin: APP_URL }, data: { email: "x@example.pl" } })).status()).toBe(404);

  // E-mail of the quotation (owner).
  const panel = a.page.locator("[data-quote-panel]");
  await panel.getByRole("button", { name: "Wyślij ofertę e-mailem" }).click();
  await panel.getByLabel("Adres e-mail odbiorcy").fill("klient-a@example.pl");
  await panel.getByRole("button", { name: "Wyślij", exact: true }).click();
  await expect(panel.locator("[role=status]").last()).toContainText("została wysłana na adres klient-a@example.pl");
  const mail = (await harness<{ recipient: string; subject: string; attachments: string }[]>("mail")).find((m) => m.recipient === "klient-a@example.pl")!;
  expect(mail.subject).toContain(qa.number);
  expect(JSON.parse(mail.attachments)[0].pdf).toBe(true);

  // 37.–40. Cart hand-off: each customer's own WooCommerce session; the order keeps the snapshots.
  await a.page.getByRole("tab", { name: /Cały układ/ }).click();
  for (const box of await a.page.getByRole("checkbox").all()) await box.check();
  await a.page.getByRole("button", { name: "Przejdź do koszyka" }).click();
  await a.page.waitForURL(`${PHP_URL}/?harness=cart`);
  const cartA = JSON.parse((await a.page.locator("body").textContent())!) as { session: string; lines: { product_id: number }[]; quote_id: string; has_arrangement: boolean };
  expect(cartA.lines.map((l) => l.product_id)).toContain(4000);
  expect(cartA.quote_id).toBe(qa.id);
  expect(cartA.has_arrangement).toBe(true);
  // B's shop session is separate and empty; opening A's link did not copy A's cart.
  await b.page.goto(`${PHP_URL}/?harness=cart`);
  const cartB = JSON.parse((await b.page.locator("body").textContent())!) as { session: string | null; lines: unknown[] };
  expect(cartB.session).not.toBe(cartA.session);
  expect(cartB.lines).toHaveLength(0);
  await viewer.page.goto(`${PHP_URL}/?harness=cart`);
  expect(JSON.parse((await viewer.page.locator("body").textContent())!).lines).toHaveLength(0);

  // Checkout in A's shop session.
  const order = (await (await a.page.request.post(`${PHP_URL}/?harness=checkout`)).json()) as { meta_keys: string[]; quote_number: string };
  expect(order.quote_number).toBe(qa.number);
  expect(order.meta_keys).toEqual(expect.arrayContaining(["_multi3d_arrangement", "_multi3d_quote_id", "_multi3d_quote"]));

  // 41. Expiry cleanup removes B's expired quotation but keeps A's ordered one and its link.
  await harness(`expire-quote&id=${qb.id}`);
  await harness("purge");
  const after = await harness<{ id: string; status: string }[]>("quotes");
  expect(after.find((q) => q.id === qa.id)?.status).toBe("ordered");
  expect(after.find((q) => q.id === qb.id)).toBeUndefined();
  const again = await customer(browser);
  await again.page.goto(linkA);
  await expect.poll(async () => (await workspace(again.page)).arrangement).toEqual(documentOf(rich));
  for (const x of [a, b, viewer, again]) await x.context.close();
});
