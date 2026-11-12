import { execFileSync } from "node:child_process";
import { join } from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

/**
 * The git revision the app is built from (`git rev-parse HEAD` of the checkout), the same revision scripts/build.mjs
 * stamps into dist/ for the UI server (src/ui/system-actions.ts serverRevision). Null when git cannot say.
 */
export function buildRevision(root: string): string | null {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() || null;
  } catch {
    return null;
  }
}

// The app is served by `factory ui` at /app/ from web/dist (src/ui/app.ts), under a CSP with script-src and
// style-src 'self' only: no inline script, no inline style, nothing from another origin.
export default defineConfig({
  root: import.meta.dirname,
  base: "/app/",
  plugins: [react(), tailwindcss()],
  // Vite's cache goes in the checkout, never in node_modules (shared and read-only in a run folder), as in vitest.config.ts.
  cacheDir: join(import.meta.dirname, "..", ".vite-cache"),
  // Built in, so the app can tell when the server it talks to runs other code (web/src/api.ts WEB_REV).
  define: { __FACTORY_REV__: JSON.stringify(buildRevision(join(import.meta.dirname, ".."))) },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    // The polyfill would be the only inline-looking code path; every supported browser has modulepreload.
    modulePreload: { polyfill: false },
    assetsInlineLimit: 0,
  },
});
