import { describe, expect, it } from "vitest";
import { DEFAULT_COORDINATION } from "../src/core/coordination.js";
import { Sessions } from "../src/core/session.js";
import { SIZE_CAP_APPROVED } from "../src/core/size-cap.js";
import type { SplitLimits } from "../src/core/split.js";
import { FakeClock } from "../src/impl/clock/fake-clock.js";
import { FakeAuth, FakeIssues, FakeSandbox, MemorySessionFiles } from "./helpers/fakes/runner.js";
import { FakeBroker } from "./helpers/fakes/broker.js";
import { alice, cleanScanner, config, silent } from "./helpers/fakes/config.js";
import { issue, newStore, system } from "./helpers/store.js";

// `session finish`'s size gate reads the item's size caps (src/core/size-cap.ts): the one-time cap of its latest size_cap_approved record when it has one,
// else the project settings (max_diff_lines 1500 in the test config).

/** An open session on a RUNNING item whose approval stored a size_cap_approved record with `cap` as its one-time cap, when given. */
async function openSession(cap: SplitLimits | null) {
  const { store } = await newStore(new FakeClock());
  const sandbox = new FakeSandbox();
  sandbox.changedFiles = ["src/a/x.ts"];
  const sessions = new Sessions({
    store, sandbox, broker: new FakeBroker(), scanner: cleanScanner, auth: new FakeAuth(), clock: new FakeClock(),
    config: { ...config, coordination: DEFAULT_COORDINATION }, log: silent, files: new MemorySessionFiles(), issues: new FakeIssues({}),
    toolEnv: {}, owner: "session:host:1",
  });
  const { item } = await store.createWorkItem({ ...issue(1), title: "Item 1" }, system);
  const record = cap && { actor: "local:me", sizes: { lines: 1, files: 1 }, project_cap: { max_diff_lines: 1500, max_diff_files: 40 }, one_time_cap: cap, note: "why" };
  const detail = record ? { detail: { [SIZE_CAP_APPROVED]: JSON.stringify(record) } } : {};
  const r = await store.transition({ id: item.id, expected_version: 1, actor: system, reason: "seed", patch: { stage: "RUNNING", allowed_paths: ["src/a/"], tier: 2, done_criteria: ["x"] }, ...detail });
  if (!r.ok) throw new Error(r.reason);
  expect((await sessions.start({ target: item.id, person: alice })).ok).toBe(true);
  sandbox.numstat = "1501\t0\tsrc/a/x.ts\0"; // one line over the project's max_diff_lines
  return sessions;
}

describe("session finish: the item's size caps", () => {
  it("without a one-time cap: the project's max_diff_lines refuses the finish", async () => {
    const r = await (await openSession(null)).finish({});
    expect(r.ok).toBe(false);
    expect(r.lines.join("\n")).toContain("size: the diff changes 1501 lines (limit max_diff_lines = 1500)");
  });

  it("with a one-time cap: the item's cap is the limit", async () => {
    const r = await (await openSession({ max_diff_lines: 3000, max_diff_files: 60 })).finish({});
    expect(r.lines.join("\n")).not.toContain("size:");
  });
});
