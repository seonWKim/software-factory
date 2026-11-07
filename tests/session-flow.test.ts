import { mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { FactoryConfig } from "../src/core/config.js";
import { Controller } from "../src/core/controller.js";
import { Sessions, parseTarget } from "../src/core/session.js";
import type { Run, RunKind, Tier, WorkItem, WorkItemId, WorkerId } from "../src/core/types.js";
import { FakeClock } from "../src/impl/clock/fake-clock.js";
import { FileSessionFiles, githubIssues, parseSessionArgs, runSession } from "../src/session-cmd.js";
import {
  FakeAuth, FakeBroker, FakeIssues, FakeSandbox, FakeSource, MemorySessionFiles, alice, cleanScanner, config, issueRef, mallory, silent, waitFor,
} from "./helpers/fakes.js";
import { issue, newStore, system } from "./helpers/store.js";

// `factory session` (design §5, 2026-11-01) on fakes: sandbox, broker, auth and issues are fakes; the SQLite store
// and the controller are real.

const SPEC = {
  in_short: "AS-IS: nothing.\nTO-BE: something.", problem: "Fix the widget", done_criteria: ["the widget works"], desired_output: "a PR",
  scope: "the widget only", allowed_paths: ["src/a/"], files_to_change: ["src/a/x.ts"], tier: 2, tier_reason: "small", estimated_lines: 20, estimated_files: 1,
};
const SPEC_TEXT = JSON.stringify(SPEC);
/** A key-shaped string the leak scanner flags, built here so no such literal sits in the repository. */
const AWS_SHAPED = ["AKIA", "ABCDEFGHIJKLMNOP"].join("");
const W1 = "w1" as WorkerId;

async function harness() {
  const clock = new FakeClock();
  const { store } = await newStore(clock);
  const cfg: FactoryConfig = config;
  const sandbox = new FakeSandbox();
  sandbox.changedFiles = ["src/a/x.ts"];
  const broker = new FakeBroker();
  const files = new MemorySessionFiles();
  const issues = new FakeIssues({ 7: { source: issueRef(7), title: "Session issue", body: "the body", author: mallory } });
  const sessions = new Sessions({
    store, sandbox, broker, scanner: cleanScanner, auth: new FakeAuth(), clock, config: cfg, log: silent, files, issues, toolEnv: {}, owner: "session:host:1",
  });
  const controller = new Controller({ store, source: new FakeSource(), auth: new FakeAuth(), clock, config: cfg, log: silent, scanner: cleanScanner });
  /** A RUNNING item with an approved spec on `paths` and no run, as after `/approve` once its run ended. */
  const running = async (n: number, paths = ["src/a/"], tier: Tier = 2, extra: Partial<WorkItem> = {}) => {
    const { item } = await store.createWorkItem({ ...issue(n), title: `Item ${n}` }, system);
    const r = await store.transition({ id: item.id, expected_version: 1, actor: system, reason: "seed", patch: { stage: "RUNNING", allowed_paths: paths, tier, done_criteria: ["x"], ...extra } });
    if (!r.ok) throw new Error(r.reason);
    return r.item;
  };
  const enqueue = async (it: WorkItem, kind: RunKind, key: string) => {
    const cur = (await store.getWorkItem(it.id))!;
    await store.transition({ id: it.id, expected_version: cur.version, actor: system, reason: "x", patch: {}, enqueue: { kind, idempotency_key: key } });
  };
  const snapshot = async (id: WorkItemId) => JSON.stringify([await store.getWorkItem(id), await store.listRuns(id), await store.listStateChanges(id)]);
  const item = async (id: WorkItemId) => (await store.getWorkItem(id))!;
  const runs = async (id: WorkItemId, kind?: RunKind) => (await store.listRuns(id)).filter((r) => !kind || r.kind === kind);
  const start = (target: string, extra: { spec?: string; transcript?: string } = {}) => sessions.start({ target, person: alice, ...extra });
  return { clock, store, cfg, sandbox, broker, files, issues, sessions, controller, running, enqueue, snapshot, item, runs, start };
}
type H = Awaited<ReturnType<typeof harness>>;
/** A harness with an open session on item #1 (`it0`, allowed `paths`); `file` is its local record. */
async function started(paths = ["src/a/"]) {
  const h = await harness();
  const it0 = await h.running(1, paths);
  const r = await h.start(it0.id);
  expect(r.ok).toBe(true);
  return { ...h, it0, file: r.file! };
}

describe("session start", () => {
  it("creates the work item when the issue has none, and uses the existing one otherwise", async () => {
    const h = await harness();
    const r = await h.start("7", { spec: SPEC_TEXT });
    const created = (await h.store.getWorkItemBySource("github_issue", issueRef(7).id))!;
    expect(r.ok).toBe(true);
    expect(created).toMatchObject({ title: "Session issue", requester_id: "github:666" }); // the issue's author, as at intake
    expect(r.lines).toContain(`created work item ${created.id} for o/r#7`);
    const existing = await h.running(8, ["src/b/"]); // not src/a/: that overlaps the open session on #7
    const again = await h.start("#8");
    expect(again.ok).toBe(true);
    expect(h.issues.asked).toEqual([7]);
    expect(await h.runs(existing.id, "interactive")).toHaveLength(1);
    expect(again.lines.join("\n")).not.toContain("created work item");
  });

  it("stores one interactive run, running with a lease, with the person's user ID as its actor; the folder is on the item's branch", async () => {
    const h = await harness();
    const it0 = await h.running(1);
    const r = await h.start(it0.id);
    const all = await h.runs(it0.id);
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({ kind: "interactive", status: "running", attempt: 1, actor_id: "github:1", lease: { owner: "session:host:1", token: 1 } });
    const change = (await h.store.listStateChanges(it0.id)).at(-1)!;
    expect(change).toMatchObject({ reason: "session_started", actor: { kind: "user", id: "github:1" }, detail: { run_id: all[0]!.id, spec_source: "triage" } });
    expect(h.sandbox.created).toEqual([{ repo: "/repo", branch: `factory/${it0.id}`, base_ref: "main" }]);
    expect(r.lines).toContain("run folder: /wt/1");
    expect(r.file).toMatchObject({ work_item_id: it0.id, run_id: all[0]!.id, token: 1 });
  });

  describe("is refused with nothing changed", () => {
    const unchanged = async (h: H, id: WorkItemId, extra: { spec?: string } = {}, person = alice) => {
      const before = await h.snapshot(id);
      const made = h.sandbox.created.length;
      const r = await h.sessions.start({ target: id, person, ...extra });
      expect(r.ok).toBe(false);
      expect(await h.snapshot(id)).toBe(before);
      expect(h.sandbox.created.length).toBe(made); // refused before any run folder was made
      return r.lines.join("\n");
    };

    it("for a CLOSED item, an item in REVIEW, a READY item (naming /approve), no allowed_paths, or no write permission", async () => {
      const h = await harness();
      expect(await unchanged(h, (await h.running(1, ["src/a/"], 2, { stage: "CLOSED", close_reason: "wont_do" })).id)).toMatch(/closed/);
      expect(await unchanged(h, (await h.running(2, ["src/a/"], 2, { stage: "REVIEW", pr_number: 5 })).id)).toMatch(/in review \(PR #5\)/);
      const ready = await h.running(3, ["src/a/"], 2, { stage: "READY", blocked_on: "human", blocked_reason: "spec_pending" });
      expect(await unchanged(h, ready.id)).toContain("`/approve`");
      expect(await unchanged(h, (await h.running(4, [])).id)).toMatch(/no allowed_paths/);
      expect(await unchanged(h, (await h.running(5)).id, {}, mallory)).toMatch(/write permission/);
      expect(h.files.files.size).toBe(0);
    });

    it("for an item with a queued or running implement-type run, or an open session", async () => {
      const h = await harness();
      const it0 = await h.running(1);
      await h.enqueue(it0, "implement", "i1");
      expect(await unchanged(h, it0.id)).toMatch(/queued implement run/);
      await h.store.claimRun({ worker_id: W1, kinds: ["implement"], lease_ms: 60_000 });
      expect(await unchanged(h, it0.id)).toMatch(/running implement run/);
      const it1 = await h.running(2, ["src/b/"]);
      await h.enqueue(it1, "update", "u1");
      expect(await unchanged(h, it1.id)).toMatch(/queued update run/);
      const it2 = await h.running(3, ["src/c/"]);
      expect((await h.start(it2.id)).ok).toBe(true);
      expect(await unchanged(h, it2.id)).toMatch(/already has an open session/);
    });

    it("when a running implement-type run of another item has overlapping allowed_paths", async () => {
      const h = await harness();
      const other = await h.running(2, ["src/a/x.ts"]);
      await h.enqueue(other, "implement", "i2");
      await h.store.claimRun({ worker_id: W1, kinds: ["implement"], lease_ms: 60_000 });
      const it0 = await h.running(1, ["src/a/"]);
      const before = await h.snapshot(it0.id);
      const r = await h.start(it0.id);
      expect(r.ok).toBe(false);
      expect(r.lines.join("\n")).toMatch(/o\/r#2 .* overlaps the allowed_paths: src\/a\/x\.ts/);
      expect(await h.snapshot(it0.id)).toBe(before);
      expect(h.sandbox.destroyed).toBe(1); // the folder made before the store's check is removed again
      expect(h.files.files.size).toBe(0);
      expect((await h.start((await h.running(3, ["src/c/"])).id)).ok).toBe(true);
    });

    it("with an invalid --spec file, checked by the triage parser", async () => {
      const h = await harness();
      const { item: it0 } = await h.store.createWorkItem(issue(1), system, { enqueue: { kind: "triage", idempotency_key: "t1" } });
      expect(await unchanged(h, it0.id, { spec: "not json" })).toMatch(/not JSON/);
      expect(await unchanged(h, it0.id, { spec: JSON.stringify({ ...SPEC, allowed_paths: [] }) })).toMatch(/not a valid spec: allowed_paths/);
      expect(await unchanged(h, it0.id, { spec: JSON.stringify({ ...SPEC, files_to_change: ["src/b/y.ts"] }) })).toMatch(/not covered/);
      expect((await h.start("7", { spec: "{}" })).ok).toBe(false);
      expect(await h.store.getWorkItemBySource("github_issue", issueRef(7).id)).toBeNull(); // nothing created either
    });
  });

  it("on a NEW item cancels its queued triage run and records the spec source on the state change", async () => {
    const h = await harness();
    const { item: it0 } = await h.store.createWorkItem(issue(1), system, { enqueue: { kind: "triage", idempotency_key: "t1" } });
    expect((await h.start(it0.id, { spec: SPEC_TEXT })).ok).toBe(true);
    const triage = (await h.runs(it0.id, "triage"))[0]!;
    expect(triage.status).toBe("cancelled");
    expect(await h.item(it0.id)).toMatchObject({ stage: "RUNNING", blocked_on: "none", allowed_paths: ["src/a/"], done_criteria: ["the widget works"], tier: 2 });
    expect((await h.store.listStateChanges(it0.id)).at(-1)!.detail).toMatchObject({ spec_source: "owner" });
    await h.controller.tickRuns(); // the cancelled triage run is acknowledged and ignored
    expect((await h.store.getRun(triage.id))!.acknowledged_at).not.toBeNull();
    expect((await h.item(it0.id)).stage).toBe("RUNNING");
    await h.sessions.abandon({});
    await h.controller.tickRuns();
    await h.start(it0.id); // a later session still names the owner's spec
    expect((await h.store.listStateChanges(it0.id)).at(-1)!.detail).toMatchObject({ spec_source: "owner" });
  });


  it("a worker never claims a queued implement-type run whose item overlaps an open session, nor an interactive run", async () => {
    const h = await harness();
    const it0 = await h.running(1, ["src/a/"]);
    await h.start(it0.id);
    const overlapping = await h.running(2, ["src/a/y.ts"]);
    await h.enqueue(overlapping, "implement", "i2");
    const all = ["triage", "implement", "review", "update", "resolve", "interactive"] as const;
    const claim = () => h.store.claimRun({ worker_id: W1, kinds: all, lease_ms: 60_000 });
    expect(await claim()).toBeNull();
    const free = await h.running(3, ["src/b/"]);
    await h.enqueue(free, "implement", "i3");
    expect((await claim())?.work_item_id).toBe(free.id);
    expect((await h.runs(it0.id, "interactive"))[0]!.lease!.owner).toBe("session:host:1");
    expect((await h.store.pauseWorkers({ count: 5 }, "github:1")).paused).toEqual([W1]); // never the session's owner
    await h.store.resumeWorkers();
    await h.sessions.abandon({ id: it0.id });
    expect((await claim())?.work_item_id).toBe(overlapping.id);
  });
});

describe("session note and status", () => {
  it("stores a note after the egress scan; a flagged note is refused with the rule name and nothing is stored", async () => {
    const h = await started();
    const { it0 } = h;
    expect((await h.sessions.note({ text: "tried the parser first" })).ok).toBe(true);
    const flagged = await h.sessions.note({ text: `key ${AWS_SHAPED} leaked` });
    expect(flagged.ok).toBe(false);
    expect(flagged.lines.join("\n")).toContain("aws_access_key");
    expect((await h.runs(it0.id, "interactive"))[0]!.session_notes.map((n) => n.text)).toEqual(["tried the parser first"]);
  });

  it("prints the item, the run, the lease expiry and the result of the last finish attempt", async () => {
    const h = await started();
    const { it0 } = h;
    const run = (await h.runs(it0.id, "interactive"))[0]!;
    const first = (await h.sessions.status()).lines.join("\n");
    for (const s of [`item: ${it0.id} (o/r#1) RUNNING`, `run: ${run.id} running, actor github:1`, `lease: expires ${run.lease!.expires_at}`, "last finish: none yet"]) {
      expect(first).toContain(s);
    }
    h.sandbox.exits["npm test"] = 1;
    await h.sessions.finish({});
    expect((await h.sessions.status(it0.id)).lines.join("\n")).toMatch(/last finish: \S+ refused: tests: `npm test` exited 1/);
  });

  it("--transcript on start and note stores an http or https URL after the egress scan", async () => {
    const h = await harness();
    const it0 = await h.running(1);
    const url = async () => (await h.runs(it0.id, "interactive"))[0]!.transcript_url;
    expect((await h.start(it0.id, { transcript: "ftp://example.com/t" })).ok).toBe(false);
    expect((await h.start(it0.id, { transcript: "https://example.com/t/1" })).ok).toBe(true);
    expect(await url()).toBe("https://example.com/t/1");
    expect((await h.sessions.note({ transcript: "http://example.com/t/2" })).ok).toBe(true);
    const flagged = await h.sessions.note({ transcript: `https://example.com/?k=${AWS_SHAPED}` });
    expect(flagged.lines.join("\n")).toContain("aws_access_key");
    expect((await h.sessions.note({ transcript: "javascript:alert(1)" })).ok).toBe(false);
    expect(await url()).toBe("http://example.com/t/2");
  });
});

describe("session finish", () => {
  /** A refused finish: nothing pushed, the session open, the reasons recorded. Returns the printed text. */
  const refusedOpen = async (h: H & { it0: WorkItem }) => {
    const r = await h.sessions.finish({});
    const run = (await h.runs(h.it0.id, "interactive"))[0]!;
    expect([r.ok, h.broker.calls, run.status, h.files.files.has(h.it0.id), run.last_finish?.ok]).toEqual([false, [], "running", true, false]);
    return r.lines.join("\n");
  };

  it("each gate refuses when it fails: scope, size (limits unchanged), floor, tests; several reasons are listed together", async () => {
    let h = await started();
    h.sandbox.changedFiles = ["src/a/x.ts", "README.md"];
    expect(await refusedOpen(h)).toMatch(/`npm test` not run[\s\S]*scope: files outside allowed_paths: README\.md/);
    expect(h.sandbox.commands).toEqual([]);
    h = await started();
    h.sandbox.numstat = "1501\t0\tsrc/a/x.ts\0";
    expect(await refusedOpen(h)).toContain("size: the diff changes 1501 lines (limit max_diff_lines = 1500) in 1 files (limit max_diff_files = 40)");
    h = await started();
    h.sandbox.exits["npm test"] = 1;
    expect(await refusedOpen(h)).toContain("tests: `npm test` exited 1");
    h = await started();
    h.sandbox.changedFiles = ["README.md"];
    h.sandbox.numstat = "3000\t0\tREADME.md\0";
    h.sandbox.status = " M src/a/x.ts\0";
    expect(await refusedOpen(h)).toMatch(/uncommitted changes[\s\S]*scope:[\s\S]*size:/);
  });

  it("a floor hit is refused with the paths and the required tier; the session stays open and no floor_blocked is written", async () => {
    const h = await started(["src/"]);
    h.sandbox.changedFiles = ["src/impl/broker/x.ts"];
    expect(await refusedOpen(h)).toContain("floor: src/impl/broker/x.ts need tier 4 (the item is tier 2)");
    expect((await h.store.listStateChanges(h.it0.id)).map((c) => c.reason)).not.toContain("floor_blocked");
    expect(await h.item(h.it0.id)).toMatchObject({ stage: "RUNNING", blocked_on: "none", tier: 2 });
  });

  it("pushes and opens the PR only through the broker; the controller moves the item to REVIEW and queues a review run", async () => {
    const h = await started();
    await h.sessions.note({ text: "split the parser", tokens: 120 });
    expect((await h.sessions.finish({ tokens: 300 })).ok).toBe(true);
    const run = (await h.runs(h.it0.id, "interactive"))[0]!;
    const ctx = { run_id: run.id, work_item_id: h.it0.id, lease_token: 1 };
    expect(h.broker.calls.map((c) => [c.name, c.ctx])).toEqual([["github.push_branch", ctx], ["github.open_pr", ctx]]);
    expect(h.broker.calls[0]!.args).toEqual({ workdir: "/wt/1", branch: `factory/${h.it0.id}`, base_ref: "main" });
    expect((h.broker.calls[1]!.args as { body: string }).body).toMatch(/split the parser[\s\S]*Closes #1/);
    expect(h.sandbox.gitCalls.some((c) => /(^| )push( |$)/.test(c))).toBe(false); // no git push of its own
    // The gates in order: scope, then size and floor (one numstat), then the test command.
    const at = (p: string) => h.sandbox.gitCalls.findIndex((c) => c.startsWith(p));
    expect([at("diff --name-only -z --no-renames basesha...HEAD") >= 0, at("diff --numstat -z -M basesha...HEAD") > at("diff --name-only"), h.sandbox.commands]).toEqual([true, true, ["npm test"]]);
    expect([run.status, h.files.files.size]).toEqual(["succeeded", 0]);
    for (let i = 0; i < 2; i++) await h.controller.tickRuns(); // applied once
    expect(await h.item(h.it0.id)).toMatchObject({ stage: "REVIEW", pr_number: 42, token_cost: 300, pr_files: ["src/a/x.ts"] });
    expect((await h.runs(h.it0.id, "review")).map((x) => x.status)).toEqual(["queued"]);
    expect((await h.store.listStateChanges(h.it0.id)).at(-1)).toMatchObject({ reason: "session_finished" });
  });

  it("finish again after a success, or after a failed push, creates no second PR and no second review run", async () => {
    const h = await started();
    h.broker.responses["github.push_branch"] = [{ ok: false, error_code: "push_failed", message: "rejected" }];
    expect((await h.sessions.finish({})).lines.join("\n")).toContain("push: push_failed: rejected");
    await h.controller.tickRuns();
    expect((await h.item(h.it0.id)).stage).toBe("RUNNING");
    expect((await h.sessions.finish({})).ok).toBe(true);
    await h.controller.tickRuns();
    expect((await h.sessions.finish({ id: h.it0.id })).ok).toBe(false);
    // The local record left behind by a crash between completion and its removal changes nothing either.
    const run = (await h.runs(h.it0.id, "interactive"))[0]!;
    await h.files.write({ work_item_id: h.it0.id, run_id: run.id, token: 1, branch: "b", folder: { id: "sbx1", workdir: "/wt/1", base_sha: "basesha" } });
    expect((await h.sessions.finish({})).ok).toBe(false);
    await h.controller.tickRuns();
    expect(h.broker.calls.filter((c) => c.name === "github.open_pr")).toHaveLength(1);
    expect(await h.runs(h.it0.id, "review")).toHaveLength(1);
    expect((await h.item(h.it0.id)).stage).toBe("REVIEW");
  });
});

describe("session end without a PR", () => {
  const released = { stage: "RUNNING", blocked_on: "human", blocked_reason: "session_released" };

  it("abandon ends the run as failed `abandoned`, keeps the remote branch, and the controller releases the item", async () => {
    const h = await started();
    const { it0 } = h;
    h.broker.responses["github.open_pr"] = [{ ok: false, error_code: "pr_failed", message: "no" }];
    expect((await h.sessions.finish({})).ok).toBe(false); // pushed, no PR: the branch is on the fake forge
    const branch = `factory/${it0.id}`;
    expect(h.broker.remote.has(branch)).toBe(true);
    expect((await h.sessions.abandon({ tokens: 40 })).ok).toBe(true);
    expect((await h.runs(it0.id, "interactive"))[0]).toMatchObject({ status: "failed", outcome: { status: "failed", error_code: "abandoned" } });
    expect(h.sandbox.destroyed).toBe(0); // the run folder is kept too
    await h.controller.tickRuns();
    expect(await h.item(it0.id)).toMatchObject({ ...released, token_cost: 40 });
    expect((await h.runs(it0.id)).filter((x) => x.status === "queued")).toEqual([]);
    expect(h.broker.remote.has(branch)).toBe(true);
    // Released: the next start succeeds and clears the block.
    expect((await h.start(it0.id)).ok).toBe(true);
    expect(await h.item(it0.id)).toMatchObject({ stage: "RUNNING", blocked_on: "none", blocked_reason: null });
    expect((await h.runs(it0.id, "interactive")).map((x) => x.status)).toEqual(["failed", "running"]);
  });

  it("an expired session lease is ended by the reaper as `session_lost`, never requeued; the controller releases the item", async () => {
    const h = await started();
    const { it0, file } = h;
    await h.sessions.note({ tokens: 75 });
    // While `start` runs, its heartbeat renews the lease; Ctrl-C stops it without ending the run.
    const lease = async () => (await h.runs(it0.id, "interactive"))[0]!.lease!.expires_at;
    const [first, stop] = [await lease(), new AbortController()];
    const beating = h.sessions.heartbeat(file, stop.signal);
    h.clock.advance(h.cfg.heartbeat_ms);
    await waitFor(async () => (await lease()) > first, "a renewed lease");
    stop.abort();
    expect(await beating).toBe("stopped");
    h.clock.advance(h.cfg.lease_ms + 1); // no heartbeat any more
    await h.controller.tickReaper();
    expect((await h.runs(it0.id, "interactive"))[0]).toMatchObject({ status: "failed", attempt: 1, lease: null, outcome: { error_code: "session_lost" } });
    await h.controller.tickRuns();
    expect(await h.item(it0.id)).toMatchObject({ ...released, token_cost: 75 });
    expect((await h.runs(it0.id)).filter((x) => x.status === "queued" || x.status === "running")).toEqual([]);
    const beat = h.sessions.heartbeat(file, new AbortController().signal); // the stopped terminal's lease is gone
    h.clock.advance(h.cfg.heartbeat_ms);
    expect(await beat).toBe("ended");
    expect(h.files.files.size).toBe(0);
  });

  it("--tokens takes a whole number of 0 or more; the latest total is added to token_cost once, when the run ends", async () => {
    const h = await started();
    const { it0 } = h;
    for (const [tokens, ok] of [[-1, false], [1.5, false], [0, true], [500, true]] as const) expect((await h.sessions.note({ tokens })).ok).toBe(ok);
    expect((await h.item(it0.id)).token_cost).toBe(0);
    await h.sessions.abandon({ tokens: 900 });
    for (let i = 0; i < 2; i++) await h.controller.tickRuns();
    expect((await h.item(it0.id)).token_cost).toBe(900);
  });

  it("a finished session on an item closed meanwhile is ignored, and its reported tokens still land in token_cost", async () => {
    const h = await started();
    const { it0 } = h;
    expect((await h.sessions.finish({ tokens: 300 })).ok).toBe(true);
    const cur = await h.item(it0.id);
    await h.store.transition({ id: it0.id, expected_version: cur.version, actor: system, reason: "x", patch: { stage: "CLOSED", close_reason: "completed" } });
    for (let i = 0; i < 2; i++) await h.controller.tickRuns();
    expect(await h.item(it0.id)).toMatchObject({ stage: "CLOSED", token_cost: 300 });
    expect((await h.store.listStateChanges(it0.id)).at(-1)).toMatchObject({ reason: "run_ignored" });
  });
});

describe("session flow and CLI", () => {
  it("start (issue with no item, --spec, --transcript), finish: REVIEW with a review run queued", async () => {
    const h = await harness();
    expect((await h.start("7", { spec: SPEC_TEXT, transcript: "https://example.com/t" })).ok).toBe(true);
    const it0 = (await h.store.getWorkItemBySource("github_issue", issueRef(7).id))!;
    expect((await h.sessions.finish({ id: it0.id, tokens: 1000 })).ok).toBe(true);
    await h.controller.tickRuns();
    expect(await h.item(it0.id)).toMatchObject({ stage: "REVIEW", pr_number: 42, token_cost: 1000 });
    expect((await h.runs(it0.id)).map((x) => [x.kind, x.status])).toEqual([["triage", "cancelled"], ["interactive", "succeeded"], ["review", "queued"]]);
    expect((await h.runs(it0.id, "interactive"))[0]).toMatchObject({ actor_id: "github:1", transcript_url: "https://example.com/t" });
  });

  it("parses every command and flag; --tokens takes a whole number of 0 or more", () => {
    expect(["12", "#12", "wi_abc1", "foo"].map(parseTarget)).toEqual([{ kind: "issue", number: 12 }, { kind: "issue", number: 12 }, { kind: "item", id: "wi_abc1" }, null]);
    expect(parseSessionArgs(["start", "12", "--spec", "s.json", "--transcript", "https://x/t", "--as", "alice"]))
      .toEqual({ cmd: "start", target: "12", spec: "s.json", transcript: "https://x/t", as: "alice" });
    expect(parseSessionArgs(["status", "wi_abc"])).toEqual({ cmd: "status", id: "wi_abc" });
    expect(parseSessionArgs(["note", "tried", "it", "--tokens", "40"])).toEqual({ cmd: "note", text: "tried it", tokens: 40 });
    expect(parseSessionArgs(["note", "wi_abc", "--transcript", "https://x/t"])).toEqual({ cmd: "note", id: "wi_abc", transcript: "https://x/t" });
    expect(parseSessionArgs(["finish", "--tokens", "0"])).toEqual({ cmd: "finish", tokens: 0 });
    expect(parseSessionArgs(["abandon", "wi_abc", "--tokens", "9"])).toEqual({ cmd: "abandon", id: "wi_abc", tokens: 9 });
    for (const t of ["-1", "1.5", "x"]) expect(parseSessionArgs(["finish", "--tokens", t])).toEqual({ error: "--tokens takes a whole number of 0 or more" });
    for (const bad of [["finish", "--spec", "x"], ["start"], ["note"], ["push"]]) expect(parseSessionArgs(bad)).toHaveProperty("error");
  });

  it("keeps open sessions as owner-only files under the sessions folder", async () => {
    const dir = join(mkdtempSync(join(tmpdir(), "sf-sessions-")), "sessions");
    const files = new FileSessionFiles(dir);
    const f = { work_item_id: "wi_a1" as WorkItemId, run_id: "run_1" as Run["id"], token: 1, branch: "factory/wi_a1", folder: { id: "s", workdir: "/w", base_sha: null } };
    await files.write(f);
    expect([await files.read(f.work_item_id), await files.list(), statSync(join(dir, "wi_a1.json")).mode & 0o777]).toEqual([f, [f], 0o600]);
    await files.remove(f.work_item_id);
    expect([await files.list(), await files.read("../x" as WorkItemId)]).toEqual([[], null]);
  });

  it("runSession maps the login to the GitHub account, keeps the lease until stopped, and finishes through the broker", async () => {
    const h = await harness();
    const it0 = await h.running(1);
    const replies: Record<string, unknown> = {
      "/users/alice": { id: 1 }, "/repos/o/r/issues/3": { title: "T", body: null, html_url: "https://github.com/o/r/issues/3", user: { id: 9 } },
      "/repos/o/r/issues/4": { title: "PR", user: { id: 9 }, pull_request: {} },
    };
    const github = { request: async <T>(_m: string, path: string): Promise<T> => (path in replies ? (replies[path] as T) : Promise.reject(new Error("404"))) };
    const printed: string[] = [];
    const stop = new AbortController();
    const deps = { sessions: h.sessions, config: h.cfg, github, readSpec: async () => SPEC_TEXT, print: (l: string) => printed.push(l), stop: stop.signal };
    const started = runSession(deps, { cmd: "start", target: it0.id, as: "alice" });
    await waitFor(async () => (await h.runs(it0.id, "interactive")).length === 1, "session start");
    expect(printed).toContain("run folder: /wt/1");
    stop.abort();
    expect(await started).toBe(0);
    expect(printed.at(-1)).toMatch(/stopped keeping the lease/);
    expect(await runSession({ ...deps, stop: new AbortController().signal }, { cmd: "finish" })).toBe(0);
    expect(h.broker.calls.map((c) => c.name)).toEqual(["github.push_branch", "github.open_pr"]);
    expect(await runSession(deps, { cmd: "start", target: "1", as: "nobody" })).toBe(1);
    const issues = githubIssues(github, { owner: "o", name: "r" });
    expect(await issues.issue(3)).toEqual({ source: { type: "github_issue", id: "o/r#3", link: "https://github.com/o/r/issues/3" }, title: "T", body: "", author: { provider: "github", subject: "9" } });
    expect([await issues.issue(4), await issues.issue(5)]).toEqual([null, null]);
  });
});
