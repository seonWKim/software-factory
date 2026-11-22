import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { REVIEW_SCHEMA, parseReview, type ReviewOutput } from "../src/core/outputs.js";
import type { WorkerId, WorkItem } from "../src/core/types.js";
import { NoKeepAwake } from "../src/impl/awake/no-keep-awake.js";
import { FakeClock } from "../src/impl/clock/fake-clock.js";
import { PatternEgressScanner } from "../src/impl/egress/pattern-egress-scanner.js";
import { ControllerRole } from "../src/runtime/roles/controller-role.js";
import { Worker, reviewComment } from "../src/worker/index.js";
import { FakeAuth, FakeRunner, FakeSandbox, MemoryStorage } from "./helpers/fakes/runner.js";
import { FakeBroker } from "./helpers/fakes/broker.js";
import { FakeForge } from "./helpers/fakes/forge.js";
import { FakeSource } from "./helpers/fakes/source.js";
import { alice, config, issueRef, prompts, runComments, silent, triageSpec } from "./helpers/fakes/config.js";
import { newStore } from "./helpers/store.js";

// Done-when lines built differently (design 04-agents, 2026-11-20): the reviewer lists each done-when line the diff
// builds differently in `built_differently`, with a reason taken from the work item. The review comment shows them
// before the tier recheck; a line with no reason is a code finding and the verdict bug.

const SECRET = "hunter2-very-secret-value";
const LINE = "every /api/usecases route is limited";
const REASON = "the owner note limits /greet and the supervision routes only";

type Answer = Record<string, unknown>;
const pass = (extra: Answer = {}): Answer => ({ verdict: "pass", tier: 2, findings: [], summary: "fine", ...extra });
const review = (extra: Partial<ReviewOutput> = {}): ReviewOutput => ({ verdict: "pass", tier: 2, findings: [], summary: "fine", ...extra });

describe("parseReview: built_differently", () => {
  it("keeps entries with a reason, trimmed, and leaves the verdict alone", () => {
    const r = parseReview(pass({ built_differently: [{ line: ` ${LINE} `, reason: ` ${REASON} ` }] }));
    expect(r).toEqual({ ok: true, value: review({ built_differently: [{ line: LINE, reason: REASON }] }) });
  });

  it("an absent or empty list parses as before: the field is left out", () => {
    expect(parseReview(pass())).toEqual({ ok: true, value: review() });
    expect(parseReview(pass({ built_differently: [] }))).toEqual({ ok: true, value: review() });
  });

  it("rejects a non-list, a non-object entry and a non-string line or reason", () => {
    const err = { ok: false, error: "built_differently" };
    expect(parseReview(pass({ built_differently: "x" }))).toEqual(err);
    expect(parseReview(pass({ built_differently: ["x"] }))).toEqual(err);
    expect(parseReview(pass({ built_differently: [{ line: 3, reason: "r" }] }))).toEqual(err);
    expect(parseReview(pass({ built_differently: [{ line: "l", reason: null }] }))).toEqual(err);
    expect(parseReview(pass({ built_differently: [{ line: "l" }] }))).toEqual(err);
  });

  it("a line with no reason from the work item is a code finding, and the verdict is bug", () => {
    const r = parseReview(pass({ built_differently: [{ line: LINE, reason: "  " }, { line: "other", reason: "decision 2" }] }));
    expect(r.ok).toBe(true);
    const v = (r as { value: ReviewOutput }).value;
    expect(v.verdict).toBe("bug");
    expect(v.findings).toEqual([{ kind: "code", text: `built differently from the spec with no reason in the work item: ${LINE}` }]);
    expect(v.built_differently).toEqual([{ line: "other", reason: "decision 2" }]);
    expect(reviewComment(v)).toMatch(/^## Factory review: changes needed\n/);
  });

  it("the schema offers an optional list of { line, reason } strings", () => {
    expect(REVIEW_SCHEMA.required).not.toContain("built_differently");
    expect(REVIEW_SCHEMA.properties).toHaveProperty("built_differently.type", "array");
    expect(REVIEW_SCHEMA.properties).toHaveProperty("built_differently.items.required", ["line", "reason"]);
    expect(REVIEW_SCHEMA.properties).toHaveProperty("built_differently.items.properties.line.type", "string");
    expect(REVIEW_SCHEMA.properties).toHaveProperty("built_differently.items.properties.reason.type", "string");
  });
});

describe("reviewComment: built differently from the spec", () => {
  it("lists each entry under its heading, before Tier recheck and after Not verified", () => {
    const body = reviewComment(review({ unverified: ["could not run npm test"], built_differently: [{ line: LINE, reason: REASON }, { line: "b", reason: "c" }] }));
    const section = `### Built differently from the spec\n\n- built differently from the spec: ${LINE} — because ${REASON}\n- built differently from the spec: b — because c`;
    expect(body).toContain(section);
    expect(body.indexOf("### Not verified")).toBeLessThan(body.indexOf(section));
    expect(body.indexOf(section)).toBeLessThan(body.indexOf("Tier recheck: 2"));
  });

  it("entries with reasons keep the verdict and header", () => {
    expect(reviewComment(review({ built_differently: [{ line: LINE, reason: REASON }] }))).toMatch(/^## Factory review: pass\n/);
    const ui = reviewComment(review({ ui_unverified: true, built_differently: [{ line: LINE, reason: REASON }] }));
    expect(ui).toMatch(/^## Factory review: needs a human look\n/);
  });

  it("a review stored before the field renders as before", () => {
    const old = parseReview({ verdict: "pass", tier: 3, findings: [], summary: "s" });
    expect(old).toEqual({ ok: true, value: { verdict: "pass", tier: 3, findings: [], summary: "s" } });
    const body = reviewComment((old as { value: ReviewOutput }).value);
    expect(body).toBe("## Factory review: pass\n\ns\n\nTier recheck: 3");
  });
});

describe("prompts/review.md: done-when lines built differently", () => {
  const text = readFileSync("prompts/review.md", "utf8");
  const flat = text.replace(/\s+/g, " ");

  it("compares each done-when line with the diff and lists differences with a reason from the work item only", () => {
    expect(flat).toMatch(/Compare each done-when line with the diff/);
    expect(flat).toMatch(/`built_differently`/);
    expect(flat).toMatch(/reason taken only from the work item/);
    expect(flat).toMatch(/never the implementer's/);
  });

  it("makes a line built differently with no reason in the work item a code finding and the verdict bug", () => {
    expect(flat).toMatch(/no reason in the work item[^.]*finding of kind `code`[^.]*verdict is "bug"/);
    expect(text.slice(text.indexOf("Output:"))).toMatch(/^- built_differently: /m);
  });
});

/** A factory whose reviews answer from `reviews` in order, then pass; the egress scanner flags `SECRET`. */
async function factory(reviews: Answer[]) {
  const clock = new FakeClock();
  const { store } = await newStore(clock);
  const source = new FakeSource();
  const broker = new FakeBroker();
  const forge = new FakeForge(source, broker.calls);
  const queue = [...reviews];
  const runner = new FakeRunner({
    triage: () => ({ output: triageSpec }),
    implement: () => ({ output: { summary: "s", next_steps: "n" } }),
    review: () => ({ output: queue.shift() ?? pass() }),
  });
  const scanner = new PatternEgressScanner(async () => [SECRET]);
  const controller = new ControllerRole({ store, source, forge, auth: new FakeAuth(), clock, config, log: silent, scanner, repeated_failure_rule: false });
  const worker = new Worker({
    id: "w1" as WorkerId, store, sandbox: new FakeSandbox(), runner, broker, storage: new MemoryStorage(), clock, config, prompts, log: silent,
    scanner, toolEnv: { PATH: "/usr/bin" }, awake: new NoKeepAwake(), prRef: (pr) => forge.prRef(pr),
  });
  const step = async () => {
    await controller.tickIntake();
    while (await worker.tick()) await controller.tickRuns();
    await controller.tickRuns();
  };
  const src = issueRef(530);
  const item = async (): Promise<WorkItem> => (await store.getWorkItemBySource("github_issue", src.id))!;
  const start = async () => {
    source.queue.push({ kind: "item_requested", source: src, requester: alice, title: "t", body: "b" });
    await step();
    source.queue.push({ kind: "spec_approved", source: src, comment_id: "300", approver: alice });
    await step();
    return item();
  };
  const reviewRuns = async () => (await store.listRuns((await item()).id)).filter((r) => r.kind === "review");
  const reviewComments = async () => (await runComments(store, (await item()).id)).filter((c) => c.pr).map((c) => c.body);
  return { source, start, reviewRuns, reviewComments };
}

describe("review run: built_differently is stored, posted and scanned", () => {
  it("stores the entries with the outcome and posts them before the tier recheck", async () => {
    const f = await factory([pass({ built_differently: [{ line: LINE, reason: REASON }] })]);
    await f.start();
    const stored = ((await f.reviewRuns())[0]!.outcome as unknown as { data: { review: ReviewOutput } }).data.review;
    expect(stored.built_differently).toEqual([{ line: LINE, reason: REASON }]);
    const body = (await f.reviewComments())[0]!;
    expect(body).toMatch(/^## Factory review: pass/);
    expect(body).toContain(`- built differently from the spec: ${LINE} — because ${REASON}\n\nTier recheck: 2`);
  });

  for (const [what, entry] of [["line", { line: `leaks ${SECRET}`, reason: REASON }], ["reason", { line: LINE, reason: `leaks ${SECRET}` }]] as const) {
    it(`a ${what} the egress scan flags stores nothing and posts no review`, async () => {
      const f = await factory([pass({ built_differently: [entry] })]);
      const it0 = await f.start();
      expect(it0).toMatchObject({ blocked_on: "human", blocked_reason: "run_failed:review:egress_blocked" });
      expect(JSON.stringify((await f.reviewRuns())[0]!.outcome)).not.toContain(SECRET);
      expect(await f.reviewComments()).toEqual([]);
      const leak = f.source.comments.filter((c) => c.marker.includes("leak-blocked"));
      expect(leak).toHaveLength(1);
      expect(leak[0]!.body).not.toContain(SECRET);
    });
  }
});
