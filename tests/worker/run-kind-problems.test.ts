import { describe, expect, it } from "vitest";
import { loadRunKinds, runKindProblems, type RunKindDescriptor } from "../../src/worker/run-kind.js";
import { WORKER_KINDS } from "../../src/core/settings.js";
import { runKindLabel } from "../../src/controller/units/run-results/run-kind-label.js";

// The worker pool's startup check: a claimed kind with no run file would fail each of its runs only when claimed.

describe("run kinds at startup", () => {
  it("every kind the worker claims has its run file, and every run file is claimed", async () => {
    expect(runKindProblems(WORKER_KINDS, await loadRunKinds())).toEqual([]);
  });

  it("names a claimed kind with no file and a file no worker claims", () => {
    const found = new Map([["triage", {} as RunKindDescriptor], ["orphan", {} as RunKindDescriptor]]);
    expect(runKindProblems(["triage", "merge-check"], found)).toEqual([
      'run kind "merge-check" is claimed but has no run file (src/worker/runs/merge-check/merge-check.run.ts)',
      'run kind "orphan" has a run file but no worker claims it',
    ]);
  });
});

// A run kind's plain label for owner text (issue #810): one map over every RunKind, in the dashboard's words.
describe("runKindLabel", () => {
  it("names every run kind in plain words", () => {
    expect(runKindLabel("triage")).toBe("Triage");
    expect(runKindLabel("implement")).toBe("Implement");
    expect(runKindLabel("review")).toBe("Review");
    expect(runKindLabel("update")).toBe("Update");
    expect(runKindLabel("resolve")).toBe("Resolve");
    expect(runKindLabel("manual")).toBe("Manual");
    expect(runKindLabel("interactive")).toBe("Interactive task");
    expect(runKindLabel("improve")).toBe("Improve");
    expect(runKindLabel("merge-check")).toBe("Merge check");
    expect(runKindLabel("restart")).toBe("Restart");
    expect(runKindLabel("screenshot")).toBe("Screenshot");
    expect(runKindLabel("judge")).toBe("Judge");
    expect(runKindLabel("routine")).toBe("Routine");
  });
});
