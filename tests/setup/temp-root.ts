import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// One temp folder per `npm test` run (2026-11-20). 131 test files make temp folders and most never remove them; a
// factory run's tests run inside a Claude Code session whose TMPDIR is shared, so each run left thousands of sf-*
// folders behind (900,000 entries, about 134 GB, on 2026-11-20). vitest runs this before it starts its workers, which
// inherit TMPDIR, so every `tmpdir()` in a test is under this folder; the teardown removes the folder and all in it.

/** Points TMPDIR at a new folder for this run; the returned teardown removes the folder and restores TMPDIR. */
export function useRunTempRoot(env: NodeJS.ProcessEnv = process.env): () => void {
  const before = env.TMPDIR;
  const root = mkdtempSync(join(before ?? tmpdir(), "sf-test-run-"));
  env.TMPDIR = root;
  return () => {
    if (before === undefined) delete env.TMPDIR;
    else env.TMPDIR = before;
    rmSync(root, { recursive: true, force: true });
  };
}

/** vitest globalSetup: the run's temp folder, removed when the run ends. */
export default function setup(): () => void {
  return useRunTempRoot();
}
