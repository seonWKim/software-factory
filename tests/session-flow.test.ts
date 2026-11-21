import { mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { FactoryConfig } from "../src/core/config.js";
import { ControllerRole } from "../src/runtime/roles/controller-role.js";
import { RESERVATION_MS, Sessions, WAIT_POLL_MS, parseTarget } from "../src/core/session.js";
import type { LocalRoute } from "../src/core/worker-deps.js";
import { settingValues } from "../src/core/settings.js";
import type { Run, RunKind, Tier, UserId, WorkItem, WorkItemId, WorkerId } from "../src/core/types.js";
import { FakeClock } from "../src/impl/clock/fake-clock.js";
import { STORE_BRANCH } from "../src/interfaces/tool-broker.js";
import { FileSessionFiles, githubIssues, parseSessionArgs, runSession } from "../src/session-cmd.js";
import { FakeAuth, FakeIssues, FakeSandbox, MemorySessionFiles } from "./helpers/fakes/runner.js";
import { FakeBroker } from "./helpers/fakes/broker.js";
import { FakeForge } from "./helpers/fakes/forge.js";
import { FakeSource } from "./helpers/fakes/source.js";
import { alice, cleanScanner, config, issueRef, mallory, silent, waitFor } from "./helpers/fakes/config.js";
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

async function harness(o: { local?: LocalRoute } = {}) {
  const clock = new FakeClock();
  const { store } = await newStore(clock);
  const cfg: FactoryConfig = config;
  const sandbox = new FakeSandbox();
  sandbox.changedFiles = ["src/a/x.ts"];
  const broker = new FakeBroker();
  const files = new MemorySessionFiles();
  const issues = new FakeIssues({ 7: { source: issueRef(7), title: "Session issue", body: "the body", author: mallory } });
  const deps = {
    store, sandbox, broker, scanner: cleanScanner, auth: new FakeAuth(), clock, config: cfg, log: silent, files, issues, toolEnv: {}, owner: "session:host:1", ...o,
  };
  const sessions = new Sessions(deps);
  const source = new FakeSource();
  // Outbound's pushes and PR opens land in `broker.calls` under the broker tools' names (RFC 0015 M7), with no ctx.
  const forge = new FakeForge(source, broker.calls);
  const controller = new ControllerRole({ store, source, forge, auth: new FakeAuth(), clock, config: cfg, log: silent, scanner: cleanScanner });
  /** The controller applies the finished run, then outbound delivers the push and the PR, and the controller applies that. */
  const deliver = async () => {
    await controller.tickRuns();
    await controller.tickOutbox();
  };
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
  return { clock, store, cfg, sandbox, broker, forge, files, issues, sessions, deps, controller, deliver, running, enqueue, snapshot, item, runs, start };
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

    it("for a CLOSED item, an item in REVIEW, a READY item (naming /approve), no allowed_paths, or not the owner", async () => {
      const h = await harness();
      expect(await unchanged(h, (await h.running(1, ["src/a/"], 2, { stage: "CLOSED", close_reason: "wont_do" })).id)).toMatch(/closed/);
      expect(await unchanged(h, (await h.running(2, ["src/a/"], 2, { stage: "REVIEW", change_ref: "5" })).id)).toMatch(/in review \(PR #5\)/);
      const ready = await h.running(3, ["src/a/"], 2, { stage: "READY", blocked_on: "human", blocked_reason: "spec_pending" });
      expect(await unchanged(h, ready.id)).toContain("`/approve`");
      expect(await unchanged(h, (await h.running(4, [])).id)).toMatch(/no allowed_paths/);
      expect(await unchanged(h, (await h.running(5)).id, {}, mallory)).toMatch(/only the owner may send this command/);
      expect(h.files.files.size).toBe(0);
    });

    it("for an item with a running implement-type run, or an open session", async () => {
      const h = await harness();
      const it0 = await h.running(1);
      await h.enqueue(it0, "implement", "i1");
      await h.store.claimRun({ worker_id: W1, kinds: ["implement"], lease_ms: 60_000 });
      expect(await unchanged(h, it0.id)).toMatch(/running implement run/);
      const it2 = await h.running(3, ["src/c/"]);
      expect((await h.start(it2.id)).ok).toBe(true);
      expect(await unchanged(h, it2.id)).toMatch(/already has an open session/);
    });

    it("never: a queued implement or update run is cancelled and the interactive task takes the item over", async () => {
      const h = await harness();
      for (const [n, kind] of [[1, "implement"], [2, "update"]] as const) {
        const it0 = await h.running(n, [`src/t${n}/`]);
        await h.enqueue(it0, kind, `${kind}-${n}`);
        const r = await h.start(it0.id);
        expect(r.ok).toBe(true);
        expect(r.lines.join("\n")).toMatch(/took over the item: cancelled the queued worker run run_/);
        const runs = await h.store.listRuns(it0.id);
        expect(runs.find((x) => x.kind === kind)?.status).toBe("cancelled");
        expect(runs.find((x) => x.kind === "interactive")?.status).toBe("running");
        // No worker can claim the branch afterwards.
        expect(await h.store.claimRun({ worker_id: W1, kinds: [kind], lease_ms: 60_000 })).toBeNull();
      }
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

    it("when another item's running run overlaps: its queued implement run stays queued, no attempt and no state change", async () => {
      const h = await harness();
      const other = await h.running(2, ["src/a/x.ts"]);
      await h.enqueue(other, "implement", "i2");
      await h.store.claimRun({ worker_id: W1, kinds: ["implement"], lease_ms: 60_000 });
      const it0 = await h.running(1, ["src/a/"]);
      await h.enqueue(it0, "implement", "i1");
      const before = await h.item(it0.id);
      const changes = (await h.store.listStateChanges(it0.id)).length;
      const r = await h.start(it0.id);
      expect(r.ok).toBe(false);
      expect(r.lines.join("\n")).toMatch(/overlaps the allowed_paths/);
      expect((await h.runs(it0.id, "implement")).map((x) => [x.status, x.attempt, x.outcome])).toEqual([["queued", 0, null]]);
      expect((await h.item(it0.id)).version).toBe(before.version);
      expect(await h.store.listStateChanges(it0.id)).toHaveLength(changes);
      await h.controller.tickRuns(); // nothing finished, so nothing counts toward max_attempts
      expect(await h.item(it0.id)).toMatchObject({ version: before.version, blocked_on: "none" });
    });

    it("for a running interactive or implement run: the item's queued runs stay queued, in the store's own check too", async () => {
      const h = await harness();
      const busy = await h.running(1, ["src/t1/"]);
      await h.enqueue(busy, "implement", "i1");
      await h.store.claimRun({ worker_id: W1, kinds: ["implement"], lease_ms: 60_000 });
      await h.enqueue(busy, "update", "u1");
      const open = await h.running(2, ["src/t2/"]);
      expect((await h.start(open.id)).ok).toBe(true);
      await h.enqueue(open, "implement", "i2");
      for (const [it0, why] of [[busy, "implement_run"], [open, "session_open"]] as const) {
        expect(await unchanged(h, it0.id)).toMatch(/running implement run|already has an open session/);
        const cur = await h.item(it0.id);
        const r = await h.store.startSession({
          id: it0.id, expected_version: cur.version, actor: { kind: "user", id: "github:1" as UserId }, patch: {}, reason: "session_started", detail: {}, owner: "o", lease_ms: 60_000, transcript_url: null,
        });
        expect(r).toMatchObject({ ok: false, reason: why });
        expect((await h.runs(it0.id)).filter((x) => x.status === "queued")).toHaveLength(1);
      }
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


  it("a run cancelled by an accepted takeover is no attempt: taking over more often than max_attempts never holds the item", async () => {
    const h = await harness();
    const it0 = await h.running(1);
    await h.enqueue(it0, "implement", "i1");
    for (let n = 0; n <= settingValues(h.cfg.project.key, h.cfg.settings).max_attempts; n++) {
      const queued = (await h.runs(it0.id, "implement")).filter((x) => x.status === "queued");
      expect(queued).toHaveLength(1);
      const r = await h.start(it0.id);
      expect(r.ok).toBe(true);
      const cancelled = (await h.store.getRun(queued[0]!.id))!;
      expect(cancelled).toMatchObject({ status: "cancelled", outcome: { status: "failed", error_code: "interactive_takeover", infra: false } });
      // One state change: the start itself, naming the run it took over.
      expect((await h.store.listStateChanges(it0.id)).at(-1)).toMatchObject({ reason: "session_started", detail: { taken_over: cancelled.id } });
      await h.controller.tickRuns();
      const applied = (await h.store.listStateChanges(it0.id)).find((c) => c.detail?.run_id === cancelled.id && c.reason !== "session_started");
      expect(applied?.detail).toMatchObject({ task_failures: 0 });
      expect((await h.item(it0.id)).blocked_reason).not.toBe("max_attempts");
      await h.sessions.abandon({ id: it0.id });
      await h.controller.tickRuns();
    }
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

// `session start --spec f --wait` (design 05-interactive-sessions, 2026-11-21): a NEW item whose files a running run
// holds is reserved for the waiting session, which tries again every WAIT_POLL_MS of the injected Clock.
describe("session start --wait", () => {
  /** `h` with a NEW item #1 (triage queued) and item #2's implement run running on src/a/x.ts, overlapping SPEC's src/a/. */
  async function busy(o: { local?: LocalRoute } = {}, source?: WorkItem["source"]) {
    const h = await harness(o);
    const other = await h.running(2, ["src/a/x.ts"]);
    await h.enqueue(other, "implement", "i2");
    const run = (await h.store.claimRun({ worker_id: W1, kinds: ["implement"], lease_ms: 60_000 }))!;
    const { item: it0 } = await h.store.createWorkItem({ ...issue(1), ...(source ? { source } : {}) }, system, { enqueue: { kind: "triage", idempotency_key: "t1" } });
    let sleeps = 0;
    const sleep = h.clock.sleep.bind(h.clock);
    h.clock.sleep = (ms, signal) => (sleeps++, sleep(ms, signal));
    const printed: string[] = [];
    const stop = new AbortController();
    const wait = (sessions = h.sessions) => sessions.start({ target: it0.id, person: alice, spec: SPEC_TEXT, wait: true, signal: stop.signal, progress: (l) => printed.push(l) });
    /** Waits until the start sleeps for the `n`th time. */
    const slept = (n: number) => waitFor(() => sleeps >= n, `sleep ${n}`);
    const endOther = () => h.store.completeRun(run.id, run.lease!.token, { status: "failed", error_code: "x", detail: "", infra: false });
    return { ...h, it0, run, printed, stop, wait, slept, endOther };
  }

  it("waits instead of refusing, reserves the item for this session, and no worker claims its triage run", async () => {
    const h = await busy();
    const p = h.wait();
    await h.slept(1);
    expect(h.printed.join("\n")).toMatch(/waiting: running work on o\/r#2 .* overlaps the allowed_paths: src\/a\/x\.ts/);
    expect(h.printed.join("\n")).toContain("reserved for this session until 2026-01-01T02:00:00.000Z, so triage skips it");
    expect(await h.store.getReservation(h.it0.id)).toMatchObject({ owner: "session:host:1", expires_at: "2026-01-01T02:00:00.000Z" });
    for (const worker_id of [W1, "w2" as WorkerId]) expect(await h.store.claimRun({ worker_id, kinds: ["triage"], lease_ms: 60_000 })).toBeNull();
    expect(await h.item(h.it0.id)).toMatchObject({ stage: "NEW", blocked_on: "none", version: 1 });
    h.stop.abort();
    await p;
  });

  it("does not start while the files stay busy, then starts on the first check after the running run ends", async () => {
    const h = await busy();
    const p = h.wait();
    await h.slept(1);
    for (let n = 2; n <= 4; n++) {
      h.clock.advance(WAIT_POLL_MS);
      await h.slept(n);
      expect(await h.runs(h.it0.id, "interactive")).toEqual([]);
      expect(await h.store.getReservation(h.it0.id)).not.toBeNull();
    }
    expect(h.sandbox.created).toHaveLength(1); // one run folder for the whole wait
    await h.endOther();
    h.clock.advance(WAIT_POLL_MS);
    const r = await p;
    expect(r.ok).toBe(true);
    expect((await h.runs(h.it0.id)).map((x) => [x.kind, x.status])).toEqual([["triage", "cancelled"], ["interactive", "running"]]);
    expect(await h.item(h.it0.id)).toMatchObject({ stage: "RUNNING", allowed_paths: ["src/a/"], done_criteria: ["the widget works"] });
    expect(await h.store.getReservation(h.it0.id)).toBeNull();
    expect(h.files.files.size).toBe(1);
  });

  it("a reservation older than 2 hours ends the wait: no reservation is left and triage claims the item", async () => {
    const h = await busy();
    const p = h.wait();
    await h.slept(1);
    for (let n = 2; n * WAIT_POLL_MS <= RESERVATION_MS + WAIT_POLL_MS; n++) {
      h.clock.advance(WAIT_POLL_MS);
      if (n * WAIT_POLL_MS <= RESERVATION_MS) await h.slept(n);
    }
    const r = await p;
    expect(r).toMatchObject({ ok: false });
    expect(r.lines.join("\n")).toMatch(/the reservation ended .* the item goes to triage as usual/);
    expect(await h.store.getReservation(h.it0.id)).toBeNull();
    expect(h.sandbox.destroyed).toBe(1);
    expect((await h.store.claimRun({ worker_id: W1, kinds: ["triage"], lease_ms: 60_000 }))?.work_item_id).toBe(h.it0.id);
  });

  it("another session's start on the reserved item is refused naming the reservation, with or without --wait", async () => {
    const h = await busy();
    const p = h.wait();
    await h.slept(1);
    const other = new Sessions({ ...h.deps, owner: "session:host:2" });
    const naming = /reserved by a waiting session \(session:host:1\) until 2026-01-01T02:00:00\.000Z/;
    expect((await other.start({ target: h.it0.id, person: alice, spec: SPEC_TEXT })).lines.join("\n")).toMatch(naming);
    expect((await other.start({ target: h.it0.id, person: alice, spec: SPEC_TEXT, wait: true })).lines.join("\n")).toMatch(naming);
    expect(await h.runs(h.it0.id, "interactive")).toEqual([]);
    expect(await h.store.getReservation(h.it0.id)).toMatchObject({ owner: "session:host:1" });
    h.stop.abort();
    await p;
  });

  it("stopping the wait (Ctrl-C) releases the reservation now and removes the run folder", async () => {
    const h = await busy();
    const p = h.wait();
    await h.slept(1);
    h.stop.abort();
    const r = await p;
    expect(r.ok).toBe(false);
    expect(r.lines.join("\n")).toMatch(/stopped waiting: the reservation is released/);
    expect([await h.store.getReservation(h.it0.id), h.sandbox.destroyed, h.files.files.size]).toEqual([null, 1, 0]);
    expect((await h.store.claimRun({ worker_id: W1, kinds: ["triage"], lease_ms: 60_000 }))?.work_item_id).toBe(h.it0.id);
  });

  it("starts at once with no reservation left when the files are free", async () => {
    const h = await busy();
    await h.endOther();
    expect((await h.wait()).ok).toBe(true);
    expect([await h.store.getReservation(h.it0.id), h.printed]).toEqual([null, []]);
  });

  it("--wait on an item that is not NEW, or with no --spec, is refused with today's message and reserves nothing", async () => {
    const h = await harness();
    const it0 = await h.running(1, ["src/t/"]);
    const r = await h.sessions.start({ target: it0.id, person: alice, spec: SPEC_TEXT, wait: true });
    expect(r.lines.join("\n")).toContain("--spec applies only to a NEW item");
    const { item: fresh } = await h.store.createWorkItem(issue(3), system, { enqueue: { kind: "triage", idempotency_key: "t3" } });
    const n = await h.sessions.start({ target: fresh.id, person: alice, wait: true });
    expect([n.ok, n.lines.join("\n")]).toEqual([false, "refused: the item has no spec yet: pass --spec <file>, or wait for triage and `/approve`"]);
    expect(await h.sessions.start({ target: it0.id, person: alice, wait: true })).toMatchObject({ ok: false });
    expect([await h.store.getReservation(it0.id), await h.store.getReservation(fresh.id), await h.runs(it0.id, "interactive")]).toEqual([null, null, []]);
  });

  it("a local item reserves and starts through the local route with no forge call", async () => {
    const broker = new FakeBroker();
    broker.tools = broker.tools.filter((t) => t.name === STORE_BRANCH); // the local broker has no preflight
    broker.toForge = false;
    const sandbox = new FakeSandbox();
    const h = await busy({ local: { broker, sandbox } }, { type: "local", id: "local-1", link: "local:local-1" });
    const p = h.wait();
    await h.slept(1);
    expect(await h.store.getReservation(h.it0.id)).not.toBeNull();
    await h.endOther();
    h.clock.advance(WAIT_POLL_MS);
    expect((await p).ok).toBe(true);
    expect(await h.item(h.it0.id)).toMatchObject({ stage: "RUNNING" });
    expect(sandbox.created).toHaveLength(1);
    expect([h.sandbox.created, h.broker.calls, h.broker.preflights, h.broker.stores, h.issues.asked]).toEqual([[], [], [], [], []]);
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

  it("a failed test command names its failing files and shows its output; only the reason is stored", async () => {
    let h = await started();
    h.sandbox.exits["npm test"] = 1;
    h.sandbox.stdouts["npm test"] = " FAIL  tests/a.test.ts > widget > renders\n FAIL  tests/b.test.ts > other\n FAIL  tests/a.test.ts > widget > again\nAssertionError: expected 1 to be 2\n";
    let out = await refusedOpen(h);
    // The files line comes before the refusal, the output after its reasons.
    expect(out).toMatch(/^failing test files: tests\/a\.test\.ts, tests\/b\.test\.ts\nfinish refused;[\s\S]*- tests: `npm test` exited 1\ntest output \(last lines\):\n {5}FAIL {2}tests\/a\.test\.ts > widget > renders[\s\S]*\n {4}AssertionError: expected 1 to be 2$/);
    expect((await h.runs(h.it0.id, "interactive"))[0]!.last_finish?.reasons).toEqual(["tests: `npm test` exited 1"]);

    h = await started();
    h.sandbox.exits["npm test"] = 1;
    h.sandbox.stdouts["npm test"] = "Error: Cannot find module 'x'\n";
    out = await refusedOpen(h);
    expect(out).not.toContain("failing test files");
    expect(out).toContain("    Error: Cannot find module 'x'");

    h = await started();
    h.sandbox.exits["npm test"] = 1;
    h.sandbox.stdouts["npm test"] = ` FAIL  tests/a.test.ts > leaks\nkey ${AWS_SHAPED}\n`;
    out = await refusedOpen(h);
    expect(out).toContain("did not pass the egress scan");
    expect(out).not.toContain(AWS_SHAPED);
    expect(out).not.toContain("failing test files");
  });

  it("a floor hit is refused with the paths and the required tier; the session stays open and no floor_blocked is written", async () => {
    const h = await started(["src/"]);
    h.sandbox.changedFiles = ["src/impl/broker/x.ts"];
    expect(await refusedOpen(h)).toContain("floor: src/impl/broker/x.ts need tier 4 (the item is tier 2)");
    expect((await h.store.listStateChanges(h.it0.id)).map((c) => c.reason)).not.toContain("floor_blocked");
    expect(await h.item(h.it0.id)).toMatchObject({ stage: "RUNNING", blocked_on: "none", tier: 2 });
  });

  it("stores the branch through the broker; outbound pushes it and opens the PR, then the item goes to REVIEW with a review run", async () => {
    const h = await started();
    await h.sessions.note({ text: "split the parser", tokens: 120 });
    expect((await h.sessions.finish({ tokens: 300 })).ok).toBe(true);
    const run = (await h.runs(h.it0.id, "interactive"))[0]!;
    const ctx = { run_id: run.id, work_item_id: h.it0.id, lease_token: 1 };
    // The session's only branch write is the store in the factory repo; it writes nothing to the forge (RFC 0015 M7).
    expect(h.broker.stores.map((c) => [c.name, c.ctx, c.args])).toEqual([[STORE_BRANCH, ctx, { workdir: "/wt/1", branch: `factory/${h.it0.id}`, base_ref: "main" }]]);
    expect(h.broker.calls).toEqual([]);
    // The item waits for the PR: a failed push holds it, and outbound's retry delivers both.
    h.forge.pushErrors = [new Error("network_unavailable: could not reach github.com")];
    await h.controller.tickRuns();
    expect(await h.item(h.it0.id)).toMatchObject({ stage: "RUNNING", blocked_on: "outbound", blocked_reason: "pr_pending" });
    h.clock.advance(h.cfg.retry_max_ms);
    await h.controller.tickOutbox();
    expect(h.broker.calls.map((c) => [c.name, c.ctx])).toEqual([["forge.push_branch", undefined], ["forge.push_branch", undefined], ["forge.open_change", undefined]]);
    expect(h.forge.prOpens[0]!.body).toMatch(/split the parser[\s\S]*Closes #1/);
    expect(h.sandbox.gitCalls.some((c) => /(^| )push( |$)/.test(c))).toBe(false); // no git push of its own
    // The gates in order: scope, then size and floor (one numstat), then the test command.
    const at = (p: string) => h.sandbox.gitCalls.findIndex((c) => c.startsWith(p));
    expect([at("diff --name-only -z --no-renames basesha...HEAD") >= 0, at("diff --numstat -z -M basesha...HEAD") > at("diff --name-only"), h.sandbox.commands]).toEqual([true, true, ["npm test"]]);
    expect([run.status, h.files.files.size]).toEqual(["succeeded", 0]);
    for (let i = 0; i < 2; i++) await h.deliver(); // applied once
    expect(await h.item(h.it0.id)).toMatchObject({ stage: "REVIEW", change_ref: "42", token_cost: 300, pr_files: ["src/a/x.ts"] });
    expect((await h.runs(h.it0.id, "review")).map((x) => x.status)).toEqual(["queued"]);
    expect((await h.store.listStateChanges(h.it0.id)).map((c) => c.reason).slice(-2)).toEqual(["session_finished", "pr_delivered"]);
  });

  it("the PR outbound opened stores change_url from the open result", async () => {
    const h = await started();
    h.forge.prNumbers.set(`factory/${h.it0.id}`, 43);
    expect((await h.sessions.finish({ tokens: 300 })).ok).toBe(true);
    await h.deliver();
    expect(await h.item(h.it0.id)).toMatchObject({ stage: "REVIEW", change_ref: "43", change_url: h.forge.prRef(43).link });
  });

  it("finish again after a success, or after a refused store, creates no second PR and no second review run", async () => {
    const h = await started();
    h.broker.responses[STORE_BRANCH] = [{ ok: false, error_code: "push_failed", message: "rejected" }];
    expect((await h.sessions.finish({})).lines.join("\n")).toContain("push: push_failed: rejected");
    await h.deliver();
    expect((await h.item(h.it0.id)).stage).toBe("RUNNING");
    expect(h.broker.calls).toEqual([]);
    expect((await h.sessions.finish({})).ok).toBe(true);
    await h.deliver();
    expect((await h.sessions.finish({ id: h.it0.id })).ok).toBe(false);
    // The local record left behind by a crash between completion and its removal changes nothing either.
    const run = (await h.runs(h.it0.id, "interactive"))[0]!;
    await h.files.write({ work_item_id: h.it0.id, run_id: run.id, token: 1, branch: "b", folder: { id: "sbx1", workdir: "/wt/1", base_sha: "basesha" } });
    expect((await h.sessions.finish({})).ok).toBe(false);
    await h.deliver();
    expect(h.forge.pushes).toHaveLength(1);
    expect(h.forge.prOpens).toHaveLength(1);
    expect(await h.runs(h.it0.id, "review")).toHaveLength(1);
    expect((await h.item(h.it0.id)).stage).toBe("REVIEW");
  });
});

describe("session end without a PR", () => {
  const released = { stage: "RUNNING", blocked_on: "human", blocked_reason: "session_released" };

  it("abandon ends the run as failed `abandoned`, keeps the run folder, and the controller releases the item", async () => {
    const h = await started();
    const { it0 } = h;
    expect((await h.sessions.abandon({ tokens: 40 })).ok).toBe(true);
    expect((await h.runs(it0.id, "interactive"))[0]).toMatchObject({ status: "failed", outcome: { status: "failed", error_code: "abandoned" } });
    expect(h.sandbox.destroyed).toBe(0); // the run folder is kept too
    await h.controller.tickRuns();
    expect(await h.item(it0.id)).toMatchObject({ ...released, token_cost: 40 });
    expect((await h.runs(it0.id)).filter((x) => x.status === "queued")).toEqual([]);
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
    await h.deliver();
    expect(await h.item(it0.id)).toMatchObject({ stage: "REVIEW", change_ref: "42", token_cost: 1000 });
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
    for (const bad of [["finish", "--spec", "x"], ["start"], ["note"], ["push"], ["finish", "--wait"]]) expect(parseSessionArgs(bad)).toHaveProperty("error");
    expect(parseSessionArgs(["start", "wi_abc", "--spec", "s.json", "--wait"])).toEqual({ cmd: "start", target: "wi_abc", spec: "s.json", wait: true });
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

  it("runSession with --as maps the login to the GitHub account, keeps the lease until stopped, and finishes through the broker's store", async () => {
    const h = await harness();
    const it0 = await h.running(1);
    const replies: Record<string, unknown> = {
      "/users/alice": { id: 1 }, "/repos/o/r/issues/3": { title: "T", body: null, html_url: "https://github.com/o/r/issues/3", user: { id: 9 } },
      "/repos/o/r/issues/4": { title: "PR", user: { id: 9 }, pull_request: {} },
    };
    const github = { request: async <T>(_m: string, path: string): Promise<T> => (path in replies ? (replies[path] as T) : Promise.reject(new Error("404"))) };
    const printed: string[] = [];
    const stop = new AbortController();
    const identity = { user: "github:2" as UserId, from: "cli_user" as const };
    const deps = { sessions: h.sessions, identity, githubSource: true, github, readSpec: async () => SPEC_TEXT, print: (l: string) => printed.push(l), stop: stop.signal };
    const started = runSession(deps, { cmd: "start", target: it0.id, as: "alice" });
    await waitFor(async () => (await h.runs(it0.id, "interactive")).length === 1, "session start");
    expect(printed).toContain("run folder: /wt/1");
    stop.abort();
    expect(await started).toBe(0);
    expect(printed.at(-1)).toMatch(/stopped keeping the lease/);
    expect(await runSession({ ...deps, stop: new AbortController().signal }, { cmd: "finish" })).toBe(0);
    expect([h.broker.stores.map((c) => c.name), h.broker.calls]).toEqual([[STORE_BRANCH], []]);
    expect(await runSession(deps, { cmd: "start", target: "1", as: "nobody" })).toBe(1);
    const issues = githubIssues(github, { owner: "o", name: "r" });
    expect(await issues.issue(3)).toEqual({ source: { type: "github_issue", id: "o/r#3", link: "https://github.com/o/r/issues/3" }, title: "T", body: "", author: { provider: "github", subject: "9" } });
    expect([await issues.issue(4), await issues.issue(5)]).toEqual([null, null]);
  });

  it("runSession with no --as and the GitHub source off starts as the CLI identity with no GitHub call", async () => {
    const h = await harness();
    const it0 = await h.running(1);
    let calls = 0;
    const github = { request: async <T>(): Promise<T> => (calls++, Promise.reject(new Error("network_unavailable"))) };
    const stop = new AbortController();
    const deps = {
      sessions: h.sessions, identity: { user: "github:1" as UserId, from: "cli_user" as const }, githubSource: false, github,
      readSpec: async () => SPEC_TEXT, print: () => {}, stop: stop.signal,
    };
    const started = runSession(deps, { cmd: "start", target: it0.id });
    await waitFor(async () => (await h.runs(it0.id, "interactive")).length === 1, "session start");
    stop.abort();
    expect(await started).toBe(0);
    expect([(await h.runs(it0.id, "interactive"))[0]!.actor_id, calls]).toEqual(["github:1", 0]);
  });
});
