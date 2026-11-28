import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // End-to-end tests build into their own directory (see e2e/run.mjs), never over the regular build.
  distDir: process.env.MULTI3D_DIST_DIR || ".next",
  cacheComponents: true,
  partialPrefetching: true,
  experimental: {
    agentUpgrade: "security",
  },
  async headers() {
    return [
      {
        // Shared configuration links: the token in the URL is never sent as a referrer nor indexed.
        source: "/c/:token*",
        headers: [
          { key: "Referrer-Policy", value: "no-referrer" },
          { key: "X-Robots-Tag", value: "noindex, nofollow" },
        ],
      },
      {
        // Customer-specific API responses (also set by each handler).
        source: "/api/:path*",
        headers: [
          { key: "Cache-Control", value: "private, no-store, max-age=0" },
          { key: "X-Robots-Tag", value: "noindex" },
        ],
      },
    ];
  },
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
