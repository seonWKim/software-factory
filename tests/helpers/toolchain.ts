import { createRequire } from "node:module";
import { join } from "node:path";

const require = createRequire(join(process.cwd(), "package.json"));

/** The TypeScript compiler script, found by Node resolution (works when node_modules sits in a parent directory, as in a worktree). */
export const TSC_JS = require.resolve("typescript/bin/tsc");
