import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

/**
 * TEST-ONLY material lab (e2e/material-lab/material-system.labspec.ts): the real material runtime, bed model, future-
 * furniture fixture and photo backends in a bare page, bundled by Vite (already installed with Vitest).
 * Never part of the Next.js application or its build. Serves the app's public/ (models, decors, HDRI).
 */
const root = fileURLToPath(new URL(".", import.meta.url));
const project = fileURLToPath(new URL("../..", import.meta.url));

export default defineConfig({
  root,
  publicDir: `${project}public`,
  resolve: { alias: { "@": `${project}src` } },
  server: { fs: { allow: [project] }, strictPort: true },
  logLevel: "warn",
});
