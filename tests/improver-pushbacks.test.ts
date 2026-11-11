// The improver counts the owner's pushbacks next to run failures (issue #571): each `/reject`, `/revise` and explicit
// `changes` verdict with words, inside the window, on the item's latest succeeded run. Pushbacks with the same
// normalized words are one pattern; two of them make one group, so one draft and one filed proposal. No live model.

import { describe, expect, it } from "vitest";
import { PUSHBACK, enqueueImprove, fileReport, runImprove } from "../src/core/improver.js";
import type { Run, WorkItem, WorkerId } from "../src/core/types.js";
import { FakeClock } from "../src/impl/clock/fake-clock.js";
import { PatternEgressScanner } from "../src/impl/egress/pattern-egress-scanner.js";
import { LocalSource } from "../src/impl/source/local-source.js";
import type { LLMProvider, LLMRequest, LLMResponse } from "../src/interfaces/llm-provider.js";
import { issue, newStore, system } from "./helpers/store.js";
import { MemoryStorage, PROJECT } from "./helpers/fakes.js";

const TOKEN = `ghp_${"a".repeat(36)}`;

class CountingLLM implements LLMProvider {
  requests: LLMRequest[] = [];
  async complete(req: LLMRequest): Promise<LLMResponse> {
    this.requests.push(req);
    const parsed = { cause: "specs drop CLI flags", fix: "say in prompts/triage.md to keep flags", touches: ["docs/x.md"], needs_person: false };
    return { text: JSON.stringify(parsed), parsed, stop_reason: "end", usage: { input_tokens: 10, output_tokens: 5, cost_usd: null } };
  }
}

async function world(start = "2026-03-04T01:00:00.000Z") {
  const clock = new FakeClock(start);
  const { store } = await newStore(clock);
  let n = 0;
  /** A new item whose triage run succeeded (the spec the owner pushes back on). */
  const specced = async (): Promise<{ item: WorkItem; run: Run }> => {
    const { item } = await store.createWorkItem(issue(++n), system, { enqueue: { kind: "triage", idempotency_key: `t${n}` } });
    const claimed = (await store.claimRun({ worker_id: "seed" as WorkerId, kinds: ["triage"], lease_ms: 60_000 }))!;
    await store.completeRun(claimed.id, claimed.lease!.token, { status: "succeeded", summary: "spec", data: {} });
    clock.advance(1_000);
    return { item: (await store.getWorkItem(item.id))!, run: (await store.getRun(claimed.id))! };
  };
  const pushback = async (it: WorkItem, reason: "spec_rejected" | "spec_revision_requested", words: string) => {
    const r = await store.transition({ id: it.id, expected_version: it.version, actor: system, reason, patch: { spec_feedback: words } });
    if (!r.ok) throw new Error("setup failed");
    clock.advance(1_000);
  };
  const changes = async (it: WorkItem, words: string) => {
    const now = (await store.getWorkItem(it.id))!;
    const r = await store.recordVerdict({
      id: it.id, expected_version: now.version, actor: system, verdict: "changes", severity: "minor", reason: words,
      comment_id: `v${it.id}`, target: "issue", implicit: false, pr_head: null,
    });
    if (!r.ok) throw new Error("setup failed");
    clock.advance(1_000);
  };
  const improve = async (llm = new CountingLLM()) => {
    clock.set("2026-03-05T06:00:00.000Z");
    const { run } = await enqueueImprove({ store, clock }, PROJECT.key, "daily");
    const report = await runImprove({ store, storage: new MemoryStorage(), scanner: new PatternEgressScanner(async () => []), llm, prompt: "IMPROVE" }, run, { project: PROJECT.key });
    return { report, llm };
  };
  return { clock, store, specced, pushback, changes, improve };
}

describe("improve: pushbacks as signals", () => {
  it("two pushbacks on the same pattern produce one improver proposal: one group, one draft, one filed item", async () => {
    const w = await world();
    const a = await w.specced();
    const b = await w.specced();
    const c = await w.specced();
    await w.pushback(a.item, "spec_revision_requested", "Keep the existing CLI flag");
    await w.pushback(b.item, "spec_rejected", "keep the existing   CLI flag");
    await w.pushback(c.item, "spec_revision_requested", "split the test");

    const { report, llm } = await w.improve();
    const pushbackGroups = report.groups.filter((g) => g.error_code === PUSHBACK);
    expect(pushbackGroups).toEqual([
      expect.objectContaining({ detail: "keep the existing cli flag", run_ids: [a.run.id, b.run.id], work_item_ids: [a.item.id, b.item.id] }),
    ]);
    expect(pushbackGroups[0]!.draft).toMatchObject({ status: "drafted", cause: "specs drop CLI flags" });
    expect(llm.requests).toHaveLength(1);
    expect(llm.requests[0]!.messages[0]!.content).toContain("Runs the owner pushed back on with these words: 2");
    // A one-off pushback stays a one-run pattern: no proposal.
    expect(report.patterns).toEqual([expect.objectContaining({ error_code: PUSHBACK, detail: "split the test", run_ids: [c.run.id] })]);

    const source = new LocalSource(w.store);
    const filed = await fileReport({ store: w.store, scanner: new PatternEgressScanner(async () => []), clock: w.clock, file: source.fileIssue.bind(source), comment: async () => {} }, report);
    expect(filed.groups.map((g) => g.filing?.status)).toEqual(["filed"]);
    const items = (await w.store.listWorkItems(100)).filter((i) => i.source.id.startsWith("local-filed-"));
    expect(items).toHaveLength(1);
    expect(items[0]!.problem).toContain("pushbacks from the owner with the same words");
  });

  it("a changes verdict counts beside a /revise; flagged words and a pushback before the window do not", async () => {
    const w = await world("2026-03-03T12:00:00.000Z");
    const before = await w.specced();
    await w.pushback(before.item, "spec_revision_requested", "rename it");
    w.clock.set("2026-03-04T01:00:00.000Z");
    const a = await w.specced();
    const b = await w.specced();
    const c = await w.specced();
    await w.pushback(a.item, "spec_revision_requested", "rename it");
    await w.changes(b.item, "Rename it");
    await w.pushback(c.item, "spec_revision_requested", `the token ${TOKEN} again`);
    const { report } = await w.improve();
    expect(report.groups.filter((g) => g.error_code === PUSHBACK).map((g) => g.run_ids)).toEqual([[a.run.id, b.run.id]]);
    expect(JSON.stringify(report)).not.toContain(TOKEN);
  });
});
