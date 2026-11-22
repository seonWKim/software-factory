import { existsSync, readFileSync, readdirSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { FactoryConfig } from "../src/core/config.js";
import { ControllerRole } from "../src/runtime/roles/controller-role.js";
import { type ReviewOutput, parseReviewConfirm } from "../src/core/outputs.js";
import type { Run, WorkerId, WorkItem } from "../src/core/types.js";
import { Worker } from "../src/worker/index.js";
import { type GoldenRunDeps, runCases } from "../src/golden.js";
import { ROLES_DIR, loadRoles } from "../src/runtime/index.js";
import { NoKeepAwake } from "../src/impl/awake/no-keep-awake.js";
import { FakeClock } from "../src/impl/clock/fake-clock.js";
import { PatternEgressScanner } from "../src/impl/egress/pattern-egress-scanner.js";
import { type AgentRunResult, type AgentRunSpec, SESSION_ROLES } from "../src/interfaces/agent-runner.js";
import { FakeAuth, FakeRunner, FakeSandbox, MemoryStorage } from "./helpers/fakes/runner.js";
import { FakeBroker } from "./helpers/fakes/broker.js";
import { FakeForge } from "./helpers/fakes/forge.js";
import { FakeSource } from "./helpers/fakes/source.js";
import { alice, cleanScanner, config, issueRef, prompts, silent, triageSpec } from "./helpers/fakes/config.js";
import { newStore } from "./helpers/store.js";
import { REPO } from "./architecture/lib.js";

// One confirm run per review finding (design 04-agents): a finding its confirm run does not confirm is stored
// under `unconfirmed` and sends nothing back; a confirmed finding, or one whose confirm run failed, does.

const SECRET = "hunter2-very-secret-value";

type Answer = Record<string, unknown>;
const code = (text: string) => ({ kind: "code", text });
const spec = (text: string) => ({ kind: "spec", text });
const bug = (findings: unknown[], extra: Answer = {}): Answer => ({ verdict: "bug", tier: 2, findings, summary: "found things", ...extra });
const pass = (): Answer => ({ verdict: "pass", tier: 2, findings: [], summary: "fine" });
const yes = { confirmed: true, reason: "the diff shows it" };
const no = { confirmed: false, reason: "the diff does not show it" };
type Confirm = Answer | Partial<AgentRunResult>;

/** A factory whose reviews answer from `reviews`, then pass; each confirm run answers from `confirms` in order. */
async function factory(opts: { reviews?: Answer[]; confirms?: Confirm[]; cfg?: Partial<FactoryConfig> } = {}) {
  const cfg: FactoryConfig = { ...config, ...opts.cfg };
  const clock = new FakeClock();
  const { store } = await newStore(clock);
  const source = new FakeSource();
  const sandbox = new FakeSandbox();
  sandbox.diff = "+ the reviewed change\n";
  const broker = new FakeBroker();
  const forge = new FakeForge(source, broker.calls);
  const reviews = [...(opts.reviews ?? [])];
  const confirms = [...(opts.confirms ?? [])];
  const runner = new FakeRunner({
    triage: () => ({ output: triageSpec }),
    implement: () => ({ output: { summary: "s", next_steps: "n" } }),
    review: () => ({ output: reviews.shift() ?? pass() }),
    "review-confirm": () => {
      const c = confirms.shift() ?? yes;
      return "status" in c ? (c as Partial<AgentRunResult>) : { output: c };
    },
  });
  const scanner = new PatternEgressScanner(async () => [SECRET]);
  const controller = new ControllerRole({ store, source, forge, auth: new FakeAuth(), clock, config: cfg, log: silent, scanner, repeated_failure_rule: false });
  const worker = new Worker({
    id: "w1" as WorkerId, store, sandbox, runner, broker, storage: new MemoryStorage(), clock, config: cfg,
    prompts: { ...prompts, "review-confirm": "REVIEW-CONFIRM" }, log: silent,
    scanner, toolEnv: { PATH: "/usr/bin" }, awake: new NoKeepAwake(), prRef: (pr) => forge.prRef(pr),
  });
  const step = async () => {
    await controller.tickIntake();
    while (await worker.tick()) await controller.tickRuns();
    await controller.tickRuns();
  };
  const src = issueRef(777);
  const item = async (): Promise<WorkItem> => (await store.getWorkItemBySource("github_issue", src.id))!;
  const start = async () => {
    source.queue.push({ kind: "item_requested", source: src, requester: alice, title: "t", body: "b" });
    await step();
    source.queue.push({ kind: "spec_approved", source: src, comment_id: "300", approver: alice });
    await step();
    return item();
  };
  const runs = async (kind?: Run["kind"]) => (await store.listRuns((await item()).id)).filter((r) => !kind || r.kind === kind);
  const reasons = async () => (await store.listStateChanges((await item()).id)).map((c) => c.reason);
  const stored = async (n = 0) => ((await runs("review"))[n]!.outcome as unknown as { data: { review: ReviewOutput } }).data.review;
  const confirmSpecs = () => runner.specs.filter((s) => s.role === "review-confirm");
  const reviewSpecs = () => runner.specs.filter((s) => s.role === "review");
  return { store, forge, runner, start, item, runs, reasons, stored, confirmSpecs, reviewSpecs };
}

describe("parseReviewConfirm", () => {
  it("takes confirmed (boolean) and reason (string); anything else is no valid answer", () => {
    expect(parseReviewConfirm({ confirmed: true, reason: " seen at line 3 " })).toEqual({ ok: true, value: { confirmed: true, reason: "seen at line 3" } });
    expect(parseReviewConfirm({ confirmed: false, reason: "" })).toEqual({ ok: true, value: { confirmed: false, reason: "" } });
    expect(parseReviewConfirm({ confirmed: "yes", reason: "r" }).ok).toBe(false);
    expect(parseReviewConfirm({ confirmed: true }).ok).toBe(false);
    expect(parseReviewConfirm(null).ok).toBe(false);
    expect(parseReviewConfirm("confirmed").ok).toBe(false);
  });
});

describe("review confirm runs", () => {
  it("an unconfirmed finding does not send the item back: stored under unconfirmed, verdict pass, no loop", async () => {
    const f = await factory({ reviews: [bug([code("off by one in gate")])], confirms: [no] });
    const it0 = await f.start();
    expect(it0).toMatchObject({ stage: "REVIEW", blocked_reason: "merge_pending", loop_count: 0, revision_count: 0 });
    expect(await f.runs("implement")).toHaveLength(1);
    expect(await f.reasons()).not.toContain("review_bug");
    const review = await f.stored();
    expect(review.verdict).toBe("pass");
    expect(review.findings).toEqual([]);
    expect(review.unconfirmed).toEqual([{ kind: "code", text: "off by one in gate" }]);
  });

  it("an unconfirmed spec finding starts no spec revision", async () => {
    const f = await factory({ reviews: [bug([spec("criterion 2 needs src/core/policy.ts")])], confirms: [no] });
    const it0 = await f.start();
    expect(it0).toMatchObject({ stage: "REVIEW", blocked_reason: "merge_pending", revision_count: 0, spec_feedback: null });
    expect(await f.runs("triage")).toHaveLength(1);
    expect((await f.stored()).unconfirmed).toEqual([{ kind: "spec", text: "criterion 2 needs src/core/policy.ts" }]);
  });

  it("a confirmed finding still sends the item back, as before", async () => {
    const f = await factory({ reviews: [bug([code("off by one in gate")])], confirms: [yes] });
    const it0 = await f.start();
    expect(it0.loop_count).toBe(1);
    expect(await f.reasons()).toContain("review_bug");
    expect((await f.runs("implement")).length).toBeGreaterThan(1);
    const review = await f.stored();
    expect(review.verdict).toBe("bug");
    expect(review.findings).toEqual([{ kind: "code", text: "off by one in gate" }]);
    expect(review.unconfirmed ?? []).toEqual([]);
  });

  for (const [name, answer] of [
    ["fails", { status: "failed", error: "boom" }],
    ["times out", { status: "timed_out" }],
    ["returns no valid answer", { confirmed: "maybe" }],
    ["returns no answer at all", { output: null }],
  ] as const) {
    it(`a confirm run that ${name} keeps the finding, and the item is still sent back`, async () => {
      const f = await factory({ reviews: [bug([code("off by one in gate")])], confirms: [answer as Confirm] });
      const it0 = await f.start();
      expect(it0.loop_count).toBe(1);
      expect(await f.reasons()).toContain("review_bug");
      const review = await f.stored();
      expect(review.findings).toEqual([{ kind: "code", text: "off by one in gate" }]);
      expect(review.unconfirmed ?? []).toEqual([]);
    });
  }

  it("each finding gets its own confirm run, whose prompt holds only that finding and the diff, on the review's model class", async () => {
    const f = await factory({ reviews: [bug([code("first finding"), spec("second finding")])], confirms: [no, yes] });
    const it0 = await f.start();
    const confirms = f.confirmSpecs();
    expect(confirms.map((s) => s.prompt.includes("first finding"))).toEqual([true, false]);
    expect(confirms.map((s) => s.prompt.includes("second finding"))).toEqual([false, true]);
    const review = f.reviewSpecs()[0]!;
    for (const s of confirms) {
      expect(s.prompt).toContain("+ the reviewed change");
      // No work item, spec, CI results or approver notes: only the finding and the diff.
      expect(s.prompt).not.toContain(it0.id);
      expect(s.prompt).not.toContain(triageSpec.problem);
      expect(s.system_prompt).toBe("REVIEW-CONFIRM");
      expect(s.model_class).toBe(review.model_class);
      expect(s.session).toBeUndefined();
      expect(s.tools.map((t) => t.name)).not.toContain("Edit");
      expect(s.tools.map((t) => t.name)).not.toContain("Write");
    }
    const stored = await f.stored();
    expect(stored.findings).toEqual([{ kind: "spec", text: "second finding" }]);
    expect(stored.unconfirmed).toEqual([{ kind: "code", text: "first finding" }]);
    // The confirmed spec finding revises the spec; the unconfirmed code finding is not in its feedback.
    const it1 = await f.item();
    expect(it1.revision_count).toBe(1);
    expect(it1.spec_feedback).toContain("second finding");
    expect(it1.spec_feedback).not.toContain("first finding");
  });

  it("is skipped when the review has no findings, and confirm runs are no review loops", async () => {
    const f = await factory({ reviews: [pass()] });
    const it0 = await f.start();
    expect(f.confirmSpecs()).toEqual([]);
    expect(it0.loop_count).toBe(0);
    const g = await factory({ reviews: [bug([code("a"), code("b"), code("c")])], confirms: [no, no, no] });
    const it1 = await g.start();
    expect(g.confirmSpecs().map((s) => s.prompt.match(/## Finding\n\n(.*)/)?.[1])).toEqual(["a", "b", "c"]);
    expect(it1.loop_count).toBe(0);
    expect(await g.runs("review")).toHaveLength(1);
  });

  it("all findings unconfirmed is a pass, unless built-differently code findings remain", async () => {
    const f = await factory({
      reviews: [bug([code("not real")], { built_differently: [{ line: "criterion 3", reason: "" }] })],
      confirms: [no],
    });
    const it0 = await f.start();
    // The built-differently finding is the factory's own, not the reviewer's: it gets no confirm run and stays.
    expect(f.confirmSpecs()).toHaveLength(1);
    expect(it0.loop_count).toBe(1);
    const review = await f.stored();
    expect(review.verdict).toBe("bug");
    expect(review.unconfirmed).toEqual([{ kind: "code", text: "not real" }]);
    expect(review.findings.map((x) => x.text).join("\n")).toContain("criterion 3");
  });

  it("finding text the egress scan flags is withheld before any confirm run or store", async () => {
    const f = await factory({ reviews: [bug([code(`leaks ${SECRET}`)])], confirms: [no] });
    const it0 = await f.start();
    expect(it0).toMatchObject({ blocked_on: "human", blocked_reason: "run_failed:review:egress_blocked" });
    expect(f.confirmSpecs()).toEqual([]);
    expect(JSON.stringify((await f.runs("review"))[0]!.outcome)).not.toContain(SECRET);
  });
});

describe("review-confirm role", () => {
  it("is its own role: its prompt file, read-only tools, no kept session, a golden case in its folder", async () => {
    const role = (await loadRoles()).get("review-confirm")!;
    expect(role).toMatchObject({ name: "review-confirm", prompt: "review-confirm.md" });
    expect(existsSync(join(REPO, "prompts", "review-confirm.md"))).toBe(true);
    expect(role.tools).not.toContain("Edit");
    expect(role.tools).not.toContain("Write");
    expect(role.tools).not.toContain("Bash");
    expect(SESSION_ROLES).not.toContain("review-confirm");
    const golden = join(REPO, ROLES_DIR, "review-confirm", "golden");
    expect(readdirSync(golden).some((id) => existsSync(join(golden, id, "case.json")))).toBe(true);
  });
});

describe("review prompt", () => {
  it("asks only for findings the reviewer can point to in the diff, each checked again separately", () => {
    const text = readFileSync(join(REPO, "prompts", "review.md"), "utf8");
    expect(text).toContain("Report only findings you can point to in the diff");
    expect(text).toContain("Each finding is checked again separately");
  });
});

describe("review-confirm golden replay", () => {
  it("replays its shipped cases with the confirm schema in the confirm prompt layout: a confirmed finding flags the case", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "sf-review-confirm-"));
    const runner = new FakeRunner({
      "review-confirm": (s: AgentRunSpec) => ({ output: { confirmed: s.prompt.includes("drops the last partial chunk"), reason: "r" } }),
    });
    const deps = {
      rolesDir: join(REPO, ROLES_DIR), roles: await loadRoles(), prompt: async () => "REVIEW-CONFIRM",
      resultsDir: join(tmp, "results"), sandbox: new FakeSandbox(), runner, scanner: cleanScanner,
      clock: new FakeClock(new Date("2026-11-22T00:00:00.000Z")), config,
    } as unknown as GoldenRunDeps;
    const report = await runCases(deps, { role: "review-confirm" });
    expect(report.cases.map((c) => [c.expect, c.verdict])).toEqual(report.cases.map((c) => [c.expect, c.expect === "should_flag" ? "bug" : "pass"]));
    expect(report.cases.some((c) => c.expect === "should_flag")).toBe(true);
    for (const s of runner.specs) {
      expect(s.prompt).toMatch(/^## Finding\n\n[^]*\n\n## Diff\n\n```diff\n/);
      expect(s.output_schema).toMatchObject({ required: ["confirmed", "reason"] });
      expect(s.tools.map((t) => t.name)).not.toContain("Write");
    }
  });
});
