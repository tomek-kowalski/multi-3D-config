// Builds the configurator for the end-to-end tests (into .next-e2e, with the test shop URL) and runs
// Playwright. Usage: npm run test:e2e [-- <playwright args>]
import { spawnSync } from "node:child_process";

const env = { ...process.env, MULTI3D_DIST_DIR: ".next-e2e", NEXT_PUBLIC_WOOCOMMERCE_URL: "http://127.0.0.1:8790" };
const run = (args) => {
  const result = spawnSync("npx", args, { stdio: "inherit", env, shell: true });
  if (result.status !== 0) process.exit(result.status ?? 1);
};
if (!process.argv.includes("--no-build")) run(["next", "build"]);
run(["playwright", "test", "-c", "e2e/playwright.config.ts", ...process.argv.slice(2).filter((a) => a !== "--no-build")]);
