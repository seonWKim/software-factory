import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// The implement run split by job (issue #751): the run kind and main flow stay in implement.run.ts; sync and
// conflicts, the pre-push checks and gates, and the diff, WIP and bundle handling each have their own file, so
// parallel items that change different parts of the run do not share one path.

const DIR = join(import.meta.dirname, "..", "src", "worker", "runs", "implement");
const read = (file: string) => readFileSync(join(DIR, file), "utf8");
const defines = (text: string, name: string) => new RegExp(`^(export )?(async function|function|const) ${name}\\b`, "m").test(text);

const SPLIT: Record<string, string[]> = {
  "implement-sync.ts": ["syncBase", "resolveStep", "commitSync", "restartMerge", "conflictStep", "mergeConflict"],
  "implement-checks.ts": [
    "checksBeforePush", "failsOnBase", "fixStep", "checksFailed", "checksEnv", "gateHooks", "cleanTree", "differs",
    "unmerged", "prePushGates", "scopeGateStep", "RATCHET_LISTS", "SHRINK_ENV",
  ],
  "implement-wip.ts": [
    "watchDiff", "branchDiff", "overBudget", "keepStopped", "commitWorktree", "pauseImplement", "saveRunBundle",
    "restoreWip", "preflight", "resumeWip", "checkoutClean", "keepWip",
  ],
};

describe("implement run split", () => {
  it("each moved function lives in its new file, and no longer in implement.run.ts", () => {
    const run = read("implement.run.ts");
    for (const [file, names] of Object.entries(SPLIT)) {
      const text = read(file);
      for (const name of names) {
        expect(defines(text, name), `${name} in ${file}`).toBe(true);
        expect(defines(run, name), `${name} still in implement.run.ts`).toBe(false);
      }
    }
  });

  it("implement.run.ts keeps the run kind, the main flow and the prompt context helpers", () => {
    const run = read("implement.run.ts");
    for (const name of ["implement", "prFeedback", "failedChecks", "previousContext"]) expect(defines(run, name), name).toBe(true);
    expect(run).toMatch(/^export default defineRunKind\(\{\n {2}name: "implement",\n {2}folder: true,/m);
    expect(run).toMatch(/^type AgentStep =/m);
  });

  it("no split file imports implement.run.ts, and each stays under the 600-line budget", () => {
    for (const file of ["implement.run.ts", ...Object.keys(SPLIT)]) {
      const text = read(file);
      if (file !== "implement.run.ts") expect(text, file).not.toMatch(/from\s+["']\.\/implement\.run\.js["']/);
      expect(text.split("\n").length, file).toBeLessThan(600);
    }
  });
});
