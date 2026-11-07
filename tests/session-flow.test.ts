import { describe, expect, it } from "vitest";
import { Controller } from "../src/core/controller.js";
import { Sessions } from "../src/core/session.js";
import type { RunKind, UserId, WorkItem, WorkItemId, WorkItemPatch, WorkerId } from "../src/core/types.js";
import type { FactoryStore } from "../src/interfaces/factory-store.js";
import { FakeClock } from "../src/impl/clock/fake-clock.js";
import { PatternEgressScanner } from "../src/impl/egress/pattern-egress-scanner.js";
import {
  FakeAuth, FakeBroker, FakeSandbox, FakeSource, MemorySessionFiles, cleanScanner, config, gates, silent, triageSpec,
} from "./helpers/fakes.js";
import { issue, newStore, system, w1 } from "./helpers/store.js";

// `factory session` (design 2026-11-01): a person's own session as an `interactive` run, end to end on fakes.

const OWNER: UserId = "github:1" as UserId;
// Built here so no secret-shaped literal sits in the repository.
const SECRET = `ghp_${"Ab3".repeat(12)}`;
const SPEC = { ...triageSpec, allowed_paths: ["src/"], files_to_change: ["src/app.ts"] };

async function setup(opts: { issues?: Record<number, { title: string; body: string }> } = {}) {
  const clock = new FakeClock();
  const { store } = await newStore(clock);
  const sandbox = new FakeSandbox();
  sandbox.changedFiles = ["src/app.ts"];
  const broker = new FakeBroker();
  const files = new MemorySessionFiles();
  const issues = opts.issues ?? { 7: { title: "Add the thing", body: "please" } };
  const sessions = new Sessions({
    store, sandbox, broker, scanner: cleanScanner, clock, config, toolEnv: {}, files,
    issue: async (n) => issues[n] ?? null,
    owner: "session:host:1" as WorkerId,
  });
  const controller = new Controller({ store, source: new FakeSource(), auth: new FakeAuth(), clock, config, log: silent, scanner: cleanScanner });
  return { clock, store, sandbox, broker, files, sessions, controller };
}

type Env = Awaited<ReturnType<typeof setup>>;

/** An item taken in and moved to `patch` (RUNNING with allowed_paths by default), as triage and /approve would. */
async function item(store: FactoryStore, n: number, patch: WorkItemPatch = {}): Promise<WorkItem> {
  const { item: it } = await store.createWorkItem(issue(n), system);
  const r = await store.transition({
    id: it.id, expected_version: it.version, actor: system, reason: "spec_approved",
    patch: { stage: "RUNNING", allowed_paths: ["src/"], tier: 2, ...patch },
  });
  if (!r.ok) throw new Error(r.reason);
  return r.item;
}

/** Everything a refusal must leave as it was. */
async function snapshot(e: Env, id: WorkItemId) {
  return {
    item: await e.store.getWorkItem(id),
    runs: await e.store.listRuns(id),
    changes: await e.store.listStateChanges(id),
    folders: e.sandbox.created.length,
    files: e.files.records.size,
  };
}

const start = (e: Env, ref: string, extra: { spec?: string; transcript?: string } = {}) => e.sessions.start({ ref, actor: OWNER, ...extra });
const sessionRun = async (store: FactoryStore, id: WorkItemId) => (await store.listRuns(id)).find((r) => r.kind === "interactive")!;

describe("session start", () => {
  it("creates the work item when the issue has none, from the issue text and the owner's spec", async () => {
    const e = await setup();
    const r = await start(e, "7", { spec: JSON.stringify(SPEC) });
    expect(r.ok).toBe(true);
    const it = (await e.store.getWorkItemBySource("github_issue", "o/r#7"))!;
    expect(it).toMatchObject({ title: "Add the thing", requester_id: OWNER, stage: "RUNNING", allowed_paths: ["src/"], project: config.project.key });
    // Intake's own triage key: a later poll of the issue finds the item and queues nothing. Start cancelled it.
    const triage = (await e.store.listRuns(it.id)).find((x) => x.kind === "triage")!;
    expect(triage).toMatchObject({ idempotency_key: "github_issue:o/r#7:triage", status: "cancelled" });
  });

  it("uses the existing work item when the issue has one", async () => {
    const e = await setup();
    const existing = await item(e.store, 7);
    const r = await start(e, "7");
    expect(r.ok).toBe(true);
    expect((await e.store.listWorkItems(10)).map((i) => i.id)).toEqual([existing.id]);
    expect((await sessionRun(e.store, existing.id)).work_item_id).toBe(existing.id);
    // A work item id works too, once that session has ended.
    await e.sessions.abandon();
    await e.controller.tickRuns();
    expect((await start(e, existing.id)).ok).toBe(true);
  });

  it("stores one interactive run, running with a lease, whose actor is the person and not the bot", async () => {
    const e = await setup();
    const it = await item(e.store, 1);
    await start(e, it.id);
    const runs = (await e.store.listRuns(it.id)).filter((r) => r.kind === "interactive");
    expect(runs).toHaveLength(1);
    const run = runs[0]!;
    expect(run).toMatchObject({ status: "running", attempt: 1, actor_id: OWNER, lease: { owner: "session:host:1", token: 1 } });
    expect(Date.parse(run.lease!.expires_at)).toBe(e.clock.now().getTime() + config.lease_ms);
    const sc = (await e.store.listStateChanges(it.id)).at(-1)!;
    expect(sc).toMatchObject({ reason: "session_started", actor: { kind: "user", id: OWNER } });
  });

  it("creates the run folder through Sandbox.create on the item's branch and prints its path", async () => {
    const e = await setup();
    const it = await item(e.store, 1);
    const r = await start(e, it.id);
    expect(e.sandbox.created).toEqual([{ repo: "/repo", branch: `factory/${it.id}`, base_ref: "main" }]);
    expect(r.lines).toContain("run folder: /wt/1");
    expect(r.record).toMatchObject({ workdir: "/wt/1", branch: `factory/${it.id}`, base_sha: "basesha", lease_token: 1 });
  });

  const refusals: [string, WorkItemPatch, RegExp][] = [
    ["a CLOSED item", { stage: "CLOSED", close_reason: "completed" }, /CLOSED/],
    ["an item in REVIEW", { stage: "REVIEW", pr_number: 5 }, /REVIEW/],
  ];
  for (const [what, patch, msg] of refusals) {
    it(`is refused, with nothing changed, for ${what}`, async () => {
      const e = await setup();
      const it = await item(e.store, 1, patch);
      const before = await snapshot(e, it.id);
      const r = await start(e, it.id);
      expect(r.ok).toBe(false);
      expect(r.lines.join("\n")).toMatch(msg);
      expect(await snapshot(e, it.id)).toEqual(before);
    });
  }

  for (const [kind, status] of [["implement", "queued"], ["implement", "running"], ["update", "queued"]] as [RunKind, string][]) {
    it(`is refused, with nothing changed, for an item with a ${status} ${kind} run`, async () => {
      const e = await setup();
      const it = await item(e.store, 1);
      await e.store.transition({ id: it.id, expected_version: it.version, actor: system, reason: "x", patch: {}, enqueue: { kind, idempotency_key: `${it.id}:${kind}` } });
      if (status === "running") expect(await e.store.claimRun({ worker_id: w1, kinds: [kind], lease_ms: 60_000 })).not.toBeNull();
      const before = await snapshot(e, it.id);
      const r = await start(e, it.id);
      expect(r).toMatchObject({ ok: false });
      expect(r.lines.join("\n")).toMatch(/implement-type run/);
      expect(await snapshot(e, it.id)).toEqual(before);
    });
  }

  it("is refused, with nothing changed, for an item that already has an open session", async () => {
    const e = await setup();
    const it = await item(e.store, 1);
    await start(e, it.id);
    const before = await snapshot(e, it.id);
    const r = await start(e, it.id);
    expect(r.ok).toBe(false);
    expect(r.lines.join("\n")).toMatch(/already has an open session/);
    expect(await snapshot(e, it.id)).toEqual(before);
  });

  it("is refused, with nothing changed, when a running implement run of another item overlaps its allowed_paths", async () => {
    const e = await setup();
    const other = await item(e.store, 2, { allowed_paths: ["src/app.ts"] });
    await e.store.transition({ id: other.id, expected_version: other.version, actor: system, reason: "x", patch: {}, enqueue: { kind: "implement", idempotency_key: "k" } });
    expect(await e.store.claimRun({ worker_id: w1, kinds: ["implement"], lease_ms: 60_000 })).not.toBeNull();
    const it = await item(e.store, 1);
    const before = await snapshot(e, it.id);
    const r = await start(e, it.id);
    expect(r.ok).toBe(false);
    expect(r.lines.join("\n")).toContain(`item ${other.id} overlaps`);
    expect(await snapshot(e, it.id)).toEqual(before);
    // No overlap: the session starts.
    const apart = await item(e.store, 3, { allowed_paths: ["docs/"] });
    expect((await start(e, apart.id)).ok).toBe(true);
  });

  it("on a NEW item cancels its queued triage run and records the spec source on the state change", async () => {
    const e = await setup();
    const { item: fresh } = await e.store.createWorkItem(issue(4), system, { enqueue: { kind: "triage", idempotency_key: "t4" } });
    const r = await start(e, fresh.id, { spec: JSON.stringify(SPEC) });
    expect(r.ok).toBe(true);
    expect((await e.store.listRuns(fresh.id)).find((x) => x.kind === "triage")!.status).toBe("cancelled");
    const sc = (await e.store.listStateChanges(fresh.id)).at(-1)!;
    expect(sc).toMatchObject({ reason: "session_started", detail: { spec_source: "owner" } });
    expect(sc.changes).toMatchObject({ stage: { from: "NEW", to: "RUNNING" }, allowed_paths: { from: [], to: ["src/"] } });
    // An approved (triaged) spec is recorded as `triage`.
    const approved = await item(e.store, 5, { allowed_paths: ["docs/"] });
    await start(e, approved.id);
    expect((await e.store.listStateChanges(approved.id)).at(-1)!.detail).toMatchObject({ spec_source: "triage" });
  });

  it("validates --spec with the triage parser and is refused, with nothing changed, when it is invalid", async () => {
    const e = await setup();
    const { item: fresh } = await e.store.createWorkItem(issue(4), system, { enqueue: { kind: "triage", idempotency_key: "t4" } });
    const before = await snapshot(e, fresh.id);
    for (const bad of ["not json", JSON.stringify({ ...SPEC, done_criteria: [] }), JSON.stringify({ ...SPEC, allowed_paths: ["../x"] })]) {
      const r = await start(e, fresh.id, { spec: bad });
      expect(r.ok, bad).toBe(false);
      expect(r.lines.join("\n")).toMatch(/--spec file/);
      expect(await snapshot(e, fresh.id)).toEqual(before);
    }
    // An issue with no item yet: no item is created for an invalid spec.
    expect((await start(e, "7", { spec: "{}" })).ok).toBe(false);
    expect(await e.store.getWorkItemBySource("github_issue", "o/r#7")).toBeNull();
  });

  it("on a READY item waiting for spec approval is refused and names /approve", async () => {
    const e = await setup();
    const it = await item(e.store, 1, { stage: "READY", blocked_on: "human", blocked_reason: "spec_pending" });
    const before = await snapshot(e, it.id);
    const r = await start(e, it.id);
    expect(r.ok).toBe(false);
    expect(r.lines.join("\n")).toContain("`/approve`");
    expect(await snapshot(e, it.id)).toEqual(before);
  });

  it("an item with no allowed_paths cannot start a session", async () => {
    const e = await setup();
    const it = await item(e.store, 1, { allowed_paths: [] });
    const before = await snapshot(e, it.id);
    const r = await start(e, it.id);
    expect(r.ok).toBe(false);
    expect(r.lines.join("\n")).toMatch(/no allowed_paths/);
    expect(await snapshot(e, it.id)).toEqual(before);
    // A NEW item without --spec has none either, and an issue with no item gets none created.
    const { item: fresh } = await e.store.createWorkItem(issue(2), system);
    expect((await start(e, fresh.id)).lines.join("\n")).toMatch(/no allowed_paths/);
    expect((await start(e, "7")).lines.join("\n")).toMatch(/no allowed_paths/);
    expect(await e.store.getWorkItemBySource("github_issue", "o/r#7")).toBeNull();
  });
});

describe("claims while a session is open", () => {
  it("a worker never claims a queued implement-type run whose item overlaps an open session", async () => {
    const e = await setup();
    const it = await item(e.store, 1);
    await start(e, it.id);
    const overlapping = await item(e.store, 2, { allowed_paths: ["src/core/"] });
    const apart = await item(e.store, 3, { allowed_paths: ["docs/"] });
    for (const x of [overlapping, apart]) {
      await e.store.transition({ id: x.id, expected_version: x.version, actor: system, reason: "x", patch: {}, enqueue: { kind: "implement", idempotency_key: `${x.id}:i` } });
    }
    const claimed = await e.store.claimRun({ worker_id: w1, kinds: ["implement", "update"], lease_ms: 60_000 });
    expect(claimed?.work_item_id).toBe(apart.id);
    expect(await e.store.claimRun({ worker_id: w1, kinds: ["implement", "update"], lease_ms: 60_000 })).toBeNull();
    expect((await e.store.listRuns(overlapping.id)).find((r) => r.kind === "implement")!.status).toBe("queued");
    // Once the session ends, the held run is claimable.
    await e.sessions.abandon({ id: it.id });
    expect((await e.store.claimRun({ worker_id: w1, kinds: ["implement"], lease_ms: 60_000 }))?.work_item_id).toBe(overlapping.id);
  });

  it("workers never claim an interactive run", async () => {
    const e = await setup();
    const it = await item(e.store, 1);
    await start(e, it.id);
    const all: RunKind[] = ["triage", "implement", "review", "update", "resolve", "manual", "interactive"];
    expect(await e.store.claimRun({ worker_id: w1, kinds: all, lease_ms: 60_000 })).toBeNull();
    // Even past its lease: the reaper ends it, never requeues it, so no claim ever sees it.
    e.clock.advance(config.lease_ms + 1);
    await e.controller.tickReaper();
    expect(await e.store.claimRun({ worker_id: w1, kinds: all, lease_ms: 60_000 })).toBeNull();
    expect((await sessionRun(e.store, it.id)).status).toBe("failed");
  });
});

describe("session note and status", () => {
  it("stores a note after the egress scan; a flagged note is refused with the rule name and nothing is stored", async () => {
    const e = await setup();
    const it = await item(e.store, 1);
    await start(e, it.id);
    expect((await e.sessions.note("tried the parser first")).ok).toBe(true);
    const bad = await e.sessions.note(`token ${SECRET}`);
    expect(bad.ok).toBe(false);
    expect(bad.lines.join("\n")).toMatch(/leak scanner \(github_token\)/);
    expect(bad.lines.join("\n")).not.toContain(SECRET);
    const run = await sessionRun(e.store, it.id);
    expect(run.input!.session!.notes.map((n) => n.text)).toEqual(["tried the parser first"]);
  });

  it("status prints the item, the run, the lease expiry and the last finish attempt", async () => {
    const e = await setup();
    const it = await item(e.store, 1);
    await start(e, it.id);
    const run = await sessionRun(e.store, it.id);
    let s = (await e.sessions.status()).lines.join("\n");
    expect(s).toContain(`item: ${it.id}`);
    expect(s).toContain(`run: ${run.id} (interactive), running, actor ${OWNER}`);
    expect(s).toContain(`lease expires: ${run.lease!.expires_at}`);
    expect(s).toContain("last finish: none yet");
    e.sandbox.changedFiles = ["README.md"];
    await e.sessions.finish();
    s = (await e.sessions.status(it.id)).lines.join("\n");
    expect(s).toMatch(/last finish: \S+ refused: scope: files outside the allowed paths: README\.md/);
  });
});

describe("session finish", () => {
  it("runs, in order, the scope gate, the size gate, the floor check and repo.test_command in the run folder", async () => {
    const e = await setup();
    const it = await item(e.store, 1);
    await start(e, it.id);
    e.sandbox.gitCalls = [];
    expect((await e.sessions.finish()).ok).toBe(true);
    const order = e.sandbox.gitCalls.filter((c) => c.startsWith("diff --name-only") || c.startsWith("diff --numstat"));
    expect(order).toEqual(["diff --name-only -z --no-renames basesha...HEAD", "diff --numstat -z -M basesha...HEAD"]);
    expect(e.sandbox.commands).toEqual(["npm test"]);
  });

  const failures: [string, (e: Env) => void, RegExp][] = [
    ["the scope gate", (e) => void (e.sandbox.changedFiles = ["src/app.ts", "README.md"]), /^ {2}- scope: files outside the allowed paths: README\.md$/m],
    ["the size gate", (e) => void (e.sandbox.numstat = `${gates().max_diff_lines + 1}\t0\tsrc/app.ts\0`), /^ {2}- size: the diff changes 1501 lines \(limit max_diff_lines = 1500\)/m],
    ["the floor check", (e) => void (e.sandbox.changedFiles = ["src/impl/broker/x.ts"]), /^ {2}- floor: src\/impl\/broker\/x\.ts need tier 4 \(the item is tier 2\)/m],
    ["repo.test_command", (e) => void (e.sandbox.exits["npm test"] = 1), /^ {2}- test: `npm test` exited 1$/m],
  ];
  for (const [what, arrange, reason] of failures) {
    it(`refuses when ${what} fails: lists the reason, leaves the session open and pushes nothing`, async () => {
      const e = await setup();
      const it = await item(e.store, 1);
      await start(e, it.id);
      arrange(e);
      const r = await e.sessions.finish();
      expect(r.ok).toBe(false);
      expect(r.lines[0]).toMatch(/session stays open and nothing was pushed/);
      expect(r.lines.join("\n")).toMatch(reason);
      expect(e.broker.calls).toEqual([]);
      const run = await sessionRun(e.store, it.id);
      expect(run).toMatchObject({ status: "running", input: { session: { last_finish: { ok: false } } } });
      expect(e.files.records.has(it.id)).toBe(true);
    });
  }

  it("lists every failing gate at once", async () => {
    const e = await setup();
    const it = await item(e.store, 1);
    await start(e, it.id);
    e.sandbox.changedFiles = ["README.md", "src/impl/broker/x.ts"];
    e.sandbox.exits["npm test"] = 1;
    const reasons = (await e.sessions.finish()).lines.slice(1).map((l) => l.trim().split(":")[0]);
    expect(reasons).toEqual(["- scope", "- floor", "- test"]);
  });

  it("a floor hit is refused with the paths and the tier; the session stays open and no floor_blocked state is written", async () => {
    const e = await setup();
    const it = await item(e.store, 1);
    await start(e, it.id);
    e.sandbox.changedFiles = ["src/impl/broker/a.ts", "src/impl/broker/b.ts"];
    const r = await e.sessions.finish();
    expect(r.lines.join("\n")).toContain("floor: src/impl/broker/a.ts, src/impl/broker/b.ts need tier 4");
    await e.controller.tickRuns();
    const now = (await e.store.getWorkItem(it.id))!;
    expect(now).toMatchObject({ stage: "RUNNING", blocked_on: "none", blocked_reason: null, tier: 2 });
    expect((await e.store.listStateChanges(it.id)).map((c) => c.reason)).not.toContain("floor_blocked");
    expect((await sessionRun(e.store, it.id)).status).toBe("running");
  });

  it("pushes and opens the PR only through the broker; the session code runs no git push of its own", async () => {
    const e = await setup();
    const it = await item(e.store, 1);
    await start(e, it.id);
    expect((await e.sessions.finish()).lines).toEqual(["finished: PR #42; the factory reviews it next"]);
    expect(e.broker.calls.map((c) => c.name)).toEqual(["github.push_branch", "github.open_pr"]);
    expect(e.broker.calls[0]!.args).toEqual({ workdir: "/wt/1", branch: `factory/${it.id}`, base_ref: "main" });
    expect(e.broker.calls[0]!.ctx).toMatchObject({ work_item_id: it.id, lease_token: 1 });
    expect(e.sandbox.gitCalls.some((c) => /(^| )push( |$)/.test(c))).toBe(false);
    expect(e.sandbox.commands.some((c) => c.includes("push"))).toBe(false);
  });

  it("flow: start, finish, then REVIEW with pr_number set and a review run queued", async () => {
    const e = await setup();
    const it = await item(e.store, 1);
    await start(e, it.id);
    await e.sessions.finish();
    const run = await sessionRun(e.store, it.id);
    expect(run.status).toBe("succeeded");
    await e.controller.tickRuns();
    const after = (await e.store.getWorkItem(it.id))!;
    expect(after).toMatchObject({ stage: "REVIEW", pr_number: 42, pr_files: ["src/app.ts"] });
    expect((await e.store.listStateChanges(it.id)).at(-1)).toMatchObject({ reason: "session_finished", detail: { run_id: run.id, actor_id: OWNER } });
    const reviews = (await e.store.listRuns(it.id)).filter((r) => r.kind === "review");
    expect(reviews).toEqual([expect.objectContaining({ status: "queued" })]);
    expect((await e.store.getRun(run.id))!.acknowledged_at).not.toBeNull();
    expect(e.sandbox.destroyedIds).toEqual(["sbx1"]);
  });

  it("running finish again after a success creates no second PR and no second review run", async () => {
    const e = await setup();
    const it = await item(e.store, 1);
    const started = await start(e, it.id);
    await e.sessions.finish();
    await e.controller.tickRuns();
    // The local record went with the success; put it back as a stale copy would be.
    await e.files.write(started.record!);
    const again = await e.sessions.finish();
    expect(again.ok).toBe(false);
    expect(again.lines.join("\n")).toMatch(/not open \(succeeded\)/);
    await e.controller.tickRuns();
    expect(e.broker.calls.filter((c) => c.name === "github.open_pr")).toHaveLength(1);
    expect((await e.store.listRuns(it.id)).filter((r) => r.kind === "review")).toHaveLength(1);
  });

  it("running finish again after a failed push creates one PR and one review run", async () => {
    const e = await setup();
    const it = await item(e.store, 1);
    await start(e, it.id);
    e.broker.responses["github.push_branch"] = [{ ok: false, error_code: "push_failed", message: "rejected" }];
    const failed = await e.sessions.finish();
    expect(failed.lines.join("\n")).toContain("push: push_failed: rejected");
    expect((await sessionRun(e.store, it.id)).status).toBe("running");
    await e.controller.tickRuns();
    expect((await e.sessions.finish()).ok).toBe(true);
    await e.controller.tickRuns();
    await e.controller.tickRuns();
    expect(e.broker.calls.filter((c) => c.name === "github.open_pr")).toHaveLength(1);
    expect((await e.store.listRuns(it.id)).filter((r) => r.kind === "review")).toHaveLength(1);
    expect((await e.store.getWorkItem(it.id))!.stage).toBe("REVIEW");
  });
});

describe("session end without a PR", () => {
  it("abandon ends the run failed with abandoned, keeps the remote branch and releases the item", async () => {
    const e = await setup();
    const it = await item(e.store, 1);
    await start(e, it.id);
    // A finish whose push landed but whose PR failed: the branch is on the remote.
    e.broker.responses["github.open_pr"] = [{ ok: false, error_code: "pr_failed", message: "no" }];
    await e.sessions.finish();
    expect(e.broker.remote.has(`factory/${it.id}`)).toBe(true);
    const r = await e.sessions.abandon();
    expect(r.ok).toBe(true);
    const run = await sessionRun(e.store, it.id);
    expect(run).toMatchObject({ status: "failed", outcome: { status: "failed", error_code: "abandoned" } });
    expect(e.broker.remote.has(`factory/${it.id}`)).toBe(true);
    expect(e.broker.calls.map((c) => c.name)).toEqual(["github.push_branch", "github.open_pr"]);
    await e.controller.tickRuns();
    expect(await e.store.getWorkItem(it.id)).toMatchObject({ stage: "RUNNING", blocked_on: "human", blocked_reason: "session_released" });
  });

  it("flow: an expired session lease is ended by the reaper as session_lost, never requeued, and the controller releases the item", async () => {
    const e = await setup();
    const it = await item(e.store, 1);
    await start(e, it.id);
    e.clock.advance(config.lease_ms + 1);
    await e.controller.tickReaper();
    const run = await sessionRun(e.store, it.id);
    expect(run).toMatchObject({ status: "failed", outcome: { error_code: "session_lost" } });
    expect((await e.store.listRuns(it.id)).filter((r) => r.status === "queued")).toEqual([]);
    await e.controller.tickRuns();
    expect(await e.store.getWorkItem(it.id)).toMatchObject({ stage: "RUNNING", blocked_on: "human", blocked_reason: "session_released" });
  });

  it("a released item is RUNNING, blocked on a human with session_released and no run queued; the next start succeeds", async () => {
    const e = await setup();
    const it = await item(e.store, 1);
    await start(e, it.id);
    await e.sessions.abandon();
    await e.controller.tickRuns();
    const released = (await e.store.getWorkItem(it.id))!;
    expect(released).toMatchObject({ stage: "RUNNING", blocked_on: "human", blocked_reason: "session_released" });
    expect((await e.store.listRuns(it.id)).filter((r) => r.status === "queued" || r.status === "running")).toEqual([]);
    const again = await start(e, it.id);
    expect(again.ok).toBe(true);
    expect(await e.store.getWorkItem(it.id)).toMatchObject({ stage: "RUNNING", blocked_on: "none", blocked_reason: null });
    expect((await e.store.listRuns(it.id)).filter((r) => r.kind === "interactive" && r.status === "running")).toHaveLength(1);
  });

  it("keepAlive renews the lease each heartbeat and stops when the session ends", async () => {
    const e = await setup();
    const it = await item(e.store, 1);
    const { record } = await start(e, it.id);
    const stop = new AbortController();
    const alive = e.sessions.keepAlive(record!, stop.signal);
    await new Promise((r) => setImmediate(r));
    e.clock.advance(config.heartbeat_ms);
    await new Promise((r) => setTimeout(r, 10));
    const run = await sessionRun(e.store, it.id);
    expect(Date.parse(run.lease!.expires_at)).toBe(e.clock.now().getTime() + config.lease_ms);
    await e.sessions.abandon();
    e.clock.advance(config.heartbeat_ms);
    expect(await alive).toBe("ended");
  });
});

describe("tokens and transcript", () => {
  it("--tokens sets the run's latest total, added to the item's token_cost once, when the run ends", async () => {
    const e = await setup();
    const it = await item(e.store, 1, { token_cost: 1000 });
    await start(e, it.id);
    await e.sessions.note("first part", { tokens: 100 });
    await e.sessions.note("", { tokens: 300 });
    expect((await sessionRun(e.store, it.id)).tokens).toBe(300);
    await e.controller.tickRuns();
    expect((await e.store.getWorkItem(it.id))!.token_cost).toBe(1000);
    await e.sessions.finish({ tokens: 450 });
    await e.controller.tickRuns();
    await e.controller.tickRuns();
    expect((await e.store.getWorkItem(it.id))!.token_cost).toBe(1450);
    for (const bad of [-1, 1.5, Number.NaN]) expect((await e.sessions.note("x", { tokens: bad })).ok).toBe(false);
  });

  it("an abandoned or lost session's total counts once too", async () => {
    const e = await setup();
    const a = await item(e.store, 1);
    await start(e, a.id);
    await e.sessions.abandon({ tokens: 70 });
    const b = await item(e.store, 2, { allowed_paths: ["docs/"] });
    await start(e, b.id);
    await e.sessions.note("", { tokens: 30 });
    e.clock.advance(config.lease_ms + 1);
    await e.controller.tickReaper();
    await e.controller.tickRuns();
    await e.controller.tickRuns();
    expect((await e.store.getWorkItem(a.id))!.token_cost).toBe(70);
    expect((await e.store.getWorkItem(b.id))!.token_cost).toBe(30);
  });

  it("--transcript on start or note stores an http or https URL after the egress scan", async () => {
    const e = await setup();
    const it = await item(e.store, 1);
    expect((await start(e, it.id, { transcript: "ftp://x/y" })).lines.join("\n")).toMatch(/http or https/);
    expect((await start(e, it.id, { transcript: `https://example.com/?t=${SECRET}` })).lines.join("\n")).toMatch(/leak scanner/);
    expect(await e.store.listRuns(it.id)).toEqual([]);
    await start(e, it.id, { transcript: "https://example.com/t/1" });
    expect((await sessionRun(e.store, it.id)).transcript_url).toBe("https://example.com/t/1");
    await e.sessions.note("moved", { transcript: "http://example.com/t/2" });
    expect((await sessionRun(e.store, it.id)).transcript_url).toBe("http://example.com/t/2");
    expect((await e.sessions.note("x", { transcript: "javascript:alert(1)" })).ok).toBe(false);
    expect((await sessionRun(e.store, it.id)).transcript_url).toBe("http://example.com/t/2");
  });

  it("a scanner with known secret values refuses a note naming one", async () => {
    const e = await setup();
    const scanner = new PatternEgressScanner(async () => ["hunter2-very-secret-value"]);
    const sessions = new Sessions({
      store: e.store, sandbox: e.sandbox, broker: e.broker, scanner, clock: e.clock, config, toolEnv: {}, files: e.files,
      issue: async () => null, owner: "session:host:2" as WorkerId,
    });
    const it = await item(e.store, 1);
    await sessions.start({ ref: it.id, actor: OWNER });
    expect((await sessions.note("the value is hunter2-very-secret-value")).ok).toBe(false);
    expect((await sessionRun(e.store, it.id)).input!.session!.notes).toEqual([]);
  });
});
