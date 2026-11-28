import "server-only";
import type { NextRequest, NextResponse } from "next/server";
import type { BffConfig } from "./config";
import { isToken, randomToken } from "./crypto";

/**
 * Anonymous first-party session: a random 256-bit identifier in an HttpOnly cookie, created on the first
 * request that stores something for the customer (a shared link, a quotation). No account, no e-mail.
 *
 * - HttpOnly, SameSite=Lax, Secure (and the __Host- prefix) in production; Path=/; no Domain.
 * - A browser-session cookie (no Max-Age): closing the browser ends the session, so the next person on a
 *   shared computer never sees the previous customer's quotations. The stored quotations themselves
 *   stay on the server for 60 days (and in the customer's PDF / e-mail).
 * - WordPress only ever stores SHA-256(session id) as the owner of a resource; the raw identifier is
 *   forwarded to it with each signed request and is the proof of ownership.
 */
export function sessionCookieName(config: Pick<BffConfig, "secureCookies">): string {
  return config.secureCookies ? "__Host-m3d_sid" : "m3d_sid";
}

export interface Session {
  readonly id: string;
  readonly isNew: boolean;
}

export function readSession(request: NextRequest, config: BffConfig): Session | null {
  const value = request.cookies.get(sessionCookieName(config))?.value;
  return isToken(value) ? { id: value, isNew: false } : null;
}

export function readOrCreateSession(request: NextRequest, config: BffConfig): Session {
  return readSession(request, config) ?? { id: randomToken(), isNew: true };
}

export function applySessionCookie(response: NextResponse, session: Session, config: BffConfig): void {
  if (!session.isNew) return;
  response.cookies.set(sessionCookieName(config), session.id, {
    httpOnly: true,
    secure: config.secureCookies,
    sameSite: "lax",
    path: "/",
  });
}
