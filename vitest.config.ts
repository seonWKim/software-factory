import { defineConfig } from "vitest/config";

export default defineConfig({
  // JSX in the web tests (tests/*.test.tsx) uses React's automatic runtime, as web/ does.
  oxc: { jsx: { runtime: "automatic" } },
  test: {
    // .tsx tests are the web app's; each one sets `@vitest-environment jsdom` itself, so every other test keeps
    // the default node environment.
    include: ["tests/**/*.test.ts", "tests/**/*.test.tsx"],
    exclude: ["node_modules", "dist", ".worktrees", ".factory"],
  },
});
