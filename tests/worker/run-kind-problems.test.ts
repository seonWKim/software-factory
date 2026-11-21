import { describe, expect, it } from "vitest";
import { loadRunKinds, runKindProblems, type RunKindDescriptor } from "../../src/worker/run-kind.js";
import { WORKER_KINDS } from "../../src/core/settings.js";

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
