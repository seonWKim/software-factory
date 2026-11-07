import { mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FileSessionFiles, githubIssues, parseSessionArgs, runSession } from "../src/session-cmd.js";
import type { FactoryConfig } from "../src/core/config.js";
import { Controller } from "../src/core/controller.js";
import { SESSION_RELEASED } from "../src/core/policy.js";
import { Sessions, parseTarget } from "../src/core/session.js";
import type { Run, Tier, UserId, WorkItem, WorkItemId, WorkerId } from "../src/core/types.js";
import type { EgressScanner } from "../src/interfaces/egress-scanner.js";
import { FakeClock } from "../src/impl/clock/fake-clock.js";
import {
  FakeAuth, FakeBroker, FakeIssues, FakeSandbox, FakeSource, MemorySessionFiles, alice, cleanScanner, config, issueRef, mallory, silent,
  waitFor,
} from "./helpers/fakes.js";
import { issue, newStore, system } from "./helpers/store.js";

// `factory session` (design §5, 2026-11-01): a person's own LLM session as one `interactive` run, on fakes. The
// sandbox, broker, auth and issue lookup are fakes; the store is the real SQLite store; the controller is real.

/** The owner's spec file, in the triage output format. */
const SPEC = {
  in_short: "AS-IS: nothing.\nTO-BE: something.",
  problem: "Fix the widget",
  done_criteria: ["the widget works"],
  desired_output: "a PR",
  scope: "the widget only",
  allowed_paths: ["src/a/"],
  files_to_change: ["src/a/x.ts"],
  tier: 2,
  tier_reason: "small",
  estimated_lines: 20,
  estimated_files: 1,
};
const SPEC_TEXT = JSON.stringify(SPEC);
/** An access-key-shaped string the leak scanner flags, built here so no such literal sits in the repository. */
const AWS_SHAPED = ["AKIA", "ABCDEFGHIJKLMNOP"].join("");

async function harness(opts: { scanner?: EgressScanner; config?: Partial<FactoryConfig> } = {}) {
  const clock = new FakeClock();
  const { store } = await newStore(clock);
  const cfg: FactoryConfig = { ...config, ...opts.config };
  const sandbox = new FakeSandbox();
  sandbox.changedFiles = ["src/a/x.ts"];
  const broker = new FakeBroker();
  const files = new MemorySessionFiles();
  const issues = new FakeIssues({ 7: { source: issueRef(7), title: "Session issue", body: "the body", author: mallory } });
  const scanner = opts.scanner ?? cleanScanner;
  const sessions = new Sessions({
    store, sandbox, broker, scanner, auth: new FakeAuth(), clock, config: cfg, log: silent, files, issues, toolEnv: {},
    owner: "session:host:1",
  });
  const controller = new Controller({ store, source: new FakeSource(), auth: new FakeAuth(), clock, config: cfg, log: silent, scanner });

  /** A RUNNING item with an approved spec on `paths` and no run, as after `/approve` once its run ended. */
  const running = async (n: number, paths: string[] = ["src/a/"], tier: Tier = 2, extra: Partial<WorkItem> = {}): Promise<WorkItem> => {
    const { item } = await store.createWorkItem({ ...issue(n), title: `Item ${n}` }, system);
    const r = await store.transition({
      id: item.id, expected_version: item.version, actor: system, reason: "spec_approved",
      patch: { stage: "RUNNING", allowed_paths: paths, tier, done_criteria: ["x"], ...extra },
    });
    if (!r.ok) throw new Error(r.reason);
    return r.item;
  };
  const snapshot = async (id: WorkItemId) =>
    JSON.stringify({ item: await store.getWorkItem(id), runs: await store.listRuns(id), changes: await store.listStateChanges(id) });
  const item = async (id: WorkItemId) => (await store.getWorkItem(id))!;
  const runs = async (id: WorkItemId, kind?: Run["kind"]) => (await store.listRuns(id)).filter((r) => !kind || r.kind === kind);
  const start = (target: string, extra: { spec?: string; transcript?: string } = {}) =>
    sessions.start({ target, person: alice, ...extra });
  return { clock, store, cfg, sandbox, broker, files, issues, sessions, controller, running, snapshot, item, runs, start };
}

describe("session start", () => {
  it("creates the work item when the issue has none, and uses the existing one otherwise", async () => {
    const h = await harness();
    const r = await h.start("7", { spec: SPEC_TEXT });
    expect(r.ok).toBe(true);
    const created = (await h.store.getWorkItemBySource("github_issue", issueRef(7).id))!;
    expect(created.title).toBe("Session issue");
    expect(created.requester_id).toBe("github:666"); // the issue's author, as intake records it
    expect(h.issues.asked).toEqual([7]);
    expect(r.lines.join("\n")).toContain(`created work item ${created.id}`);

    const existing = await h.running(8, ["src/b/"]); // not src/a/: that overlaps the open session on #7
    const again = await h.start("#8");
    expect(again.ok).toBe(true);
    expect(h.issues.asked).toEqual([7]); // not asked: the item exists
    expect((await h.runs(existing.id, "interactive")).length).toBe(1);
    expect(again.lines.join("\n")).not.toContain("created work item");
  });

  it("stores one interactive run, running with a lease, with the person's user ID as its actor", async () => {
    const h = await harness();
    const it0 = await h.running(1);
    const r = await h.start(it0.id);
    expect(r.ok).toBe(true);
    const [run, ...rest] = await h.runs(it0.id);
    expect(rest).toEqual([]);
    expect(run).toMatchObject({ kind: "interactive", status: "running", attempt: 1, actor_id: "github:1" });
    expect(run!.lease).toMatchObject({ owner: "session:host:1", token: 1 });
    const change = (await h.store.listStateChanges(it0.id)).at(-1)!;
    expect(change.reason).toBe("session_started");
    expect(change.actor).toEqual({ kind: "user", id: "github:1" });
    expect(change.detail).toMatchObject({ run_id: run!.id, spec_source: "triage" });
    expect(r.file).toMatchObject({ work_item_id: it0.id, run_id: run!.id, token: 1 });
  });

  it("creates the run folder through Sandbox.create on the item's branch and prints its path", async () => {
    const h = await harness();
    const it0 = await h.running(1);
    const r = await h.start(it0.id);
    expect(h.sandbox.created).toEqual([{ repo: "/repo", branch: `factory/${it0.id}`, base_ref: "main" }]);
    expect(r.lines).toContain("run folder: /wt/1");
    expect(r.lines).toContain(`branch: factory/${it0.id}`);
  });

  describe("is refused with nothing changed", () => {
    const refusedUnchanged = async (h: Awaited<ReturnType<typeof harness>>, id: WorkItemId, target: string = id, extra = {}) => {
      const before = await h.snapshot(id);
      const r = await h.start(target, extra);
      expect(r.ok).toBe(false);
      expect(await h.snapshot(id)).toBe(before);
      expect(h.sandbox.created).toEqual([]);
      expect(h.files.files.size).toBe(0);
      return r.lines.join("\n");
    };

    it("for a CLOSED item", async () => {
      const h = await harness();
      const it0 = await h.running(1, ["src/a/"], 2, { stage: "CLOSED", close_reason: "wont_do" });
      expect(await refusedUnchanged(h, it0.id)).toMatch(/closed/);
    });

    it("for an item in REVIEW", async () => {
      const h = await harness();
      const it0 = await h.running(1, ["src/a/"], 2, { stage: "REVIEW", pr_number: 5 });
      expect(await refusedUnchanged(h, it0.id)).toMatch(/in review \(PR #5\)/);
    });

    it("for an item with a queued or running implement-type run", async () => {
      const h = await harness();
      const it0 = await h.running(1);
      await h.store.transition({ id: it0.id, expected_version: it0.version, actor: system, reason: "x", patch: {}, enqueue: { kind: "implement", idempotency_key: "i1" } });
      expect(await refusedUnchanged(h, it0.id)).toMatch(/queued implement run/);
      await h.store.claimRun({ worker_id: "w1" as WorkerId, kinds: ["implement"], lease_ms: 60_000 });
      expect(await refusedUnchanged(h, it0.id)).toMatch(/running implement run/);
      const it1 = await h.running(2, ["src/b/"]);
      await h.store.transition({ id: it1.id, expected_version: it1.version, actor: system, reason: "x", patch: {}, enqueue: { kind: "update", idempotency_key: "u1" } });
      expect(await refusedUnchanged(h, it1.id)).toMatch(/queued update run/);
    });

    it("for an item that already has an open session", async () => {
      const h = await harness();
      const it0 = await h.running(1);
      expect((await h.start(it0.id)).ok).toBe(true);
      const before = await h.snapshot(it0.id);
      const created = h.sandbox.created.length;
      const r = await h.start(it0.id);
      expect(r.ok).toBe(false);
      expect(r.lines.join("\n")).toMatch(/already has an open session/);
      expect(await h.snapshot(it0.id)).toBe(before);
      expect(h.sandbox.created.length).toBe(created);
    });

    it("when a running implement-type run of another item has overlapping allowed_paths", async () => {
      const h = await harness();
      const other = await h.running(2, ["src/a/x.ts"]);
      await h.store.transition({ id: other.id, expected_version: other.version, actor: system, reason: "x", patch: {}, enqueue: { kind: "implement", idempotency_key: "i2" } });
      await h.store.claimRun({ worker_id: "w1" as WorkerId, kinds: ["implement"], lease_ms: 60_000 });
      const it0 = await h.running(1, ["src/a/"]);
      const before = await h.snapshot(it0.id);
      const r = await h.start(it0.id);
      expect(r.ok).toBe(false);
      expect(r.lines.join("\n")).toMatch(/o\/r#2 .* overlaps the allowed_paths: src\/a\/x\.ts/);
      expect(await h.snapshot(it0.id)).toBe(before);
      // The folder made before the store's check is removed again.
      expect(h.sandbox.destroyed).toBe(1);
      expect(h.files.files.size).toBe(0);
      // No overlap: it starts.
      const free = await h.running(3, ["src/c/"]);
      expect((await h.start(free.id)).ok).toBe(true);
    });

    it("for an item with no allowed_paths", async () => {
      const h = await harness();
      const it0 = await h.running(1, []);
      expect(await refusedUnchanged(h, it0.id)).toMatch(/no allowed_paths/);
    });

    it("with an invalid --spec file, validated by the triage parser", async () => {
      const h = await harness();
      const { item: it0 } = await h.store.createWorkItem(issue(1), system, { enqueue: { kind: "triage", idempotency_key: "t1" } });
      expect(await refusedUnchanged(h, it0.id, it0.id, { spec: "not json" })).toMatch(/not JSON/);
      expect(await refusedUnchanged(h, it0.id, it0.id, { spec: JSON.stringify({ ...SPEC, allowed_paths: [] }) })).toMatch(/not a valid spec: allowed_paths/);
      expect(await refusedUnchanged(h, it0.id, it0.id, { spec: JSON.stringify({ ...SPEC, files_to_change: ["src/b/y.ts"] }) })).toMatch(/not covered/);
      // An issue with no item: nothing is created either.
      const r = await h.start("7", { spec: "{}" });
      expect(r.ok).toBe(false);
      expect(await h.store.getWorkItemBySource("github_issue", issueRef(7).id)).toBeNull();
    });

    it("on a READY item waiting for spec approval, naming /approve", async () => {
      const h = await harness();
      const it0 = await h.running(1, ["src/a/"], 2, { stage: "READY", blocked_on: "human", blocked_reason: "spec_pending" });
      expect(await refusedUnchanged(h, it0.id)).toContain("`/approve`");
    });

    it("for a person without write permission", async () => {
      const h = await harness();
      const it0 = await h.running(1);
      const before = await h.snapshot(it0.id);
      const r = await h.sessions.start({ target: it0.id, person: mallory });
      expect(r.ok).toBe(false);
      expect(r.lines.join("\n")).toMatch(/write permission/);
      expect(await h.snapshot(it0.id)).toBe(before);
    });
  });

  it("on a NEW item cancels its queued triage run and records the spec source on the state change", async () => {
    const h = await harness();
    const { item: it0 } = await h.store.createWorkItem(issue(1), system, { enqueue: { kind: "triage", idempotency_key: "t1" } });
    const r = await h.start(it0.id, { spec: SPEC_TEXT });
    expect(r.ok).toBe(true);
    const triage = (await h.runs(it0.id, "triage"))[0]!;
    expect(triage.status).toBe("cancelled");
    const after = await h.item(it0.id);
    expect(after).toMatchObject({ stage: "RUNNING", blocked_on: "none", allowed_paths: ["src/a/"], done_criteria: ["the widget works"], tier: 2 });
    const change = (await h.store.listStateChanges(it0.id)).at(-1)!;
    expect(change.detail).toMatchObject({ spec_source: "owner" });
    // The cancelled triage run is acknowledged as ignored; the item stays as the session left it.
    await h.controller.tickRuns();
    expect((await h.store.getRun(triage.id))!.acknowledged_at).not.toBeNull();
    expect((await h.item(it0.id)).stage).toBe("RUNNING");
    // A later session on the same item says the spec is the owner's.
    await h.sessions.abandon({ id: it0.id });
    await h.controller.tickRuns();
    await h.start(it0.id);
    expect((await h.store.listStateChanges(it0.id)).at(-1)!.detail).toMatchObject({ spec_source: "owner" });
  });

  it("parses issue numbers and work item ids", () => {
    expect(parseTarget("12")).toEqual({ kind: "issue", number: 12 });
    expect(parseTarget("#12")).toEqual({ kind: "issue", number: 12 });
    expect(parseTarget("wi_abc123")).toEqual({ kind: "item", id: "wi_abc123" });
    expect(parseTarget("foo")).toBeNull();
  });
});

describe("claims around a session", () => {
  it("a worker never claims a queued implement-type run whose item overlaps an open session", async () => {
    const h = await harness();
    const it0 = await h.running(1, ["src/a/"]);
    expect((await h.start(it0.id)).ok).toBe(true);
    const overlapping = await h.running(2, ["src/a/y.ts"]);
    await h.store.transition({ id: overlapping.id, expected_version: overlapping.version, actor: system, reason: "x", patch: {}, enqueue: { kind: "implement", idempotency_key: "i2" } });
    const claim = () => h.store.claimRun({ worker_id: "w1" as WorkerId, kinds: ["implement", "update"], lease_ms: 60_000 });
    expect(await claim()).toBeNull();
    // A run that does not overlap is claimed as usual.
    const free = await h.running(3, ["src/b/"]);
    await h.store.transition({ id: free.id, expected_version: free.version, actor: system, reason: "x", patch: {}, enqueue: { kind: "implement", idempotency_key: "i3" } });
    expect((await claim())?.work_item_id).toBe(free.id);
    // The session ends: the held run is claimed next.
    await h.sessions.abandon({ id: it0.id });
    expect((await claim())?.work_item_id).toBe(overlapping.id);
  });

  it("workers never claim an interactive run", async () => {
    const h = await harness();
    const it0 = await h.running(1);
    await h.start(it0.id);
    const all = ["triage", "implement", "review", "update", "resolve", "interactive"] as const;
    expect(await h.store.claimRun({ worker_id: "w1" as WorkerId, kinds: all, lease_ms: 60_000 })).toBeNull();
    expect(await h.store.claimRun({ worker_id: "w1" as WorkerId, kinds: ["interactive"], lease_ms: 60_000 })).toBeNull();
    const [run] = await h.runs(it0.id, "interactive");
    expect(run!.lease!.owner).toBe("session:host:1");
    // `workers pause` pauses workers, never a person's session.
    expect((await h.store.pauseWorkers({ count: 5 }, "github:1")).paused).toEqual([]);
  });
});

describe("session note and status", () => {
  it("stores a note after the egress scan; a flagged note is refused with the rule name and nothing is stored", async () => {
    const h = await harness();
    const it0 = await h.running(1);
    await h.start(it0.id);
    expect((await h.sessions.note({ text: "tried the parser first" })).ok).toBe(true);
    const flagged = await h.sessions.note({ text: `key ${AWS_SHAPED} leaked` });
    expect(flagged.ok).toBe(false);
    expect(flagged.lines.join("\n")).toContain("aws_access_key");
    const [run] = await h.runs(it0.id, "interactive");
    expect(run!.session_notes.map((n) => n.text)).toEqual(["tried the parser first"]);
  });

  it("prints the item, the run, the lease expiry and the result of the last finish attempt", async () => {
    const h = await harness();
    const it0 = await h.running(1);
    await h.start(it0.id);
    let lines = (await h.sessions.status()).lines.join("\n");
    const [run] = await h.runs(it0.id, "interactive");
    expect(lines).toContain(`item: ${it0.id} (o/r#1) RUNNING`);
    expect(lines).toContain(`run: ${run!.id} running, actor github:1`);
    expect(lines).toContain(`lease: expires ${run!.lease!.expires_at}`);
    expect(lines).toContain("last finish: none yet");
    h.sandbox.exits["npm test"] = 1;
    await h.sessions.finish({});
    lines = (await h.sessions.status(it0.id)).lines.join("\n");
    expect(lines).toMatch(/last finish: \S+ refused: tests: `npm test` exited 1/);
  });

  it("--transcript on start and note stores an http or https URL after the egress scan", async () => {
    const h = await harness();
    const it0 = await h.running(1);
    const bad = await h.start(it0.id, { transcript: "ftp://example.com/t" });
    expect(bad.ok).toBe(false);
    expect((await h.start(it0.id, { transcript: "https://example.com/t/1" })).ok).toBe(true);
    expect((await h.runs(it0.id, "interactive"))[0]!.transcript_url).toBe("https://example.com/t/1");
    expect((await h.sessions.note({ transcript: "http://example.com/t/2" })).ok).toBe(true);
    expect((await h.runs(it0.id, "interactive"))[0]!.transcript_url).toBe("http://example.com/t/2");
    const flagged = await h.sessions.note({ transcript: `https://example.com/?k=${AWS_SHAPED}` });
    expect(flagged.ok).toBe(false);
    expect(flagged.lines.join("\n")).toContain("aws_access_key");
    expect((await h.runs(it0.id, "interactive"))[0]!.transcript_url).toBe("http://example.com/t/2");
    expect((await h.sessions.note({ transcript: "javascript:alert(1)" })).ok).toBe(false);
  });
});

describe("session finish", () => {
  const started = async (paths: string[] = ["src/a/"], tier: Tier = 2) => {
    const h = await harness();
    const it0 = await h.running(1, paths, tier);
    expect((await h.start(it0.id)).ok).toBe(true);
    return { ...h, it0 };
  };
  const refusedOpen = async (h: Awaited<ReturnType<typeof started>>) => {
    const r = await h.sessions.finish({});
    expect(r.ok).toBe(false);
    expect(h.broker.calls).toEqual([]); // nothing pushed, no PR
    const [run] = await h.runs(h.it0.id, "interactive");
    expect(run!.status).toBe("running"); // the session stays open
    expect(h.files.files.has(h.it0.id)).toBe(true);
    expect(run!.last_finish).toMatchObject({ ok: false });
    return r.lines.join("\n");
  };

  it("runs the scope gate, the size gate, the floor check and the test command, in that order", async () => {
    const h = await started();
    const r = await h.sessions.finish({});
    expect(r.ok).toBe(true);
    const scope = h.sandbox.gitCalls.findIndex((c) => c.startsWith("diff --name-only -z --no-renames basesha...HEAD"));
    const size = h.sandbox.gitCalls.findIndex((c) => c.startsWith("diff --numstat -z -M basesha...HEAD"));
    expect(scope).toBeGreaterThanOrEqual(0);
    expect(size).toBeGreaterThan(scope);
    expect(h.sandbox.commands).toEqual(["npm test"]);
  });

  it("the scope gate refuses files outside allowed_paths", async () => {
    const h = await started();
    h.sandbox.changedFiles = ["src/a/x.ts", "README.md"];
    expect(await refusedOpen(h)).toMatch(/scope: files outside allowed_paths: README\.md/);
    expect(h.sandbox.commands).toEqual([]); // the test command is not run after a failed gate
  });

  it("the size gate refuses a diff over the configured limits, which are unchanged", async () => {
    const h = await started();
    h.sandbox.numstat = "1501\t0\tsrc/a/x.ts\0";
    expect(await refusedOpen(h)).toContain("size: the diff changes 1501 lines (limit max_diff_lines = 1500) in 1 files (limit max_diff_files = 40)");
  });

  it("a floor hit is refused with the paths and the required tier; the session stays open and no floor_blocked is written", async () => {
    const h = await started(["src/"], 2);
    h.sandbox.changedFiles = ["src/impl/broker/x.ts"];
    expect(await refusedOpen(h)).toContain("floor: src/impl/broker/x.ts need tier 4 (the item is tier 2)");
    const reasons = (await h.store.listStateChanges(h.it0.id)).map((c) => c.reason);
    expect(reasons).not.toContain("floor_blocked");
    expect(await h.item(h.it0.id)).toMatchObject({ stage: "RUNNING", blocked_on: "none", tier: 2 });
  });

  it("the test command refuses when it fails", async () => {
    const h = await started();
    h.sandbox.exits["npm test"] = 1;
    expect(await refusedOpen(h)).toContain("tests: `npm test` exited 1");
  });

  it("a failed finish lists every reason it found", async () => {
    const h = await started();
    h.sandbox.changedFiles = ["src/a/x.ts", "README.md"];
    h.sandbox.numstat = "3000\t0\tREADME.md\0";
    h.sandbox.status = " M src/a/x.ts\0";
    const text = await refusedOpen(h);
    expect(text).toMatch(/uncommitted changes/);
    expect(text).toMatch(/scope:/);
    expect(text).toMatch(/size:/);
    expect(text).toMatch(/not run \(an earlier gate failed\)/);
  });

  it("pushes and opens the PR only through the broker; the controller moves the item to REVIEW and queues a review run", async () => {
    const h = await started();
    await h.sessions.note({ text: "split the parser", tokens: 120 });
    const r = await h.sessions.finish({ tokens: 300 });
    expect(r.ok).toBe(true);
    expect(h.broker.calls.map((c) => c.name)).toEqual(["github.push_branch", "github.open_pr"]);
    const [run] = await h.runs(h.it0.id, "interactive");
    expect(h.broker.calls[0]!.ctx).toEqual({ run_id: run!.id, work_item_id: h.it0.id, lease_token: 1 });
    expect(h.broker.calls[0]!.args).toEqual({ workdir: "/wt/1", branch: `factory/${h.it0.id}`, base_ref: "main" });
    expect((h.broker.calls[1]!.args as { body: string }).body).toContain("split the parser");
    expect((h.broker.calls[1]!.args as { body: string }).body).toContain("Closes #1");
    // The session runs no git push of its own.
    expect(h.sandbox.gitCalls.some((c) => /(^| )push( |$)/.test(c))).toBe(false);
    expect(run!.status).toBe("succeeded");
    expect(h.files.files.size).toBe(0);

    await h.controller.tickRuns();
    const after = await h.item(h.it0.id);
    expect(after).toMatchObject({ stage: "REVIEW", pr_number: 42, token_cost: 300, pr_files: ["src/a/x.ts"] });
    const reviews = await h.runs(h.it0.id, "review");
    expect(reviews.map((x) => x.status)).toEqual(["queued"]);
    expect((await h.store.listStateChanges(h.it0.id)).at(-1)).toMatchObject({ reason: "session_finished" });
    // Applied once: a second tick adds no tokens and queues nothing.
    await h.controller.tickRuns();
    expect((await h.item(h.it0.id)).token_cost).toBe(300);
    expect((await h.runs(h.it0.id, "review")).length).toBe(1);
  });

  it("running finish again after a success creates no second PR and no second review run", async () => {
    const h = await started();
    expect((await h.sessions.finish({})).ok).toBe(true);
    await h.controller.tickRuns();
    const again = await h.sessions.finish({ id: h.it0.id });
    expect(again.ok).toBe(false);
    // The local record is still there when a crash came between completion and its removal.
    const [run] = await h.runs(h.it0.id, "interactive");
    await h.files.write({ work_item_id: h.it0.id, run_id: run!.id, token: 1, branch: "b", folder: { id: "sbx1", workdir: "/wt/1", base_sha: "basesha" } });
    expect((await h.sessions.finish({})).ok).toBe(false);
    await h.controller.tickRuns();
    expect(h.broker.calls.filter((c) => c.name === "github.open_pr").length).toBe(1);
    expect((await h.runs(h.it0.id, "review")).length).toBe(1);
  });

  it("running finish again after a failed push pushes once more, and still gives one PR and one review run", async () => {
    const h = await started();
    h.broker.responses["github.push_branch"] = [{ ok: false, error_code: "push_failed", message: "rejected" }];
    const first = await h.sessions.finish({});
    expect(first.ok).toBe(false);
    expect(first.lines.join("\n")).toContain("push: push_failed: rejected");
    expect((await h.runs(h.it0.id, "interactive"))[0]!.status).toBe("running");
    await h.controller.tickRuns();
    expect((await h.item(h.it0.id)).stage).toBe("RUNNING");
    expect((await h.sessions.finish({})).ok).toBe(true);
    await h.controller.tickRuns();
    expect((await h.sessions.finish({})).ok).toBe(false);
    await h.controller.tickRuns();
    expect(h.broker.calls.filter((c) => c.name === "github.open_pr").length).toBe(1);
    expect((await h.runs(h.it0.id, "review")).length).toBe(1);
    expect((await h.item(h.it0.id)).stage).toBe("REVIEW");
  });
});

describe("session end without a PR", () => {
  it("abandon ends the run as failed `abandoned`, keeps the remote branch, and the controller releases the item", async () => {
    const h = await harness();
    const it0 = await h.running(1);
    await h.start(it0.id);
    // A finish that pushed but could not open the PR: the branch is on the fake forge.
    h.broker.responses["github.open_pr"] = [{ ok: false, error_code: "pr_failed", message: "no" }];
    expect((await h.sessions.finish({})).ok).toBe(false);
    const branch = `factory/${it0.id}`;
    expect(h.broker.remote.has(branch)).toBe(true);

    const r = await h.sessions.abandon({ tokens: 40 });
    expect(r.ok).toBe(true);
    const [run] = await h.runs(it0.id, "interactive");
    expect(run!.status).toBe("failed");
    expect(run!.outcome).toMatchObject({ status: "failed", error_code: "abandoned" });
    expect(h.broker.remote.has(branch)).toBe(true);
    expect(h.sandbox.destroyed).toBe(0); // the run folder is kept too

    await h.controller.tickRuns();
    const after = await h.item(it0.id);
    expect(after).toMatchObject({ stage: "RUNNING", blocked_on: "human", blocked_reason: SESSION_RELEASED, token_cost: 40 });
    expect((await h.runs(it0.id)).filter((x) => x.status === "queued")).toEqual([]);
    expect(h.broker.remote.has(branch)).toBe(true);
  });

  it("an expired session lease is ended by the reaper as `session_lost`, never requeued, and the controller releases the item", async () => {
    const h = await harness();
    const it0 = await h.running(1);
    const started = await h.start(it0.id);
    await h.sessions.note({ tokens: 75 });
    // Ctrl-C on `session start`: no heartbeat; the lease runs out.
    h.clock.advance(h.cfg.lease_ms + 1);
    await h.controller.tickReaper();
    const [run] = await h.runs(it0.id, "interactive");
    expect(run).toMatchObject({ status: "failed", attempt: 1, lease: null });
    expect(run!.outcome).toMatchObject({ status: "failed", error_code: "session_lost" });
    await h.controller.tickRuns();
    expect(await h.item(it0.id)).toMatchObject({ stage: "RUNNING", blocked_on: "human", blocked_reason: SESSION_RELEASED, token_cost: 75 });
    expect((await h.runs(it0.id)).filter((x) => x.status === "queued" || x.status === "running")).toEqual([]);
    // A heartbeat from the stopped terminal is refused; the local record goes.
    const ac = new AbortController();
    const beat = h.sessions.heartbeat(started.file!, ac.signal);
    h.clock.advance(h.cfg.heartbeat_ms);
    expect(await beat).toBe("ended");
    expect(h.files.files.size).toBe(0);
  });

  it("the heartbeat keeps the lease while start runs, and stops on Ctrl-C without ending the run", async () => {
    const h = await harness();
    const it0 = await h.running(1);
    const started = await h.start(it0.id);
    const first = (await h.runs(it0.id, "interactive"))[0]!.lease!.expires_at;
    const ac = new AbortController();
    const beat = h.sessions.heartbeat(started.file!, ac.signal);
    h.clock.advance(h.cfg.heartbeat_ms);
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    const renewed = (await h.runs(it0.id, "interactive"))[0]!.lease!.expires_at;
    expect(renewed > first).toBe(true);
    ac.abort();
    expect(await beat).toBe("stopped");
    expect((await h.runs(it0.id, "interactive"))[0]!.status).toBe("running");
  });

  it("a released item is RUNNING, blocked on a human with session_released and no run queued; the next start succeeds", async () => {
    const h = await harness();
    const it0 = await h.running(1);
    await h.start(it0.id);
    await h.sessions.abandon({});
    await h.controller.tickRuns();
    const released = await h.item(it0.id);
    expect(released).toMatchObject({ stage: "RUNNING", blocked_on: "human", blocked_reason: "session_released" });
    expect((await h.runs(it0.id)).filter((x) => x.status === "queued")).toEqual([]);
    const again = await h.start(it0.id);
    expect(again.ok).toBe(true);
    expect(await h.item(it0.id)).toMatchObject({ stage: "RUNNING", blocked_on: "none", blocked_reason: null });
    expect((await h.runs(it0.id, "interactive")).map((x) => x.status)).toEqual(["failed", "running"]);
  });

  it("--tokens takes a whole number of 0 or more; the latest total is added to token_cost once, when the run ends", async () => {
    const h = await harness();
    const it0 = await h.running(1);
    await h.start(it0.id);
    expect((await h.sessions.note({ tokens: -1 })).ok).toBe(false);
    expect((await h.sessions.note({ tokens: 1.5 })).ok).toBe(false);
    expect((await h.sessions.note({ tokens: 0 })).ok).toBe(true);
    expect((await h.sessions.note({ tokens: 500 })).ok).toBe(true);
    expect((await h.item(it0.id)).token_cost).toBe(0); // not before the run ends
    expect((await h.sessions.abandon({ tokens: 900 })).ok).toBe(true);
    await h.controller.tickRuns();
    await h.controller.tickRuns();
    expect((await h.item(it0.id)).token_cost).toBe(900);
  });
});

describe("session flow", () => {
  it("start, finish: REVIEW with a review run queued, the PR from the broker", async () => {
    const h = await harness();
    const r = await h.start("7", { spec: SPEC_TEXT, transcript: "https://example.com/t" });
    expect(r.ok).toBe(true);
    const it0 = (await h.store.getWorkItemBySource("github_issue", issueRef(7).id))!;
    expect((await h.sessions.finish({ id: it0.id, tokens: 1000 })).ok).toBe(true);
    await h.controller.tickRuns();
    const after = await h.item(it0.id);
    expect(after).toMatchObject({ stage: "REVIEW", pr_number: 42, token_cost: 1000 });
    expect((await h.runs(it0.id, "review")).map((x) => x.status)).toEqual(["queued"]);
    expect((await h.runs(it0.id, "triage")).map((x) => x.status)).toEqual(["cancelled"]);
    expect((await h.runs(it0.id, "interactive"))[0]).toMatchObject({ actor_id: "github:1" as UserId, transcript_url: "https://example.com/t" });
  });
});

describe("factory session CLI", () => {
  it("parses every command and flag; --tokens takes a whole number of 0 or more", () => {
    expect(parseSessionArgs(["start", "12", "--spec", "s.json", "--transcript", "https://x/t", "--as", "alice"]))
      .toEqual({ cmd: "start", target: "12", spec: "s.json", transcript: "https://x/t", as: "alice" });
    expect(parseSessionArgs(["status"])).toEqual({ cmd: "status" });
    expect(parseSessionArgs(["status", "wi_abc"])).toEqual({ cmd: "status", id: "wi_abc" });
    expect(parseSessionArgs(["note", "tried", "the", "parser", "--tokens", "40"])).toEqual({ cmd: "note", text: "tried the parser", tokens: 40 });
    expect(parseSessionArgs(["note", "wi_abc", "hello"])).toEqual({ cmd: "note", id: "wi_abc", text: "hello" });
    expect(parseSessionArgs(["note", "--transcript", "https://x/t"])).toEqual({ cmd: "note", transcript: "https://x/t" });
    expect(parseSessionArgs(["finish", "--tokens", "0"])).toEqual({ cmd: "finish", tokens: 0 });
    expect(parseSessionArgs(["abandon", "wi_abc", "--tokens", "9"])).toEqual({ cmd: "abandon", id: "wi_abc", tokens: 9 });
    for (const bad of [["finish", "--tokens", "-1"], ["finish", "--tokens", "1.5"], ["finish", "--tokens", "x"]]) {
      expect(parseSessionArgs(bad)).toEqual({ error: "--tokens takes a whole number of 0 or more" });
    }
    expect(parseSessionArgs(["finish", "--spec", "x"])).toMatchObject({ error: expect.stringContaining("not a flag") });
    expect(parseSessionArgs(["start"])).toMatchObject({ error: expect.any(String) });
    expect(parseSessionArgs(["note"])).toMatchObject({ error: expect.any(String) });
    expect(parseSessionArgs(["push"])).toMatchObject({ error: expect.stringContaining("unknown") });
  });

  it("keeps open sessions as owner-only files under the sessions folder", async () => {
    const dir = join(mkdtempSync(join(tmpdir(), "sf-sessions-")), "sessions");
    const files = new FileSessionFiles(dir);
    expect(await files.list()).toEqual([]);
    const f = { work_item_id: "wi_a1" as WorkItemId, run_id: "run_1" as Run["id"], token: 1, branch: "factory/wi_a1", folder: { id: "s", workdir: "/w", base_sha: null } };
    await files.write(f);
    expect(await files.read(f.work_item_id)).toEqual(f);
    expect(await files.list()).toEqual([f]);
    expect(statSync(join(dir, "wi_a1.json")).mode & 0o777).toBe(0o600);
    await files.remove(f.work_item_id);
    expect(await files.list()).toEqual([]);
    await expect(files.read("../x" as WorkItemId)).resolves.toBeNull();
  });

  it("start maps the login to the GitHub account, prints the folder, keeps the lease until stopped; finish goes through the broker", async () => {
    const h = await harness();
    const it0 = await h.running(1);
    const github = {
      async request<T>(_m: string, path: string): Promise<T> {
        if (path === "/users/alice") return { id: 1 } as T;
        throw new Error(`404 ${path}`);
      },
    };
    const printed: string[] = [];
    const stop = new AbortController();
    const deps = { sessions: h.sessions, config: h.cfg, github, readSpec: async () => SPEC_TEXT, print: (l: string) => printed.push(l), stop: stop.signal };
    const started = runSession(deps, { cmd: "start", target: it0.id, as: "alice" });
    await waitFor(async () => (await h.runs(it0.id, "interactive")).length === 1, "session start");
    expect(printed).toContain("run folder: /wt/1");
    expect((await h.runs(it0.id, "interactive"))[0]!.actor_id).toBe("github:1");
    stop.abort();
    expect(await started).toBe(0);
    expect(printed.at(-1)).toMatch(/stopped keeping the lease/);

    expect(await runSession({ ...deps, stop: new AbortController().signal }, { cmd: "finish" })).toBe(0);
    expect(h.broker.calls.map((c) => c.name)).toEqual(["github.push_branch", "github.open_pr"]);
    // An unknown login is refused before anything is read.
    expect(await runSession(deps, { cmd: "start", target: "1", as: "nobody" })).toBe(1);
  });

  it("githubIssues returns an issue with its author's account, and null for a PR or a missing issue", async () => {
    const github = {
      async request<T>(_m: string, path: string): Promise<T> {
        if (path === "/repos/o/r/issues/3") return { title: "T", body: null, html_url: "https://github.com/o/r/issues/3", user: { id: 9, login: "bob" } } as T;
        if (path === "/repos/o/r/issues/4") return { title: "PR", user: { id: 9 }, pull_request: {} } as T;
        throw new Error("404");
      },
    };
    const issues = githubIssues(github, { owner: "o", name: "r" });
    expect(await issues.issue(3)).toEqual({
      source: { type: "github_issue", id: "o/r#3", link: "https://github.com/o/r/issues/3" }, title: "T", body: "", author: { provider: "github", subject: "9" },
    });
    expect(await issues.issue(4)).toBeNull();
    expect(await issues.issue(5)).toBeNull();
  });
});
