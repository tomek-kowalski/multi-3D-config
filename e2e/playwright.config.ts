import { existsSync, mkdirSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { defineConfig } from "@playwright/test";

/**
 * Multi-customer end-to-end tests: independent browser contexts against a production build of the
 * configurator (its BFF route handlers) and the real WordPress plugin served by `php -S` on the
 * WordPress/WooCommerce test stub (test/php/server.php, SQLite). Run with `npm run test:e2e`, which
 * builds into .next-e2e first. Ports 3210 and 8790 (never 3000/3100).
 */
export const APP_URL = "http://localhost:3210";
export const PHP_URL = "http://127.0.0.1:8790";
export const E2E_SECRET = "e2e-only-secret-0123456789-abcdefghijklmnop";

const root = resolve(__dirname, "..");
const runDir = join(tmpdir(), "multi3d-e2e");
mkdirSync(runDir, { recursive: true });
const stamp = process.env.MULTI3D_E2E_STAMP ?? (process.env.MULTI3D_E2E_STAMP = String(Date.now()));

// The Chromium already installed for this Playwright cache, if the bundled revision is missing.
const cached = join(homedir(), "AppData/Local/ms-playwright/chromium-1243/chrome-win64/chrome.exe");

export default defineConfig({
  testDir: ".",
  timeout: 180_000,
  expect: { timeout: 20_000 },
  workers: 1,
  reporter: [["list"]],
  use: {
    baseURL: APP_URL,
    acceptDownloads: true,
    launchOptions: {
      ...(existsSync(cached) && !process.env.PLAYWRIGHT_BUNDLED_BROWSER ? { executablePath: cached } : {}),
      // The photorealistic quotation renderings need a real GPU (software GL cannot reach the sample
      // targets in time); MULTI3D_E2E_SOFTWARE_GL=1 forces SwiftShader on machines without one.
      args: process.env.MULTI3D_E2E_SOFTWARE_GL
        ? ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"]
        : ["--use-angle=d3d11", "--enable-gpu", "--ignore-gpu-blocklist"],
    },
  },
  webServer: [
    {
      command: "php -S 127.0.0.1:8790 test/php/server.php",
      cwd: root,
      url: `${PHP_URL}/?harness=mail`,
      reuseExistingServer: false,
      env: {
        MULTI3D_TEST_DB: join(runDir, `db-${stamp}.sqlite`),
        MULTI3D_TEST_UPLOADS: join(runDir, `uploads-${stamp}`),
        MULTI3D_BFF_SECRET: E2E_SECRET,
      },
    },
    {
      command: "npx next start -p 3210 -H localhost",
      cwd: root,
      url: `${APP_URL}/`,
      reuseExistingServer: false,
      timeout: 120_000,
      env: {
        MULTI3D_DIST_DIR: ".next-e2e",
        MULTI3D_WP_URL: PHP_URL,
        MULTI3D_BFF_SECRET: E2E_SECRET,
        MULTI3D_PUBLIC_URL: APP_URL,
      },
    },
  ],
});
