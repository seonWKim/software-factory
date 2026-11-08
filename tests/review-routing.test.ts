import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { FactoryConfig } from "../src/core/config.js";
import { ControllerRole } from "../src/runtime/roles/controller-role.js";
import { parseImplement, parseReview, type ReviewOutput } from "../src/core/outputs.js";
import type { Run, WorkerId, WorkItem } from "../src/core/types.js";
import { Worker, reviewComment } from "../src/core/worker.js";
import { type GoldenRunDeps, runCases } from "../src/golden.js";
import { NoKeepAwake } from "../src/impl/awake/no-keep-awake.js";
import { FakeClock } from "../src/impl/clock/fake-clock.js";
import { PatternEgressScanner } from "../src/impl/egress/pattern-egress-scanner.js";
import type { AgentRunSpec } from "../src/interfaces/agent-runner.js";
import type { ForgeEvent } from "../src/interfaces/forge.js";
import type { SourceEvent } from "../src/interfaces/source-adapter.js";
import {
  FakeAuth, FakeBroker, FakeRunner, FakeSandbox, FakeForge, FakeSource, MemoryStorage,
  alice, cleanScanner, config, issueRef, prompts, silent, triageSpec,
} from "./helpers/fakes.js";
import { newStore } from "./helpers/store.js";

// Review routing by finding kind (issue #222): code findings loop back to implement, spec findings and an
// implementer's spec_conflict go back through triage as a spec revision.

const SECRET = "hunter2-very-secret-value";

type Answer = Record<string, unknown>;
const code = (text: string) => ({ kind: "code", text });
const spec = (text: string) => ({ kind: "spec", text });
const bug = (findings: unknown[], extra: Answer = {}): Answer => ({ verdict: "bug", tier: 2, findings, summary: "found things", ...extra });
const pass = (extra: Answer = {}): Answer => ({ verdict: "pass", tier: 2, findings: [], summary: "fine", ...extra });

/** A factory whose reviews answer in order from `reviews`, then pass; implement answers from `implements`, then plain. */
async function factory(opts: { reviews?: Answer[]; implements?: Answer[]; cfg?: Partial<FactoryConfig> } = {}) {
  const cfg: FactoryConfig = { ...config, ...opts.cfg };
  const clock = new FakeClock();
  const { store } = await newStore(clock);
  const source = new FakeSource();
  const forge = new FakeForge(source);
  const sandbox = new FakeSandbox();
  const broker = new FakeBroker();
  const reviews = [...(opts.reviews ?? [])];
  const implementsQ = [...(opts.implements ?? [])];
  const runner = new FakeRunner({
    triage: () => ({ output: triageSpec }),
    implement: () => ({ output: implementsQ.shift() ?? { summary: "s", next_steps: "n" } }),
    review: () => ({ output: reviews.shift() ?? pass() }),
  });
  const scanner = new PatternEgressScanner(async () => [SECRET]);
  const controller = new ControllerRole({ store, source, forge, auth: new FakeAuth(), clock, config: cfg, log: silent, scanner, repeated_failure_rule: false });
  const worker = new Worker({
    id: "w1" as WorkerId, store, sandbox, runner, broker, storage: new MemoryStorage(), clock, config: cfg, prompts, log: silent,
    scanner, toolEnv: { PATH: "/usr/bin" }, awake: new NoKeepAwake(),
  });
  const step = async () => {
    await controller.tickIntake();
    while (await worker.tick()) await controller.tickRuns();
    await controller.tickRuns();
  };
  let comments = 0;
  const src = issueRef(222);
  /** Intake, /approve: the first implement and review runs follow. */
  const start = async () => {
    source.queue.push({ kind: "item_requested", source: src, requester: alice, title: "t", body: "b" });
    await step();
    await approve();
    return item();
  };
  const approve = async () => {
    source.queue.push({ kind: "spec_approved", source: src, comment_id: String(300 + comments++), approver: alice });
    await step();
  };
  const item = async (): Promise<WorkItem> => (await store.getWorkItemBySource("github_issue", src.id))!;
  const runs = async (kind?: Run["kind"]) => (await store.listRuns((await item()).id)).filter((r) => !kind || r.kind === kind);
  const reasons = async () => (await store.listStateChanges((await item()).id)).map((c) => c.reason);
  const reviewComments = () =>
    broker.calls.filter((c) => c.name === "github.comment").map((c) => (c.args as { body: string }).body);
  return { store, source, forge, sandbox, broker, runner, controller, worker, step, start, approve, item, runs, reasons, reviewComments };
}

describe("parseReview: finding kinds and unverified checks", () => {
  it("accepts findings as { kind, text } objects and an unverified list of strings", () => {
    const r = parseReview(bug([code("off by one"), spec("needs src/x.ts")], { unverified: ["could not run npm test"] }));
    expect(r).toEqual({
      ok: true,
      value: {
        verdict: "bug", tier: 2, summary: "found things",
        findings: [{ kind: "code", text: "off by one" }, { kind: "spec", text: "needs src/x.ts" }],
        unverified: ["could not run npm test"],
      },
    });
  });

  it("rejects any other kind, a finding without text, and a non-string unverified item", () => {
    expect(parseReview(bug([{ kind: "nit", text: "x" }])).ok).toBe(false);
    expect(parseReview(bug([{ kind: "code" }])).ok).toBe(false);
    expect(parseReview(bug([{ kind: "code", text: 3 }])).ok).toBe(false);
    expect(parseReview(bug([42])).ok).toBe(false);
    expect(parseReview(pass({ unverified: ["ok", 3] })).ok).toBe(false);
    expect(parseReview(pass({ unverified: "tests" })).ok).toBe(false);
  });

  it("still accepts the old shape: each string is a code finding, unverified is empty", () => {
    const r = parseReview({ verdict: "bug", tier: 3, findings: ["a", "b"], summary: "s" });
    expect(r.ok).toBe(true);
    const v = (r as { value: ReviewOutput }).value;
    expect(v.findings).toEqual([{ kind: "code", text: "a" }, { kind: "code", text: "b" }]);
    expect(v.unverified ?? []).toEqual([]);
  });
});

describe("parseImplement: spec_conflict", () => {
  it("keeps a non-empty reason, trimmed", () => {
    expect(parseImplement({ summary: "s", next_steps: "n", spec_conflict: "  needs docs/x.md  " })).toMatchObject({
      ok: true, value: { spec_conflict: "needs docs/x.md" },
    });
  });

  it("a missing or empty spec_conflict parses as today", () => {
    const plain = { ok: true, value: { summary: "s", next_steps: "n", missing: [], deviations: [] } };
    expect(parseImplement({ summary: "s", next_steps: "n" })).toEqual(plain);
    expect(parseImplement({ summary: "s", next_steps: "n", spec_conflict: "" })).toEqual(plain);
    expect(parseImplement({ summary: "s", next_steps: "n", spec_conflict: "   " })).toEqual(plain);
  });

  it("rejects a spec_conflict that is not a string", () => {
    expect(parseImplement({ summary: "s", next_steps: "n", spec_conflict: 3 }).ok).toBe(false);
  });
});

describe("review routing", () => {
  it("a bug with only code findings queues one implement run, loop_count + 1, reason review_bug", async () => {
    const f = await factory({ reviews: [bug([code("off by one in gate")])] });
    const it0 = await f.start();
    expect(it0).toMatchObject({ stage: "REVIEW", blocked_reason: "merge_pending", loop_count: 1, revision_count: 0 });
    const implement = await f.runs("implement");
    expect(implement.map((r) => r.idempotency_key)).toEqual([`${it0.id}:implement:l0:r0`, `${it0.id}:implement:l1:r0`]);
    expect(await f.runs("triage")).toHaveLength(1);
    expect(await f.reasons()).toContain("review_bug");
    expect(f.reviewComments()[0]).toMatch(/^## Factory review: changes needed/);
  });

  for (const [name, findings] of [
    ["alone", [spec("criterion 2 needs src/core/policy.ts, outside allowed_paths")]],
    ["with code findings", [code("off by one"), spec("criterion 2 needs src/core/policy.ts, outside allowed_paths")]],
  ] as const) {
    it(`a spec finding ${name} starts one spec revision: triage under :v1, no implement run`, async () => {
      const f = await factory({ reviews: [bug([...findings])] });
      await f.start();
      const it1 = await f.item();
      // The revised spec waits at the gate (tier 2 needs approval in the test config).
      expect(it1).toMatchObject({ stage: "READY", blocked_reason: "spec_pending", revision_count: 1, loop_count: 0, restart_count: 1, pr_number: 42 });
      expect(it1.spec_feedback).toContain("criterion 2 needs src/core/policy.ts");
      if (findings.length === 2) expect(it1.spec_feedback).toContain("off by one");
      const triage = await f.runs("triage");
      expect(triage).toHaveLength(2);
      expect(triage[1]!.idempotency_key).toBe(`${it1.id}:triage:l0:r0:v1`);
      expect(await f.runs("implement")).toHaveLength(1);
      expect(await f.reasons()).toContain("review_spec_revision");
      expect(await f.reasons()).not.toContain("review_bug");
      expect(f.reviewComments()[0]).toMatch(/^## Factory review: spec needs a change/);
      expect(f.runner.specs.filter((s) => s.role === "triage").at(-1)!.prompt).toContain("criterion 2 needs src/core/policy.ts");
    });
  }

  it("after the revised spec is approved, implement runs under a new key on the same PR branch and keeps the PR", async () => {
    const f = await factory({ reviews: [bug([spec("needs a migration")])] });
    await f.start();
    await f.approve();
    const it2 = await f.item();
    expect(it2).toMatchObject({ stage: "REVIEW", blocked_reason: "merge_pending", pr_number: 42, loop_count: 0, revision_count: 1 });
    const keys = (await f.runs("implement")).map((r) => r.idempotency_key);
    expect(keys).toEqual([`${it2.id}:implement:l0:r0`, `${it2.id}:implement:l0:r1`]);
    const pushes = f.broker.calls.filter((c) => c.name === "github.push_branch").map((c) => (c.args as { branch: string }).branch);
    expect(pushes).toEqual([`factory/${it2.id}`, `factory/${it2.id}`]);
  });

  it("a spec finding at the revision limit blocks on a human with max_revisions, one comment, no triage run", async () => {
    const f = await factory({ reviews: [bug([spec("first")]), bug([spec("second")])], cfg: { max_loops: 1 } });
    await f.start();
    await f.approve();
    const it3 = await f.item();
    expect(it3).toMatchObject({ blocked_on: "human", blocked_reason: "max_revisions", revision_count: 1 });
    expect(await f.runs("triage")).toHaveLength(2);
    const limit = f.source.comments.filter((c) => c.marker.includes("max-revisions"));
    expect(limit).toHaveLength(1);
    expect(limit[0]!.body).toContain("max_revisions");
    // Applying again changes nothing and posts nothing.
    await f.step();
    expect(f.source.comments.filter((c) => c.marker.includes("max-revisions"))).toHaveLength(1);
    expect(await f.runs("triage")).toHaveLength(2);
  });

  it("a pass with unverified items goes through the CI gate as a pass; they are not findings", async () => {
    const f = await factory({ reviews: [pass({ unverified: ["could not run npm test: listen EPERM"] })] });
    f.forge.checkResults = [{ state: "passed" }];
    const it4 = await f.start();
    expect(it4).toMatchObject({ stage: "REVIEW", blocked_on: "human", blocked_reason: "merge_pending", loop_count: 0, revision_count: 0 });
    expect(f.forge.checkCalls).toEqual([42]);
    const review = (await f.runs("review"))[0]!;
    const stored = (review.outcome as unknown as { data: { review: ReviewOutput } }).data.review;
    expect(stored.findings).toEqual([]);
    expect(stored.unverified).toEqual(["could not run npm test: listen EPERM"]);
    const body = f.reviewComments()[0]!;
    expect(body).toMatch(/^## Factory review: pass/);
    expect(body).toContain("### Not verified\n\n- could not run npm test: listen EPERM");
  });

  it("finding text the egress scan flags stores nothing, blocks on a human and posts one comment naming the rule", async () => {
    const f = await factory({ reviews: [bug([spec(`the spec leaks ${SECRET}`)])] });
    const it5 = await f.start();
    expect(it5).toMatchObject({ blocked_on: "human", blocked_reason: "run_failed:review:egress_blocked", spec_feedback: null, revision_count: 0 });
    const review = (await f.runs("review"))[0]!;
    expect(JSON.stringify(review.outcome)).not.toContain(SECRET);
    expect(f.reviewComments()).toEqual([]);
    const leak = f.source.comments.filter((c) => c.marker.includes("leak-blocked"));
    expect(leak).toHaveLength(1);
    expect(leak[0]!.body).toContain("known_secret");
    expect(leak[0]!.body).not.toContain(SECRET);
    expect(await f.runs("triage")).toHaveLength(1);
  });

  it("on an adopted PR a bug with spec findings keeps today's route: changes requested, no implement or triage run", async () => {
    const f = await factory({ reviews: [bug([spec("needs a doc"), code("typo")])] });
    const pr: ForgeEvent = {
      kind: "change_open", source: { type: "github_issue", id: "o/r#50", link: "https://github.com/o/r/pull/50" }, change_ref: "50",
      head_branch: "feature/x", head_sha: "h1", title: "A change", body: "b", author: { provider: "github", subject: "2", login: "bob" }, labels: [],
    };
    f.forge.queue.push(pr);
    await f.step();
    const adopted = (await f.store.getWorkItemBySource("github_issue", "o/r#50"))!;
    expect(adopted).toMatchObject({ origin: "adopted", stage: "REVIEW", blocked_on: "human", blocked_reason: "changes_requested", revision_count: 0 });
    const kinds = (await f.store.listRuns(adopted.id)).map((r) => r.kind);
    expect(kinds).toEqual(["review"]);
  });
});

describe("implement spec_conflict", () => {
  it("fails with the reason, pushes nothing, and starts a spec revision with the reason as feedback", async () => {
    const f = await factory({ implements: [{ summary: "", next_steps: "", spec_conflict: "criterion 3 needs migrations/, outside allowed_paths" }] });
    f.sandbox.commits = [];
    await f.start();
    const it6 = await f.item();
    const implement = (await f.runs("implement"))[0]!;
    expect(implement.outcome).toMatchObject({ status: "failed", error_code: "spec_conflict", detail: "criterion 3 needs migrations/, outside allowed_paths" });
    expect(f.broker.calls.filter((c) => c.name === "github.push_branch" || c.name === "github.open_pr")).toEqual([]);
    expect(it6).toMatchObject({ stage: "READY", blocked_reason: "spec_pending", revision_count: 1, restart_count: 1, loop_count: 0 });
    expect(it6.spec_feedback).toContain("criterion 3 needs migrations/");
    expect((await f.runs("triage")).map((r) => r.idempotency_key).at(-1)).toBe(`${it6.id}:triage:l0:r0:v1`);
    const changes = await f.store.listStateChanges(it6.id);
    expect(changes.map((c) => c.reason)).toContain("spec_conflict_revision");
    expect(changes.some((c) => JSON.stringify(c).includes("no_commits") || JSON.stringify(c).includes("scope_violation"))).toBe(false);
    expect(it6.blocked_reason).not.toMatch(/no_commits|scope_violation/);
  });

  it("an empty spec_conflict runs as today", async () => {
    const f = await factory({ implements: [{ summary: "s", next_steps: "n", spec_conflict: "" }] });
    const it7 = await f.start();
    expect(it7).toMatchObject({ stage: "REVIEW", blocked_reason: "merge_pending", revision_count: 0 });
    expect(f.broker.calls.filter((c) => c.name === "github.push_branch")).toHaveLength(1);
  });

  it("a flagged reason stores nothing, blocks on a human and posts one comment naming the rule", async () => {
    const f = await factory({ implements: [{ summary: "", next_steps: "", spec_conflict: `needs the key ${SECRET}` }] });
    await f.start();
    const it8 = await f.item();
    expect(it8).toMatchObject({ blocked_on: "human", spec_feedback: null, revision_count: 0 });
    expect(it8.blocked_reason).toMatch(/egress_blocked/);
    const implement = (await f.runs("implement"))[0]!;
    expect(JSON.stringify(implement.outcome)).not.toContain(SECRET);
    const failed = f.source.comments.filter((c) => c.marker.includes("run-failed") || c.marker.includes("leak-blocked"));
    expect(failed).toHaveLength(1);
    expect(failed[0]!.body).toContain("known_secret");
    expect(f.broker.calls.filter((c) => c.name === "github.push_branch")).toEqual([]);
  });
});

describe("the PR review comment", () => {
  const v = (o: Partial<ReviewOutput>): ReviewOutput => ({ verdict: "bug", tier: 2, findings: [], summary: "sum", ...o });

  it("reads pass, changes needed or spec needs a change, never bugs found", () => {
    expect(reviewComment(v({ verdict: "pass" }))).toMatch(/^## Factory review: pass\n/);
    expect(reviewComment(v({ findings: [{ kind: "code", text: "x" }] }))).toMatch(/^## Factory review: changes needed\n/);
    const both = reviewComment(v({ findings: [{ kind: "code", text: "x" }, { kind: "spec", text: "y" }] }));
    expect(both).toMatch(/^## Factory review: spec needs a change\n/);
    expect(both).toContain("### Code\n\n- x");
    expect(both).toContain("### Spec\n\n- y");
    for (const body of [reviewComment(v({})), both]) expect(body).not.toContain("bugs found");
  });

  it("lists unverified checks under their own Not verified heading", () => {
    const body = reviewComment(v({ verdict: "pass", unverified: ["could not run the tests"] }));
    expect(body).toContain("### Not verified\n\n- could not run the tests");
    expect(reviewComment(v({ verdict: "pass" }))).not.toContain("Not verified");
  });
});

describe("golden replay on the new shape", () => {
  it("scores kind findings by verdict; unverified items never flag a case", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "sf-review-routing-"));
    const casesDir = join(tmp, "cases");
    for (const [id, expectValue] of [["1", "should_flag"], ["2", "should_pass"]] as const) {
      const dir = join(casesDir, id);
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, "diff.patch"), "diff --git a/x b/x\n");
      await writeFile(join(dir, "spec.md"), `spec for ${id}`);
      await writeFile(join(dir, "case.json"), JSON.stringify({ id, expect: expectValue }));
    }
    const runner = new FakeRunner({
      review: (s: AgentRunSpec) => ({
        output: s.prompt.includes("spec for 1")
          ? bug([code("off by one"), spec("needs docs")])
          : pass({ unverified: ["could not run the tests"] }),
      }),
    });
    const deps = {
      casesDir, resultsDir: join(tmp, "results"), sandbox: new FakeSandbox(), runner, scanner: cleanScanner,
      clock: new FakeClock(new Date("2026-11-07T00:00:00.000Z")), config, reviewPrompt: prompts.review,
    } as unknown as GoldenRunDeps;
    const report = await runCases(deps, { agent: "reviewer" });
    expect(report.cases).toEqual([
      { id: "1", expect: "should_flag", verdict: "bug", findings: ["off by one", "(spec) needs docs"] },
      { id: "2", expect: "should_pass", verdict: "pass", findings: [] },
    ]);
    expect(report.rates.catch_rate.value).toBe(1);
    expect(report.rates.false_alarm_rate.value).toBe(0);
    expect(JSON.parse(await readFile(report.results_file, "utf8")).cases).toHaveLength(2);
  });
});
