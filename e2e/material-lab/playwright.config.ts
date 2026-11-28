import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { defineConfig } from "@playwright/test";

/**
 * Browser-level verification of the universal material system on a real GPU (material lab, Vite).
 * Run: npx playwright test -c e2e/material-lab/playwright.config.ts
 * Port 8792 (never 3000/3100). MULTI3D_E2E_SOFTWARE_GL=1 forces SwiftShader (no path-tracing claims then).
 */
export const LAB_URL = "http://localhost:8792";
const root = resolve(__dirname, "../..");
const cached = join(homedir(), "AppData/Local/ms-playwright/chromium-1243/chrome-win64/chrome.exe");

export default defineConfig({
  testDir: ".",
  testMatch: "*.labspec.ts",
  timeout: 600_000,
  expect: { timeout: 60_000 },
  workers: 1,
  reporter: [["list"]],
  use: {
    baseURL: LAB_URL,
    viewport: { width: 1280, height: 800 },
    launchOptions: {
      ...(existsSync(cached) && !process.env.PLAYWRIGHT_BUNDLED_BROWSER ? { executablePath: cached } : {}),
      args: process.env.MULTI3D_E2E_SOFTWARE_GL
        ? ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"]
        : ["--use-angle=d3d11", "--enable-gpu", "--ignore-gpu-blocklist"],
    },
  },
  webServer: {
    command: "npx vite --config e2e/material-lab/vite.config.mts --port 8792 --host localhost",
    cwd: root,
    url: `${LAB_URL}/`,
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
