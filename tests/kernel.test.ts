import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ControllerDeps } from "../src/core/controller-deps.js";
import { Kernel } from "../src/controller/units/kernel.js";
import { FakeForge, cleanScanner, config, silent } from "./helpers/fakes.js";

/** A kernel over `forge` alone: no store call is made here. Signals are discovered from an empty folder. */
function kernel(forge: FakeForge | null) {
  const deps = { store: {}, clock: { now: () => new Date() }, config, scanner: cleanScanner, log: silent, auth: {}, forge } as unknown as ControllerDeps;
  const none = async () => { throw new Error("unused"); };
  return new Kernel(deps, { record: none, announce: none, emit: none, actions: none, byKey: none }, { beforeMerge: none }, mkdtempSync(join(tmpdir(), "sf-kernel-")));
}

/** A forge with the CI gate's rerun and log calls (design 05-ci-gate), recording each. */
class RerunForge extends FakeForge {
  calls: string[] = [];
  async rerunFailedJobs(head_sha: string): Promise<void> {
    this.calls.push(`rerun ${head_sha}`);
  }
  async failedJobLog(head_sha: string): Promise<string> {
    this.calls.push(`log ${head_sha}`);
    return "FAIL  tests/a.test.ts > b";
  }
}

describe("Kernel reader: the forge's optional CI calls", () => {
  it("passes rerunFailedJobs and failedJobLog through when the forge has them", async () => {
    const forge = new RerunForge();
    const reader = kernel(forge).reader;
    await reader.forge!.rerunFailedJobs!("h1");
    expect(await reader.forge!.failedJobLog!("h1")).toBe("FAIL  tests/a.test.ts > b");
    expect(forge.calls).toEqual(["rerun h1", "log h1"]);
  });

  it("leaves them out when the forge has none, and the forge out when config selects none", () => {
    const reader = kernel(new FakeForge()).reader;
    expect(reader.forge).not.toBeNull();
    expect(reader.forge).not.toHaveProperty("rerunFailedJobs");
    expect(reader.forge).not.toHaveProperty("failedJobLog");
    expect(kernel(null).reader.forge).toBeNull();
  });
});
