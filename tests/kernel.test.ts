import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ControllerDeps } from "../src/core/controller-deps.js";
import { Kernel } from "../src/controller/units/kernel.js";
import routinesUnit from "../src/controller/units/routines/routines.unit.js";
import scheduleUnit from "../src/controller/units/schedule/schedule.unit.js";
import { FakeForge } from "./helpers/fakes/forge.js";
import { cleanScanner, config, silent } from "./helpers/fakes/config.js";
import { issue, newStore, system } from "./helpers/store.js";

/** A kernel over `forge` (and `store`, else none: no store call is made). Signals are discovered from an empty folder. */
function kernel(forge: FakeForge | null, store: unknown = {}, sources: unknown[] = []) {
  const deps = { store, clock: { now: () => new Date() }, config, scanner: cleanScanner, log: silent, auth: {}, forge, sources } as unknown as ControllerDeps;
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

describe("Kernel filingSource: the one lookup of the source that files an item", () => {
  it("returns the first source in config order that can file, bound, and filer() names its type", async () => {
    const filed: unknown[] = [];
    const chat = { type: "chat" };
    const tracker = { type: "tracker", async fileIssue(this: { type: string }, input: unknown) { filed.push([this.type, input]); return { id: "T-1" }; } };
    const other = { type: "other", async fileIssue() { throw new Error("not the first filer"); } };
    const k = kernel(null, {}, [chat, tracker, other]);
    const source = k.filingSource();
    expect(source?.type).toBe("tracker");
    expect(await source!.fileIssue({ title: "t" } as never)).toEqual({ id: "T-1" });
    expect(filed).toEqual([["tracker", { title: "t" }]]);
    expect(k.filer()).toBe("tracker");
  });

  it("returns null, and filer() null, when no source can file", () => {
    const k = kernel(null, {}, [{ type: "chat" }]);
    expect(k.filingSource()).toBeNull();
    expect(k.filer()).toBeNull();
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

describe("Kernel: routine runs are planned only by the schedule path", () => {
  it("the reader plans no routine and the routines unit runs no step; the schedule unit's step claims Check a page rows", () => {
    expect("routinePlans" in kernel(null).reader).toBe(false);
    expect(routinesUnit.steps ?? []).toEqual([]);
    expect((scheduleUnit.steps ?? []).map((s) => s.name)).toContain("schedules");
  });
});
