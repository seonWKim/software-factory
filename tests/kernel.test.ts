import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ControllerDeps } from "../src/core/controller-deps.js";
import { Kernel } from "../src/controller/units/kernel.js";
import { FakeForge } from "./helpers/fakes/forge.js";
import { cleanScanner, config, silent } from "./helpers/fakes/config.js";
import { issue, newStore, system } from "./helpers/store.js";

/** A kernel over `forge` (and `store`, else none: no store call is made). Signals are discovered from an empty folder. */
function kernel(forge: FakeForge | null, store: unknown = {}) {
  const deps = { store, clock: { now: () => new Date() }, config, scanner: cleanScanner, log: silent, auth: {}, forge } as unknown as ControllerDeps;
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

describe("Kernel commitItem: an entry into an owner state is an ask (design 06-efficiency)", () => {
  it("writes the reason code and the item's tier into the state change's detail, and nothing on other transitions", async () => {
    const { store } = await newStore();
    const { item } = await store.createWorkItem(issue(1), system);
    const k = kernel(null, store);
    const tiered = await k.commitItem([], { kind: "transition", input: { id: item.id, expected_version: item.version, patch: { stage: "READY", tier: 2 }, actor: system, reason: "triaged" } });
    if (!tiered.ok) throw new Error(tiered.reason);
    const blocked = await k.commitItem([], {
      kind: "transition",
      input: { id: item.id, expected_version: tiered.item.version, patch: { blocked_on: "human", blocked_reason: "run_failed:implement:checks_failed" }, actor: system, reason: "run_failed", detail: { run_id: "r1" } },
    });
    if (!blocked.ok) throw new Error(blocked.reason);
    const retiered = await k.commitItem([], {
      kind: "transition",
      input: { id: item.id, expected_version: blocked.item.version, patch: { blocked_on: "human", blocked_reason: "max_loops", tier: 4 }, actor: system, reason: "max_loops" },
    });
    if (!retiered.ok) throw new Error(retiered.reason);
    const changes = await store.listStateChanges(item.id);
    const detail = (reason: string) => changes.find((c) => c.reason === reason)!.detail;
    expect(detail("triaged")?.ask_reason).toBeUndefined();
    expect(detail("run_failed")).toEqual({ run_id: "r1", ask_reason: "run_failed", ask_tier: 2 });
    expect(detail("max_loops")).toEqual({ ask_reason: "max_loops", ask_tier: 4 });
  });
});
