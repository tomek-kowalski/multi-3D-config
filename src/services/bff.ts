/**
 * Client of the configurator's own server (backend-for-frontend, src/app/api). Same origin: the
 * anonymous session cookie (HttpOnly) is sent by the browser; the custom header marks the request as
 * coming from the configurator itself (CSRF protection). The browser never talks to WordPress for
 * customer-specific data and never sees the server-to-server secret.
 */
export interface BffClient {
  /** "" for the same origin (the browser); an absolute origin in tests. */
  readonly baseUrl: string;
  readonly fetch: typeof fetch;
}

export const browserBff: BffClient = { baseUrl: "", fetch: (...args) => fetch(...args) };

export const CSRF_HEADER = "X-Multi3D-Request";

export type BffAnswer = { readonly status: number; readonly data: Record<string, unknown> } | { readonly status: 0; readonly data: null };

export async function bffRequest(
  client: BffClient,
  path: string,
  init: { method: "GET" | "POST" | "PUT"; json?: unknown; body?: Blob | Uint8Array; contentType?: string },
): Promise<BffAnswer> {
  const headers: Record<string, string> = { [CSRF_HEADER]: "1" };
  let body: BodyInit | undefined;
  if (init.json !== undefined) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(init.json);
  } else if (init.body !== undefined) {
    headers["Content-Type"] = init.contentType ?? "application/octet-stream";
    body = init.body as BodyInit;
  }
  let response: Response;
  try {
    response = await client.fetch(`${client.baseUrl}${path}`, { method: init.method, headers, body, credentials: "same-origin", cache: "no-store" });
  } catch {
    return { status: 0, data: null };
  }
  const data = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  return { status: response.status, data: data && typeof data === "object" ? data : {} };
}

/** The error code of a failed answer ("backend_unreachable" when the server could not be reached). */
export function answerCode(answer: BffAnswer): string {
  if (answer.status === 0) return "backend_unreachable";
  const code = answer.data?.code;
  return typeof code === "string" ? code : "backend_error";
}
