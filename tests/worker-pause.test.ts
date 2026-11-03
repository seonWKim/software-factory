import { describe, expect, it } from "vitest";
import type { Run, WorkItem, WorkerId } from "../src/core/types.js";
import { Worker } from "../src/core/worker.js";
import type { AgentRunResult, AgentRunSpec, AgentRunner } from "../src/interfaces/agent-runner.js";
import type { FactoryStore } from "../src/interfaces/factory-store.js";
import { NoKeepAwake } from "../src/impl/awake/no-keep-awake.js";
import { FakeClock } from "../src/impl/clock/fake-clock.js";
import { buildClaudeArgs } from "../src/impl/runner/claude-code-runner.js";
import {
  FakeBroker, FakeRunner, FakeSandbox, MemoryStorage, cleanScanner, config, pipeline, prompts, recordingLog, triageSpec, waitFor,
} from "./helpers/fakes.js";
import { issue, newStore, system } from "./helpers/store.js";

// Design §5 Pause: `workers pause <n>`, `workers pause --all` and `workers resume`, on a fake clock. A pause puts the
// run back in queued with paused_at, commits its WIP, writes a `paused:` handoff and pushes nothing. A resume on the
// same host reattaches the folder and resumes the session (`--resume`); anywhere else it starts a new session from
// the WIP commit and the handoff note.

const BY = "github:1";
const { tick_ms, heartbeat_ms, lease_ms } = config;
const STEPS = ["read the spec", "edit the worker", "edit the store", "run the tests", "commit the work"];
const TOKENS_PER_STEP = 1000;
const IMPLEMENTED = { summary: "the summary", next_steps: "the next steps" };
const REVIEWED = { verdict: "pass", tier: 2, findings: [], summary: "s" };

interface Call {
  spec: AgentRunSpec;
  /** The `claude -p` arguments the Claude Code runner would build for this call. */
  args: string[];
  transcript: string;
  tokens: number;
  status: AgentRunResult["status"];
}

/**
 * A scripted agent with Claude-Code-like sessions: each step costs TOKENS_PER_STEP, a stored session remembers how
 * many steps it finished, and `--resume` continues from there. `holdAt`: the next call waits after that many steps
 * until the test releases it or the run's signal aborts (a lease loss or a pause).
 */
class SessionRunner implements AgentRunner {
  calls: Call[] = [];
  sessions = new Map<string, number>();
  removed: string[] = [];
  holdAt: number | null = null;
  held = false;
  fail = false;
  private release: (() => void) | null = null;

  constructor(private readonly steps: readonly string[] = STEPS) {}

  async run(spec: AgentRunSpec): Promise<AgentRunResult> {
    const args = buildClaudeArgs(spec, "m");
    const id = spec.session?.id ?? null;
    let done = spec.session?.resume ? (this.sessions.get(id!) ?? 0) : 0;
    const lines: string[] = [];
    let tokens = 0;
    const result = (status: AgentRunResult["status"], extra: Partial<AgentRunResult> = {}): AgentRunResult => {
      const transcript = lines.join("\n");
      this.calls.push({ spec, args, transcript, tokens, status });
      return { status, output: null, transcript, usage: { input_tokens: tokens, output_tokens: 0, cost_usd: null }, ...extra };
    };
    while (done < this.steps.length) {
      if (this.holdAt === done && !spec.signal.aborted) {
        this.holdAt = null;
        this.held = true;
        await new Promise<void>((resolve) => {
          this.release = resolve;
          spec.signal.addEventListener("abort", () => resolve(), { once: true });
        });
        this.held = false;
      }
      if (spec.signal.aborted) return result("aborted", { last_note: `next: ${this.steps[done]}` });
      lines.push(`step: ${this.steps[done]}`);
      tokens += TOKENS_PER_STEP;
      done++;
      if (id) this.sessions.set(id, done);
    }
    if (this.fail) return result("failed", { error: "boom" });
    return result("completed", { output: spec.role === "review" ? REVIEWED : IMPLEMENTED });
  }

  go(): void {
    this.release?.();
  }

  async hasSession(id: string): Promise<boolean> {
    return this.sessions.has(id);
  }

  async removeSession(id: string): Promise<void> {
    this.sessions.delete(id);
    this.removed.push(id);
  }
}

/** One store, broker and shared storage; one fake sandbox per host. */
async function world() {
  const clock = new FakeClock();
  const { store } = await newStore(clock);
  const broker = new FakeBroker();
  const storage = new MemoryStorage();
  const log = recordingLog();
  const runner = new SessionRunner();
  const hosts = { hostA: new FakeSandbox(), hostB: new FakeSandbox() };
  const worker = (id: string, sandbox: FakeSandbox, r: AgentRunner = runner) =>
    new Worker({
      id: id as WorkerId, store, sandbox, runner: r, broker, storage, clock, config, prompts, log,
      scanner: cleanScanner, toolEnv: {}, awake: new NoKeepAwake(),
    });
  return { clock, store, broker, storage, log, runner, hosts, worker };
}

async function implementItem(store: FactoryStore, n: number): Promise<WorkItem> {
  return (await store.createWorkItem(issue(n), system, { enqueue: { kind: "implement", idempotency_key: `i${n}` } })).item;
}

const onlyRun = async (store: FactoryStore, item: WorkItem): Promise<Run> => (await store.listRuns(item.id))[0]!;
const flag = (args: string[], name: string) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const forgeWrites = (broker: FakeBroker) => broker.calls.filter((c) => c.name === "github.push_branch" || c.name === "github.open_pr");

/** Starts `w` on its implement run, holds the agent after `at` steps, pauses `w`'s host's run, and waits for the pause. */
async function pauseMidRun(w: Awaited<ReturnType<typeof world>>, worker: Worker, item: WorkItem, at = 2) {
  w.hosts.hostA.status = " M src/core/worker.ts\0";
  w.hosts.hostA.commitHead = "wip1";
  w.runner.holdAt = at;
  const tick = worker.tick();
  await waitFor(() => w.runner.held, "the agent to reach the hold");
  expect((await w.store.pauseWorkers({ count: 1 }, BY)).paused).toEqual([worker.id]);
  const asked = w.clock.now().getTime();
  w.clock.advance(tick_ms);
  expect(await tick).toBe(true);
  const run = await onlyRun(w.store, item);
  return { run, asked };
}

describe("workers pause <n>", () => {
  it("with five runs in flight pauses the two that started last, back in queued within one tick_ms; the others keep running", async () => {
    const clock = new FakeClock();
    const { store } = await newStore(clock);
    const sandbox = new FakeSandbox();
    const broker = new FakeBroker();
    const releases = new Map<string, () => void>();
    const runner = new FakeRunner({
      implement: (spec) =>
        new Promise<Partial<AgentRunResult>>((resolve) => {
          releases.set(spec.run_id, () => resolve({ output: IMPLEMENTED }));
          spec.signal.addEventListener("abort", () => resolve({ status: "aborted" }), { once: true });
        }),
    });
    const workers = Array.from({ length: 5 }, (_, i) => new Worker({
      id: `hostA:1:${i}` as WorkerId, store, sandbox, runner, broker, storage: new MemoryStorage(), clock, config, prompts,
      log: recordingLog(), scanner: cleanScanner, toolEnv: {}, awake: new NoKeepAwake(),
    }));
    const items = [];
    for (let i = 1; i <= 5; i++) items.push(await implementItem(store, i));
    const ticks: Promise<boolean>[] = [];
    for (const w of workers) {
      clock.advance(1);
      ticks.push(w.tick());
      await waitFor(() => runner.specs.length === ticks.length, "the run to start");
    }

    expect((await store.pauseWorkers({ count: 2 }, BY)).paused).toEqual([workers[4]!.id, workers[3]!.id]);
    const asked = clock.now().getTime();
    clock.advance(tick_ms);
    await Promise.all([ticks[3], ticks[4]]);

    const runs = await Promise.all(items.map((it) => onlyRun(store, it)));
    for (const r of runs.slice(3)) {
      expect(r).toMatchObject({ status: "queued", paused_by: BY, attempt: 1, outcome: null, lease: null });
      expect(new Date(r.paused_at!).getTime() - asked).toBeLessThanOrEqual(tick_ms);
    }
    for (const r of runs.slice(0, 3)) expect(r).toMatchObject({ status: "running", paused_at: null });

    // The paused workers claim nothing, though their runs wait in the queue: no run beyond the three slots left.
    expect(await workers[3]!.tick()).toBe(false);
    expect(await workers[4]!.tick()).toBe(false);
    for (const r of runs.slice(0, 3)) releases.get(r.id)!();
    await Promise.all(ticks.slice(0, 3));
    for (const it of items.slice(0, 3)) expect(await onlyRun(store, it)).toMatchObject({ status: "succeeded" });
    expect((await Promise.all(items.slice(3).map((it) => onlyRun(store, it)))).map((r) => r.status)).toEqual(["queued", "queued"]);
  });

  it("writes no outcome; the controller acknowledges nothing and the item stays RUNNING, blocked on none", async () => {
    const f = await pipeline();
    let started = false;
    f.runner.script.implement = (spec) => new Promise((resolve) => {
      started = true;
      spec.signal.addEventListener("abort", () => resolve({ status: "aborted" }), { once: true });
    });
    const it0 = await f.submit();
    await f.w1.tick(); // triage
    await f.controller.tickRuns(); // the spec is approved at once: implement is queued
    const before = await f.item(it0);
    expect(before).toMatchObject({ stage: "RUNNING", blocked_on: "none" });
    const changes = (await f.store.listStateChanges(it0.id)).length;

    const tick = f.w1.tick();
    await waitFor(() => started, "the implement agent to start");
    await f.store.pauseWorkers({ count: 1 }, BY);
    f.clock.advance(f.config.tick_ms);
    await tick;
    await f.controller.tickRuns();

    const [run] = await f.runs(it0, "implement");
    expect(run).toMatchObject({ status: "queued", outcome: null, acknowledged_at: null, finished_at: null, attempt: 1 });
    expect(run!.paused_at).not.toBeNull();
    expect(await f.store.listUnacknowledgedRuns(10)).toEqual([]);
    expect(await f.item(it0)).toMatchObject({ stage: "RUNNING", blocked_on: "none", version: before.version, restart_count: before.restart_count });
    expect(await f.store.listStateChanges(it0.id)).toHaveLength(changes);
  });

  it("commits the worktree as one WIP commit, writes a `paused:` handoff from the agent's last note, keeps the folder and pushes nothing", async () => {
    const w = await world();
    const item = await implementItem(w.store, 1);
    const worker = w.worker("hostA:1:0", w.hosts.hostA);
    const { run } = await pauseMidRun(w, worker, item);

    expect(w.hosts.hostA.gitCalls).toContain("-c core.hooksPath=/dev/null add -A");
    expect(w.hosts.hostA.gitCalls).toContain(`-c core.hooksPath=/dev/null commit --quiet --no-verify -m wip: paused run ${run.id}`);
    expect(w.hosts.hostA.gitCalls.filter((c) => c.includes(" commit "))).toHaveLength(1);
    const handoffs = await w.store.listHandoffs(item.id);
    expect(handoffs).toHaveLength(1);
    expect(handoffs[0]).toMatchObject({ run_id: run.id, commit_sha: "wip1", next_steps: "next: edit the store" });
    expect(handoffs[0]!.worked_on).toMatch(/^paused: /);
    // Nothing reaches the forge: no push, no PR, on the broker's call log.
    expect(forgeWrites(w.broker)).toEqual([]);
    expect(w.broker.calls).toEqual([]);
    // The folder and the session stay for the resume; the bundle is in shared storage.
    expect([...w.hosts.hostA.live]).toEqual(["sbx1"]);
    expect(run.resume).toMatchObject({ host: "hostA", folder: "sbx1", start_sha: "base", head: "wip1", bundle: `bundles/${item.id}/${run.id}.bundle.b64` });
    expect(await w.storage.get(run.resume!.bundle!)).not.toBeNull();
    expect(run.session_id).toBe(w.runner.calls[0]!.spec.session!.id);
    expect(w.runner.removed).toEqual([]);
    // The paused attempt's usage is kept for the resumed outcome.
    expect(run.resume!.usage).toMatchObject({ input_tokens: 2 * TOKENS_PER_STEP });
  });

  it("with no worktree changes makes no commit and still writes the handoff; no note: the default next steps", async () => {
    const w = await world();
    const item = await implementItem(w.store, 1);
    const worker = w.worker("hostA:1:0", w.hosts.hostA);
    w.runner.holdAt = 0;
    const tick = worker.tick();
    await waitFor(() => w.runner.held, "the agent to start");
    await w.store.pauseWorkers({ count: 1 }, BY);
    w.clock.advance(tick_ms);
    await tick;
    expect(w.hosts.hostA.gitCalls.some((c) => c.includes(" commit "))).toBe(false);
    const [h] = await w.store.listHandoffs(item.id);
    expect(h!.worked_on).toMatch(/^paused: 0 commits/);
    expect((await onlyRun(w.store, item)).resume).toMatchObject({ head: "base", bundle: null });
  });

  it("a paused run keeps its attempt and the item its restart_count through pause and resume", async () => {
    const w = await world();
    const item = await implementItem(w.store, 1);
    const { run } = await pauseMidRun(w, w.worker("hostA:1:0", w.hosts.hostA), item);
    expect(run.attempt).toBe(1);
    await w.store.resumeWorkers();
    const tick = w.worker("hostA:1:1", w.hosts.hostA).tick();
    // The resumed run can finish between two polls, so "running" may never be seen: wait for the claim either way.
    await waitFor(async () => ["running", "succeeded"].includes((await onlyRun(w.store, item)).status), "the resume claim");
    expect(await onlyRun(w.store, item)).toMatchObject({ attempt: 1 });
    await tick;
    expect(await onlyRun(w.store, item)).toMatchObject({ status: "succeeded", attempt: 1 });
    expect((await w.store.getWorkItem(item.id))!.restart_count).toBe(0);
  });
});

describe("workers resume", () => {
  it("same host: reattaches the folder and resumes the stored session with --resume; finished steps are not redone", async () => {
    const w = await world();
    const item = await implementItem(w.store, 1);
    const { run } = await pauseMidRun(w, w.worker("hostA:1:0", w.hosts.hostA), item);
    const session = run.session_id!;

    // Still paused: nobody on the paused worker claims it.
    expect(await w.worker("hostA:1:0", w.hosts.hostA).tick()).toBe(false);
    await w.store.resumeWorkers();
    expect(await w.worker("hostA:1:1", w.hosts.hostA).tick()).toBe(true);

    const resumed = w.runner.calls.at(-1)!;
    expect(flag(resumed.args, "--resume")).toBe(session);
    expect(resumed.args).not.toContain("--session-id");
    expect(resumed.spec.prompt).toContain("Resumed after a pause");
    expect(resumed.transcript).not.toContain("step: read the spec");
    expect(resumed.transcript).not.toContain("step: edit the worker");
    expect(resumed.transcript.split("\n")).toEqual(["step: edit the store", "step: run the tests", "step: commit the work"]);
    // The same folder: no second one was made, and it went when the run ended.
    expect(w.hosts.hostA.created).toHaveLength(1);
    expect(w.hosts.hostA.live.size).toBe(0);
    expect(w.hosts.hostA.destroyedIds).toEqual(["sbx1"]);
    const done = await onlyRun(w.store, item);
    expect(done).toMatchObject({ status: "succeeded", attempt: 1 });
    // The run's outcome counts what the paused attempt used too.
    expect((done.outcome as unknown as { data: { tokens: number } }).data.tokens).toBe(STEPS.length * TOKENS_PER_STEP);
    expect(w.runner.removed).toContain(session);

    // A fresh run of the same task, for comparison: the resumed session used fewer tokens.
    const fresh = await world();
    const other = await implementItem(fresh.store, 2);
    await fresh.worker("hostA:1:0", fresh.hosts.hostA).tick();
    expect((await onlyRun(fresh.store, other)).status).toBe("succeeded");
    const freshTokens = fresh.runner.calls[0]!.tokens;
    expect(freshTokens).toBe(STEPS.length * TOKENS_PER_STEP);
    expect(resumed.tokens).toBeLessThan(freshTokens);
  });

  it("another host: a new session from the WIP commit and the handoff note, with no --resume", async () => {
    const w = await world();
    const item = await implementItem(w.store, 1);
    const { run } = await pauseMidRun(w, w.worker("hostA:1:0", w.hosts.hostA), item);
    await w.store.resumeWorkers();
    w.hosts.hostB.refs["FETCH_HEAD"] = "wip1";
    expect(await w.worker("hostB:2:0", w.hosts.hostB).tick()).toBe(true);

    const resumed = w.runner.calls.at(-1)!;
    expect(resumed.args).not.toContain("--resume");
    expect(flag(resumed.args, "--session-id")).not.toBe(run.session_id);
    expect(resumed.spec.prompt).toContain("## Earlier commits on this branch");
    expect(resumed.spec.prompt).toContain("- wip1 paused: ");
    expect(resumed.spec.prompt).toContain("Last noted next steps: next: edit the store");
    expect(resumed.spec.prompt).toContain("from its WIP commit `wip1`");
    // The WIP commit came from the bundle, checked against the head the store recorded.
    expect(w.hosts.hostB.gitCalls).toContain("fetch --quiet --no-tags /repo/.git/sf-resume.bundle HEAD");
    expect(w.hosts.hostB.gitCalls).toContain(`-c core.hooksPath=/dev/null checkout --quiet -f -B factory/${item.id} wip1`);
    expect(w.hosts.hostB.created).toHaveLength(1);
    expect(await onlyRun(w.store, item)).toMatchObject({ status: "succeeded", attempt: 1 });
  });

  it("a bundle that restores another commit is not trusted: the run starts from the branch, and still succeeds", async () => {
    const w = await world();
    const item = await implementItem(w.store, 1);
    await pauseMidRun(w, w.worker("hostA:1:0", w.hosts.hostA), item);
    await w.store.resumeWorkers();
    w.hosts.hostB.refs["FETCH_HEAD"] = "tampered";
    expect(await w.worker("hostB:2:0", w.hosts.hostB).tick()).toBe(true);
    expect(w.hosts.hostB.gitCalls.some((c) => c.includes("-B factory/") && c.endsWith("tampered"))).toBe(false);
    expect(w.runner.calls.at(-1)!.spec.prompt).toContain("could not be restored");
    expect(w.log.lines.some((l) => l.msg.includes("did not restore"))).toBe(true);
    expect(await onlyRun(w.store, item)).toMatchObject({ status: "succeeded" });
  });

  it("same host, stored session gone: takes the cross-host path (no --resume, earlier commits in the prompt) and does not fail", async () => {
    const w = await world();
    const item = await implementItem(w.store, 1);
    await pauseMidRun(w, w.worker("hostA:1:0", w.hosts.hostA), item);
    w.runner.sessions.clear(); // deleted or unreadable: the runner no longer has it
    await w.store.resumeWorkers();
    expect(await w.worker("hostA:1:1", w.hosts.hostA).tick()).toBe(true);

    const resumed = w.runner.calls.at(-1)!;
    expect(resumed.args).not.toContain("--resume");
    expect(resumed.spec.prompt).toContain("## Earlier commits on this branch");
    expect(resumed.spec.prompt).toContain("Resumed after a pause");
    expect(resumed.transcript).toContain("step: read the spec");
    expect(await onlyRun(w.store, item)).toMatchObject({ status: "succeeded", attempt: 1 });
  });

  it("a review is paused and resumed in its session on the same host; it writes no WIP commit or handoff", async () => {
    const w = await world();
    const { item } = await w.store.createWorkItem(issue(1), system);
    const r = await w.store.transition({
      id: item.id, expected_version: item.version, patch: { pr_number: 7 }, actor: system, reason: "seed",
      enqueue: { kind: "review", idempotency_key: "r1" },
    });
    expect(r.ok).toBe(true);
    w.runner.holdAt = 1;
    const tick = w.worker("hostA:1:0", w.hosts.hostA).tick();
    await waitFor(() => w.runner.held, "the review to reach the hold");
    await w.store.pauseWorkers({ count: 1 }, BY);
    w.clock.advance(tick_ms);
    await tick;
    const paused = await onlyRun(w.store, item);
    expect(paused).toMatchObject({ kind: "review", status: "queued", resume: { folder: "sbx1", head: null } });
    expect(await w.store.listHandoffs(item.id)).toEqual([]);
    expect(w.hosts.hostA.gitCalls.some((c) => c.includes(" commit "))).toBe(false);

    await w.store.resumeWorkers();
    await w.worker("hostA:1:1", w.hosts.hostA).tick();
    expect(flag(w.runner.calls.at(-1)!.args, "--resume")).toBe(paused.session_id);
    expect(await onlyRun(w.store, item)).toMatchObject({ status: "succeeded" });
    expect(w.broker.calls.filter((c) => c.name === "github.comment")).toHaveLength(1);
  });
});

describe("workers pause --all", () => {
  it("pauses every loop, idle ones included: nothing is claimed until workers resume", async () => {
    const w = await world();
    const item = await implementItem(w.store, 1);
    await w.store.pauseWorkers({ all: true }, BY);
    for (const id of ["hostA:1:0", "hostA:1:1", "hostB:2:0"]) expect(await w.worker(id, w.hosts.hostA).tick()).toBe(false);
    expect(await onlyRun(w.store, item)).toMatchObject({ status: "queued", paused_at: null });
    await w.store.resumeWorkers();
    expect(await w.worker("hostB:2:0", w.hosts.hostB).tick()).toBe(true);
  });

  it("stops a running implement run like pause <n>", async () => {
    const w = await world();
    const item = await implementItem(w.store, 1);
    w.runner.holdAt = 1;
    const tick = w.worker("hostA:1:0", w.hosts.hostA).tick();
    await waitFor(() => w.runner.held, "the agent to start");
    await w.store.pauseWorkers({ all: true }, BY);
    w.clock.advance(tick_ms);
    await tick;
    expect(await onlyRun(w.store, item)).toMatchObject({ status: "queued", paused_by: BY });
  });

  it("does not interrupt a run of a kind that is not paused (triage): it finishes, then the worker stops claiming", async () => {
    const w = await world();
    let release = () => {};
    const runner = new FakeRunner({ triage: () => new Promise((resolve) => (release = () => resolve({ output: triageSpec }))) });
    const { item } = await w.store.createWorkItem(issue(1), system, { enqueue: { kind: "triage", idempotency_key: "t" } });
    await implementItem(w.store, 2);
    const worker = w.worker("hostA:1:0", w.hosts.hostA, runner);
    const tick = worker.tick();
    await waitFor(() => runner.specs.length === 1, "triage to start");
    await w.store.pauseWorkers({ all: true }, BY);
    w.clock.advance(tick_ms * 3);
    release();
    await tick;
    expect(await onlyRun(w.store, item)).toMatchObject({ status: "succeeded", paused_at: null });
    expect(await worker.tick()).toBe(false);
  });
});

describe("a run's session and folder go when it ends, whatever the outcome", () => {
  async function ended(how: "succeeded" | "failed" | "cancelled" | "expired") {
    const w = await world();
    const item = await implementItem(w.store, 1);
    const worker = w.worker("hostA:1:0", w.hosts.hostA);
    if (how === "failed") w.runner.fail = true;
    if (how === "cancelled" || how === "expired") w.runner.holdAt = 1;
    const tick = worker.tick();
    if (how === "cancelled") {
      await waitFor(() => w.runner.held, "the agent to start");
      const cur = (await w.store.getWorkItem(item.id))!;
      await w.store.transition({ id: item.id, expected_version: cur.version, patch: {}, actor: system, reason: "closed", cancel_running_runs: true });
      w.clock.advance(heartbeat_ms);
    }
    if (how === "expired") {
      await waitFor(() => w.runner.held, "the agent to start");
      w.clock.advance(lease_ms + 1);
      await w.store.expireLeases(3); // the reaper runs before the late heartbeat reaches the store
      w.clock.advance(heartbeat_ms);
    }
    await tick;
    const run = await onlyRun(w.store, item);
    return { w, run };
  }

  for (const how of ["succeeded", "failed", "cancelled", "expired"] as const) {
    it(how, async () => {
      const { w, run } = await ended(how);
      const expected = { succeeded: "succeeded", failed: "failed", cancelled: "cancelled", expired: "queued" }[how];
      expect(run.status).toBe(expected);
      expect(run.paused_at).toBeNull();
      const session = w.runner.calls[0]!.spec.session!.id;
      expect(w.runner.removed).toContain(session);
      expect(w.runner.sessions.has(session)).toBe(false);
      expect(w.hosts.hostA.live.size).toBe(0);
      expect(w.hosts.hostA.destroyedIds).toEqual(["sbx1"]);
    });
  }
});
