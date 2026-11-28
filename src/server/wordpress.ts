import "server-only";
import type { BffConfig } from "./config";
import { hmacHex, randomToken, sha256Hex } from "./crypto";

/**
 * Signed server-to-server calls to the WordPress plugin (wordpress/multi3d-configurator, includes/bff.php).
 * Every request carries an HMAC-SHA256 signature (shared secret) over the method, REST route, timestamp,
 * a single-use nonce, the body hash, the customer's session identifier and the client address. The
 * plugin rejects unsigned, altered, stale (> 5 min) or replayed requests.
 *
 * The secret only proves that the request comes from this server. Access to a customer's resources is
 * decided by WordPress from the session identifier: it must hash to the stored owner of the resource.
 */
export const SIGNATURE_VERSION = "multi3d-bff-v1";

export interface WpCall {
  readonly method: "GET" | "POST" | "PUT";
  /** REST route, e.g. "/multi3d/v1/quotes". */
  readonly route: string;
  readonly session?: string | null;
  readonly clientIp: string;
  readonly json?: unknown;
  readonly binary?: { readonly bytes: Uint8Array; readonly contentType: string };
}

export function canonicalRequest(parts: {
  method: string;
  route: string;
  timestamp: string;
  nonce: string;
  bodyHash: string;
  session: string;
  clientIp: string;
}): string {
  return [SIGNATURE_VERSION, parts.method, parts.route, parts.timestamp, parts.nonce, parts.bodyHash, parts.session, parts.clientIp].join("\n");
}

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export async function callWordPress(config: BffConfig, call: WpCall, fetcher: FetchLike = fetch): Promise<Response> {
  const body: Uint8Array | string = call.binary ? call.binary.bytes : call.json === undefined ? "" : JSON.stringify(call.json);
  const timestamp = String(Math.floor(Date.now() / 1000));
  const nonce = randomToken();
  const session = call.session ?? "";
  const signature = hmacHex(
    config.secret,
    canonicalRequest({ method: call.method, route: call.route, timestamp, nonce, bodyHash: sha256Hex(body), session, clientIp: call.clientIp }),
  );
  const headers: Record<string, string> = {
    "X-Multi3D-Timestamp": timestamp,
    "X-Multi3D-Nonce": nonce,
    "X-Multi3D-Session": session,
    "X-Multi3D-Client-IP": call.clientIp,
    "X-Multi3D-Signature": signature,
    Accept: "application/json, application/pdf",
  };
  if (call.binary) headers["Content-Type"] = call.binary.contentType;
  else if (call.json !== undefined) headers["Content-Type"] = "application/json";
  // ?rest_route= works with and without pretty permalinks, and keeps the route exactly as signed.
  const url = `${config.wpUrl}/?rest_route=${encodeURIComponent(call.route)}`;
  return fetcher(url, {
    method: call.method,
    headers,
    body: call.method === "GET" ? undefined : (body as BodyInit),
    cache: "no-store",
    redirect: "manual",
    signal: AbortSignal.timeout(30_000),
  });
}
