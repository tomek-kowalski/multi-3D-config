import "server-only";
import { UUID_V4_PATTERN } from "./crypto";

/** Quotation ids in URLs: UUID v4 only (the human-readable number is never accepted as an identifier). */
export function quoteRoute(id: string, suffix = ""): string | null {
  return UUID_V4_PATTERN.test(id) ? `/multi3d/v1/quotes/${id}${suffix}` : null;
}

export const MAX_PDF_BYTES = 8 * 1024 * 1024;
export const MAX_RENDER_BYTES = 12 * 1024 * 1024;

/** Reads a binary request body up to `maxBytes` (null when larger). */
export async function readBinary(request: Request, maxBytes: number): Promise<Uint8Array | null> {
  const length = Number(request.headers.get("content-length") ?? "0");
  if (length > maxBytes) return null;
  const buffer = new Uint8Array(await request.arrayBuffer());
  return buffer.byteLength > 0 && buffer.byteLength <= maxBytes ? buffer : null;
}

export function startsWith(bytes: Uint8Array, signature: readonly number[]): boolean {
  return signature.every((b, i) => bytes[i] === b);
}

export const PDF_SIGNATURE = [0x25, 0x50, 0x44, 0x46, 0x2d]; // %PDF-
export const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
