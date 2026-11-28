import "server-only";

/**
 * Server-side configuration of the backend-for-frontend (route handlers under src/app/api). Every value
 * is a server environment variable: none of them may ever be a NEXT_PUBLIC_ variable.
 *
 * - MULTI3D_WP_URL        WordPress base URL reachable from this server (e.g. https://shop.example.pl).
 * - MULTI3D_BFF_SECRET    shared secret for server-to-server request signing; the same value is defined
 *                         as MULTI3D_BFF_SECRET in wp-config.php. At least 32 characters.
 * - MULTI3D_PUBLIC_URL    the configurator's public origin (e.g. https://configurator.example.pl): base
 *                         of shared links and the only Origin accepted for state-changing requests.
 * - MULTI3D_TRUSTED_PROXY_HOPS  number of reverse proxies in front of Next.js that append to
 *                         X-Forwarded-For (default 0). Used to find the client address for rate limits.
 * - MULTI3D_INSECURE_COOKIES=1  development over plain http on a non-localhost host only.
 */
export interface BffConfig {
  readonly wpUrl: string;
  readonly secret: string;
  readonly publicUrl: string | null;
  readonly trustedProxyHops: number;
  readonly secureCookies: boolean;
}

export const MIN_SECRET_LENGTH = 32;

export function readBffConfig(env: Readonly<Record<string, string | undefined>> = process.env): BffConfig | null {
  const wpUrl = (env.MULTI3D_WP_URL ?? "").trim().replace(/\/+$/, "");
  const secret = env.MULTI3D_BFF_SECRET ?? "";
  if (!wpUrl || !/^https?:\/\//.test(wpUrl) || secret.length < MIN_SECRET_LENGTH) return null;
  const publicUrl = (env.MULTI3D_PUBLIC_URL ?? "").trim().replace(/\/+$/, "") || null;
  const hops = Number.parseInt(env.MULTI3D_TRUSTED_PROXY_HOPS ?? "0", 10);
  return {
    wpUrl,
    secret,
    publicUrl,
    trustedProxyHops: Number.isFinite(hops) && hops >= 0 && hops < 10 ? hops : 0,
    secureCookies: env.MULTI3D_INSECURE_COOKIES !== "1",
  };
}
