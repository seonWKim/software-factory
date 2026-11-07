import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const require = createRequire(join(process.cwd(), "package.json"));

/** The TypeScript compiler script, found by Node resolution (works when node_modules sits in a parent directory, as in a worktree). */
export const TSC_JS = require.resolve("typescript/bin/tsc");

/** The node_modules directory the dependencies resolve from. */
export const NODE_MODULES = dirname(dirname(require.resolve("typescript/package.json")));

/** tsc arguments for execFileSync(process.execPath, tscArgs(...)). */
export function tscArgs(...args: string[]): string[] {
  return [TSC_JS, ...args];
}
