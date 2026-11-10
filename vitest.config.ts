import { defineConfig } from "vitest/config";

// A factory run sets SF_TEST_WORKERS to its share of the host's CPUs (docs/design/05-coordination.md, Parallel
// workers), so ten runs at once do not each start a pool of every CPU. Unset (a developer's `npm test`): vitest's default.
const share = Number(process.env.SF_TEST_WORKERS);

export default defineConfig({
  // JSX in the web tests (tests/*.test.tsx) uses React's automatic runtime, as web/ does.
  oxc: { jsx: { runtime: "automatic" } },
  // Vite's cache and vitest's results go in the run folder, never in node_modules: a run folder's node_modules is
  // shared and read-only (docs/plugins/sandbox.md, `noop`). Vite's own default is node_modules/.vite.
  // This does not cover the temp file Vite writes to node_modules/.vite-temp while it loads this file: that happens
  // before any setting here applies, so the test scripts pass `--configLoader runner`, which writes none (same doc).
  cacheDir: ".vite-cache",
  test: {
    // .tsx tests are the web app's; each one sets `@vitest-environment jsdom` itself, so every other test keeps
    // the default node environment.
    include: ["tests/**/*.test.ts", "tests/**/*.test.tsx"],
    // With SF_TEST_MYSQL_URL: migrates one template database for the run, which MySQL tests copy (tests/helpers/store.ts).
    ...(process.env.SF_TEST_MYSQL_URL ? { globalSetup: ["tests/helpers/mysql-template-setup.ts"] } : {}),
    exclude: ["node_modules", "dist", ".worktrees", ".factory", ".vite-cache"],
    // A real MySQL round trip is slower, and a loaded CI runner more so: the default 5 s timed tests out there.
    testTimeout: process.env.SF_TEST_MYSQL_URL ? 20_000 : 5_000,
    // One MySQL server serves every worker, and each test file migrates a fresh database: at one worker per CPU the
    // server falls behind and tests time out at 20 s (2026-11-09, 10 CPUs: 20 timeouts; 4 workers: green in 6 min).
    ...(Number.isInteger(share) && share > 0 ? { maxWorkers: share } : process.env.SF_TEST_MYSQL_URL ? { maxWorkers: 4 } : {}),
  },
});
