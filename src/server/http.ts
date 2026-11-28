import "server-only";
import { NextResponse, type NextRequest } from "next/server";
import { readBffConfig, type BffConfig } from "./config";
import { applySessionCookie, readOrCreateSession, readSession, type Session } from "./session";
import { callWordPress, type WpCall } from "./wordpress";

/** Header every state-changing request from the configurator carries (CSRF: forces a same-origin fetch). */
export const CSRF_HEADER = "x-multi3d-request";

/** Private, customer-specific responses: never cached by the browser, a proxy or a CDN. */
export const PRIVATE_HEADERS: Readonly<Record<string, string>> = {
  "Cache-Control": "private, no-store, max-age=0",
  Pragma: "no-cache",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
};

export function privateJson(body: unknown, status = 200): NextResponse {
  return NextResponse.json(body, { status, headers: PRIVATE_HEADERS });
}

export function errorJson(code: string, status: number): NextResponse {
  return privateJson({ code }, status);
}

/**
 * The client address for rate limiting. Next.js appends the socket address to X-Forwarded-For; each
 * trusted reverse proxy in front of it appends one more. Entries further left are client-controlled.
 */
export function clientIp(request: NextRequest, config: BffConfig): string {
  const chain = (request.headers.get("x-forwarded-for") ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const ip = chain[chain.length - 1 - config.trustedProxyHops] ?? chain[0] ?? "";
  return /^[0-9a-fA-F:.]{2,45}$/.test(ip) ? ip : "unknown";
}

/**
 * CSRF protection for state-changing requests, on top of the SameSite=Lax cookie: the request must come
 * from the configurator's own origin (Origin header, or Sec-Fetch-Site) and carry the custom header,
 * which a cross-site form or a simple cross-origin request cannot send.
 */
export function checkSameOrigin(request: NextRequest, config: BffConfig): boolean {
  if (request.headers.get(CSRF_HEADER) !== "1") return false;
  const site = request.headers.get("sec-fetch-site");
  if (site && site !== "same-origin") return false;
  const origin = request.headers.get("origin");
  if (!origin) return site === "same-origin";
  const expected = config.publicUrl ? new URL(config.publicUrl).origin : request.nextUrl.origin;
  return origin === expected;
}

export interface HandlerContext {
  readonly request: NextRequest;
  readonly config: BffConfig;
  readonly session: Session | null;
  readonly ip: string;
  wp(call: Omit<WpCall, "clientIp" | "session">): Promise<Response>;
}

interface GuardOptions {
  /** "create": a session is started if there is none; "require": 401 without one; "optional". */
  readonly session: "create" | "require" | "optional";
  /** State-changing requests: CSRF check (default true for non-GET). */
  readonly csrf?: boolean;
}

/** Runs a BFF handler: configuration, CSRF, session, private headers, failures as JSON codes. */
export async function guarded(
  request: NextRequest,
  options: GuardOptions,
  handler: (ctx: HandlerContext) => Promise<NextResponse>,
): Promise<NextResponse> {
  const config = readBffConfig();
  if (!config) return errorJson("backend_not_configured", 503);
  const csrf = options.csrf ?? request.method !== "GET";
  if (csrf && !checkSameOrigin(request, config)) return errorJson("forbidden_origin", 403);
  const session = options.session === "create" ? readOrCreateSession(request, config) : readSession(request, config);
  if (options.session === "require" && !session) return errorJson("no_session", 401);
  const ip = clientIp(request, config);
  const ctx: HandlerContext = {
    request,
    config,
    session,
    ip,
    wp: (call) => callWordPress(config, { ...call, clientIp: ip, session: session?.id ?? null }),
  };
  let response: NextResponse;
  try {
    response = await handler(ctx);
  } catch {
    response = errorJson("backend_unreachable", 502);
  }
  for (const [name, value] of Object.entries(PRIVATE_HEADERS)) if (!response.headers.has(name)) response.headers.set(name, value);
  if (session) applySessionCookie(response, session, config);
  return response;
}

/** Relays a WordPress JSON answer: errors keep their status and code only (no backend details leak). */
export async function relayJson(response: Response, pick?: (body: Record<string, unknown>) => unknown): Promise<NextResponse> {
  const body = (await response.json().catch(() => null)) as Record<string, unknown> | null;
  if (!response.ok || !body) {
    const code = typeof body?.code === "string" && /^[a-z_]{2,40}$/.test(body.code) ? body.code : "backend_error";
    const status = response.status >= 400 && response.status < 600 ? response.status : 502;
    return errorJson(code, status === 401 || status === 403 ? 502 : status);
  }
  return privateJson(pick ? pick(body) : body, response.status);
}

/** Reads a JSON request body within a size limit, or null. */
export async function readJson(request: NextRequest, maxBytes: number): Promise<Record<string, unknown> | null> {
  const length = Number(request.headers.get("content-length") ?? "0");
  if (length > maxBytes) return null;
  const text = await request.text().catch(() => null);
  if (text === null || text.length > maxBytes) return null;
  try {
    const data = JSON.parse(text) as unknown;
    return typeof data === "object" && data !== null && !Array.isArray(data) ? (data as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export function publicBase(ctx: HandlerContext): string {
  return ctx.config.publicUrl ?? ctx.request.nextUrl.origin;
}
