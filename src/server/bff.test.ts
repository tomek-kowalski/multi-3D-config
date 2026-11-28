import { createHash, createHmac } from "node:crypto";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { addModule } from "@/domain/arrangement/operations";
import type { Arrangement } from "@/domain/arrangement/types";
import { DEFAULT_ROOM } from "@/domain/room/defaults";
import { toSnapshotDocument } from "@/domain/sharing/snapshot";
import { POST as createShare } from "@/app/api/shares/route";
import { POST as openShare } from "@/app/api/shares/open/route";
import { POST as emailShare } from "@/app/api/shares/email/route";
import { GET as listQuotes, POST as reserveQuote } from "@/app/api/quotes/route";
import { PUT as storeQuote } from "@/app/api/quotes/[id]/route";
import { GET as getPdf } from "@/app/api/quotes/[id]/pdf/route";
import { POST as emailQuote } from "@/app/api/quotes/[id]/email/route";
import { readBffConfig } from "./config";
import { canonicalRequest } from "./wordpress";

const SECRET = "s3cr3t-s3cr3t-s3cr3t-s3cr3t-s3cr3t-0123";
const ORIGIN = "https://configurator.example.pl";
const SID_A = "A".repeat(43);
const ID = "3f2b8a4e-1c2d-4e5f-9a6b-7c8d9e0f1a2b";

type WpCall = { url: string; method: string; headers: Record<string, string>; body: string };
let wpCalls: WpCall[] = [];
let wpAnswers: Response[] = [];

beforeEach(() => {
  vi.stubEnv("MULTI3D_WP_URL", "https://shop.internal");
  vi.stubEnv("MULTI3D_BFF_SECRET", SECRET);
  vi.stubEnv("MULTI3D_PUBLIC_URL", ORIGIN);
  wpCalls = [];
  wpAnswers = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit) => {
      const body = init.body === undefined ? "" : typeof init.body === "string" ? init.body : Buffer.from(init.body as Uint8Array).toString("latin1");
      wpCalls.push({ url, method: String(init.method), headers: init.headers as Record<string, string>, body });
      const next = wpAnswers.shift();
      if (!next) throw new Error("no answer");
      return next;
    }),
  );
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

function arrangement(): Arrangement {
  const r = addModule({ room: DEFAULT_ROOM, modules: [] }, "cabinet");
  if (!r.ok) throw new Error();
  return r.value.arrangement;
}

function request(path: string, init: { method?: string; json?: unknown; body?: Uint8Array; session?: string; headers?: Record<string, string> } = {}) {
  const headers: Record<string, string> = {
    origin: ORIGIN,
    "sec-fetch-site": "same-origin",
    "x-multi3d-request": "1",
    "x-forwarded-for": "203.0.113.7",
    ...(init.json !== undefined ? { "content-type": "application/json" } : {}),
    ...(init.session ? { cookie: `__Host-m3d_sid=${init.session}` } : {}),
    ...init.headers,
  };
  return new NextRequest(`${ORIGIN}${path}`, {
    method: init.method ?? "POST",
    headers,
    body: init.json !== undefined ? JSON.stringify(init.json) : (init.body as BodyInit | undefined),
  });
}

const params = <T extends Record<string, string>>(p: T) => ({ params: Promise.resolve(p) });
const wpJson = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

/** Recomputes the signature WordPress verifies (includes/bff.php). */
function verifySignature(call: WpCall) {
  const route = decodeURIComponent(new URL(call.url).searchParams.get("rest_route")!);
  const h = call.headers;
  const canonical = canonicalRequest({
    method: call.method,
    route,
    timestamp: h["X-Multi3D-Timestamp"],
    nonce: h["X-Multi3D-Nonce"],
    bodyHash: createHash("sha256").update(Buffer.from(call.body, "latin1")).digest("hex"),
    session: h["X-Multi3D-Session"],
    clientIp: h["X-Multi3D-Client-IP"],
  });
  return createHmac("sha256", SECRET).update(canonical).digest("hex") === h["X-Multi3D-Signature"];
}

describe("BFF configuration", () => {
  it("requires a server-only WordPress URL and a strong shared secret", () => {
    expect(readBffConfig({ MULTI3D_WP_URL: "https://shop", MULTI3D_BFF_SECRET: "short" })).toBeNull();
    expect(readBffConfig({ MULTI3D_BFF_SECRET: SECRET })).toBeNull();
    expect(readBffConfig({ MULTI3D_WP_URL: "https://shop/", MULTI3D_BFF_SECRET: SECRET })).toMatchObject({ wpUrl: "https://shop", secureCookies: true });
  });

  it("answers 503 when not configured (no request reaches WordPress)", async () => {
    vi.stubEnv("MULTI3D_BFF_SECRET", "");
    const res = await createShare(request("/api/shares", { json: {} }));
    expect(res.status).toBe(503);
    expect(wpCalls).toHaveLength(0);
  });
});

describe("anonymous session and CSRF", () => {
  it("creates an HttpOnly, Secure, SameSite=Lax first-party session cookie on the first save", async () => {
    wpAnswers.push(wpJson(201, { id: ID, created_at: "2026-11-24T10:00:00+00:00", expires_at: "2027-01-23T10:00:00+00:00" }));
    const res = await createShare(request("/api/shares", { json: { snapshot: toSnapshotDocument({ arrangement: arrangement(), presentation: {} }) } }));
    expect(res.status).toBe(201);
    const cookie = res.headers.get("set-cookie")!;
    expect(cookie).toMatch(/^__Host-m3d_sid=[A-Za-z0-9_-]{43};/);
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/Secure/i);
    expect(cookie).toMatch(/SameSite=lax/i);
    expect(cookie).toMatch(/Path=\//);
    expect(cookie).not.toMatch(/Domain=|Max-Age|Expires/i); // first-party, ends with the browser session
    expect(res.headers.get("cache-control")).toBe("private, no-store, max-age=0");
    // The new session is the one forwarded to WordPress (its hash becomes the owner).
    expect(wpCalls[0].headers["X-Multi3D-Session"]).toBe(cookie.match(/m3d_sid=([^;]+)/)![1]);
  });

  it("rejects cross-site and header-less state-changing requests", async () => {
    const body = { json: {} };
    const variants: Record<string, string>[] = [{ origin: "https://evil.example" }, { "x-multi3d-request": "" }, { "sec-fetch-site": "cross-site" }];
    for (const headers of variants) {
      const res = await createShare(request("/api/shares", { ...body, headers }));
      expect(res.status).toBe(403);
    }
    expect(wpCalls).toHaveLength(0);
  });

  it("requires an existing session for private resources", async () => {
    expect((await emailShare(request("/api/shares/email", { json: { token: "t".repeat(43), email: "a@b.pl" } }))).status).toBe(401);
    expect((await getPdf(request(`/api/quotes/${ID}/pdf`, { method: "GET" }), params({ id: ID }))).status).toBe(401);
    expect(wpCalls).toHaveLength(0);
  });

  it("lists no quotations without a session (and creates none)", async () => {
    const res = await listQuotes(request("/api/quotes", { method: "GET" }));
    expect(await res.json()).toEqual({ quotes: [] });
    expect(res.headers.get("set-cookie")).toBeNull();
  });
});

describe("signed server-to-server calls", () => {
  it("signs every call; the shared-link token never reaches WordPress, only its hash", async () => {
    wpAnswers.push(wpJson(201, { id: ID, created_at: "2026-11-24T10:00:00+00:00", expires_at: "2027-01-23T10:00:00+00:00" }));
    const res = await createShare(request("/api/shares", { session: SID_A, json: { snapshot: toSnapshotDocument({ arrangement: arrangement(), presentation: {} }) } }));
    const { token, url } = (await res.json()) as { token: string; url: string };
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/); // 256 bits
    expect(url).toBe(`${ORIGIN}/c/${token}`);
    const call = wpCalls[0];
    expect(call.url).toBe("https://shop.internal/?rest_route=%2Fmulti3d%2Fv1%2Fshares");
    expect(verifySignature(call)).toBe(true);
    expect(call.headers["X-Multi3D-Session"]).toBe(SID_A);
    expect(call.headers["X-Multi3D-Client-IP"]).toBe("203.0.113.7");
    expect(call.body).not.toContain(token);
    expect(JSON.parse(call.body).token_hash).toBe(createHash("sha256").update(token).digest("hex"));
    expect(JSON.stringify(call.headers)).not.toContain(SECRET);
  });

  it("stores only the canonical snapshot (injected personal or private fields are dropped)", async () => {
    wpAnswers.push(wpJson(201, { id: ID, created_at: "x", expires_at: "y" }));
    const snapshot = { ...toSnapshotDocument({ arrangement: arrangement(), presentation: {} }), email: "klient@example.pl", cart: ["x"], session: SID_A };
    await createShare(request("/api/shares", { session: SID_A, json: { snapshot } }));
    const stored = JSON.parse(JSON.parse(wpCalls[0].body).snapshot);
    expect(Object.keys(stored).sort()).toEqual(["arrangement", "format", "presentation", "schemaVersion"]);
    expect(JSON.stringify(stored)).not.toMatch(/klient@|AAAAAAAA/);
  });

  it("rejects invalid snapshots before contacting WordPress", async () => {
    const res = await createShare(request("/api/shares", { session: SID_A, json: { snapshot: { format: "multi3d-configuration-snapshot", schemaVersion: 1, arrangement: { nope: 1 } } } }));
    expect(res.status).toBe(422);
    expect(wpCalls).toHaveLength(0);
  });

  it("opens a shared link read-only by token hash, without creating a session; 404 and 410 pass through", async () => {
    const snapshot = JSON.stringify(toSnapshotDocument({ arrangement: arrangement(), presentation: {} }));
    wpAnswers.push(wpJson(200, { snapshot, created_at: "a", expires_at: "2027-01-23T10:00:00+00:00" }));
    const token = "T".repeat(43);
    const ok = await openShare(request("/api/shares/open", { json: { token } }));
    expect(ok.status).toBe(200);
    expect(ok.headers.get("set-cookie")).toBeNull();
    const body = (await ok.json()) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(["createdAt", "expiresAt", "snapshot"]);
    expect(JSON.parse(wpCalls[0].body)).toEqual({ token_hash: createHash("sha256").update(token).digest("hex") });
    expect(wpCalls[0].headers["X-Multi3D-Session"]).toBe("");

    wpAnswers.push(wpJson(410, { code: "share_expired" }), wpJson(404, { code: "share_not_found" }));
    expect(await (await openShare(request("/api/shares/open", { json: { token } }))).json()).toEqual({ code: "share_expired" });
    expect((await openShare(request("/api/shares/open", { json: { token } }))).status).toBe(404);
    // A malformed token is rejected without a lookup.
    expect((await openShare(request("/api/shares/open", { json: { token: "short" } }))).status).toBe(404);
    expect(wpCalls).toHaveLength(3);
  });

  it("e-mails an existing link of this session only (WordPress decides by the session owner)", async () => {
    wpAnswers.push(wpJson(200, { sent: true }));
    const token = "T".repeat(43);
    const res = await emailShare(request("/api/shares/email", { session: SID_A, json: { token, email: " klient@example.pl ", locale: "pl" } }));
    expect(await res.json()).toEqual({ sent: true });
    expect(JSON.parse(wpCalls[0].body)).toEqual({ token_hash: createHash("sha256").update(token).digest("hex"), link: `${ORIGIN}/c/${token}`, email: "klient@example.pl", locale: "pl" });
    expect((await emailShare(request("/api/shares/email", { session: SID_A, json: { token, email: "x@y.pl\r\nBcc: z@w.pl" } }))).status).toBe(422);
  });

  it("addresses quotations by UUID only, never by quotation number", async () => {
    for (const id of ["OF-20261124-7K3Q", "../quotes", "3f2b8a4e-1c2d-1e5f-9a6b-7c8d9e0f1a2b"]) {
      expect((await getPdf(request(`/api/quotes/x/pdf`, { method: "GET", session: SID_A }), params({ id }))).status).toBe(404);
      expect((await emailQuote(request(`/api/quotes/x/email`, { session: SID_A, json: { email: "a@b.pl" } }), params({ id }))).status).toBe(404);
    }
    expect(wpCalls).toHaveLength(0);
  });

  it("reserves a quotation with the snapshot hash, and stores it only for that same configuration", async () => {
    wpAnswers.push(wpJson(201, { id: ID, number: "OF-20261124-7K3QZD", created_at: "a", expires_at: "b" }));
    const a = arrangement();
    const res = await reserveQuote(request("/api/quotes", { session: SID_A, json: { snapshot: toSnapshotDocument({ arrangement: a, presentation: {} }) } }));
    const body = (await res.json()) as Record<string, string>;
    expect(body).toMatchObject({ id: ID, number: "OF-20261124-7K3QZD" });
    expect(body.configurationUrl).toMatch(new RegExp(`^${ORIGIN}/c/[A-Za-z0-9_-]{43}$`));
    const reserved = JSON.parse(wpCalls[0].body);
    expect(reserved.arrangement_sha256).toMatch(/^[0-9a-f]{64}$/);

    wpAnswers.push(wpJson(201, { stored: true }));
    const quote = { format: "multi3d-quote", number: "OF-20261124-7K3QZD", order: { arrangement: toSnapshotDocument({ arrangement: a, presentation: {} }).arrangement } };
    const stored = await storeQuote(request(`/api/quotes/${ID}`, { method: "PUT", session: SID_A, json: { quote, renderings: [{}] } }), params({ id: ID }));
    expect(stored.status).toBe(201);
    const put = JSON.parse(wpCalls[1].body);
    expect(put.arrangement_sha256).toBe(reserved.arrangement_sha256); // WordPress compares the two
    expect(wpCalls[1].url).toContain(encodeURIComponent(`/multi3d/v1/quotes/${ID}`));
  });

  it("does not reveal WordPress authentication failures to the browser", async () => {
    wpAnswers.push(wpJson(401, { code: "multi3d_unauthorized", message: "Unauthorized." }));
    const res = await listQuotes(request("/api/quotes", { method: "GET", session: SID_A }));
    expect(res.status).toBe(502);
  });
});
