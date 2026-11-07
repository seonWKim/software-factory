import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// The app is served by `factory ui` at /app/ from web/dist (src/ui/app.ts), under a CSP with script-src and
// style-src 'self' only: no inline script, no inline style, nothing from another origin.
export default defineConfig({
  root: import.meta.dirname,
  base: "/app/",
  plugins: [react(), tailwindcss()],
  build: {
    outDir: "dist",
    emptyOutDir: true,
    // The polyfill would be the only inline-looking code path; every supported browser has modulepreload.
    modulePreload: { polyfill: false },
    assetsInlineLimit: 0,
  },
});
