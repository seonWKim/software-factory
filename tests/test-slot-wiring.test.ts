import { mkdirSync, mkdtempSync } from "node:fs";
import { availableParallelism, tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { CheckRound } from "../src/core/checks.js";
import type { Run, RunId } from "../src/core/types.js";
import { GATE_HOOKS_DIR, gateAnswerer, runDeadline } from "../src/impl/runner/gate-hooks.js";
import { storeSql } from "../src/impl/store/sql/store-sql.js";
import { readTestSlots, recordTestSlotWait } from "../src/impl/store/sql/test-slots.js";
import type { AgentRunSpec, GateHooks } from "../src/interfaces/agent-runner.js";
import type { ExecOptions, ExecResult, SandboxHandle } from "../src/interfaces/sandbox.js";
import { testSlotCap } from "../src/worker/settings/test-slots.setting.js";
import { TEST_SLOT_POLL_MS, TestSlot, isFullTestRun } from "../src/worker/test-slot.js";
import { config } from "./helpers/fakes/config.js";
import { FakeSandbox } from "./helpers/fakes/runner.js";
import { pipeline } from "./helpers/harness.js";
import { issue, newStore, system } from "./helpers/store.js";

// Host test slots in the test runs (design 04-pre-push-gates; phase 2 of 3 of local-28caa30d): a full test command
// (argv equal to repo.test_command, no test files added) in a pre-push check, a merge check or a Stop check runs under
// the run's slot, taken before it starts and freed when it ends; every other command takes none. Its time limit starts
// at the grant, a waiting run holds its run timeout and its Stop check limit, and its waiting row is in the store.

const TEST = ["npm", "test"];
const TYPECHECK = ["npm", "run", "typecheck"];
const LEASE = 60_000;
const id = (n: string) => `run_${n}` as RunId;
const ok = (): ExecResult => ({ exit_code: 0, signal: null, stdout: "", stderr: "", timed_out: false });

/** Lets every pending promise settle; a FakeClock wait never resolves by itself. */
async function settle(): Promise<void> {
  for (let i = 0; i < 50; i++) await new Promise((r) => setImmediate(r));
}

async function slotFixture(cap = 1) {
  const { store, clock } = await newStore();
  const db = storeSql(store);
  const warned: string[] = [];
  const takes: RunId[] = [];
  const counted = { takeTestSlot: async (s: Parameters<typeof store.takeTestSlot>[0]) => (takes.push(s.holder), store.takeTestSlot(s)), releaseTestSlot: (h: RunId) => store.releaseTestSlot(h) };
  const at = (ms: number) => new Date(clock.now().getTime() + ms).toISOString() as never;
  const slot = (holder: RunId) => new TestSlot({
    store: counted, clock, test_command: TEST, cap: () => cap, lease_ms: () => LEASE,
    recordWait: (h, lease_ms) => recordTestSlotWait(db, { now: () => at(0), after: at }, { holder: h, lease_ms }),
    warn: (m) => warned.push(m),
  }, holder);
  const slots = () => readTestSlots(db, clock.now().toISOString());
  return { store, clock, db, slot, slots, takes, warned };
}

/** A check runner that records, for each command, the slots held when it started; `exit` picks a command's result. */
function recorder(slots: () => Promise<{ held: RunId[] }>, exit: (argv: readonly string[]) => Promise<ExecResult> = async () => ok()) {
  const ran: { argv: string[]; held: RunId[] }[] = [];
  const run = async (commands: readonly (readonly string[] | { argv: readonly string[] })[], signal: AbortSignal): Promise<CheckRound> => {
    const results: CheckRound["results"] = [];
    for (const c of commands) {
      const argv = [...("argv" in c ? c.argv : c)];
      ran.push({ argv, held: (await slots()).held });
      const r = await exit(argv);
      if (signal.aborted) return { results, failed: null };
      const res = { command: argv, ok: r.exit_code === 0, how: r.exit_code === 0 ? "passed" : `exited ${r.exit_code}`, tail: "" };
      results.push(res);
      if (!res.ok) return { results, failed: res };
    }
    return { results, failed: null };
  };
  return { ran, run };
}

describe("which commands hold the slot", () => {
  it("only the full test command: argv equal to repo.test_command with no test files added", () => {
    expect(isFullTestRun(TEST, TEST)).toBe(true);
    expect(isFullTestRun({ dir: "web", argv: TEST }, TEST)).toBe(true);
    expect(isFullTestRun([...TEST, "--", "tests/a.test.ts"], TEST)).toBe(false);
    expect(isFullTestRun(TYPECHECK, TEST)).toBe(false);
    expect(isFullTestRun(["npm"], TEST)).toBe(false);
  });

  it("a narrowed test command and every other check command take no slot", async () => {
    const f = await slotFixture();
    const r = recorder(f.slots);
    const round = await f.slot(id("a")).runChecks([TYPECHECK, [...TEST, "--", "tests/a.test.ts"], ["npm", "run", "lint"]], new AbortController().signal, r.run);
    expect(round.failed).toBeNull();
    expect(r.ran.map((x) => x.held)).toEqual([[], [], []]);
    expect(f.takes).toEqual([]);
  });
});

describe("the slot around a full test run", () => {
  it("is taken before the full test command starts and freed when it ends; the commands around it hold none", async () => {
    const f = await slotFixture();
    const r = recorder(f.slots);
    const round = await f.slot(id("a")).runChecks([TYPECHECK, TEST, ["npm", "run", "lint"]], new AbortController().signal, r.run);
    expect(round.failed).toBeNull();
    expect(round.results.map((x) => x.command)).toEqual([TYPECHECK, TEST, ["npm", "run", "lint"]]);
    expect(r.ran).toEqual([{ argv: TYPECHECK, held: [] }, { argv: TEST, held: [id("a")] }, { argv: ["npm", "run", "lint"], held: [] }]);
    expect(await f.slots()).toEqual({ held: [], waiting: [] });
  });

  it("is freed when the test command fails, and the list stops there", async () => {
    const f = await slotFixture();
    const r = recorder(f.slots, async (argv) => (argv.join(" ") === "npm test" ? { ...ok(), exit_code: 1 } : ok()));
    const round = await f.slot(id("a")).runChecks([TEST, TYPECHECK], new AbortController().signal, r.run);
    expect(round.failed?.command).toEqual(TEST);
    expect(r.ran.map((x) => x.argv)).toEqual([TEST]);
    expect(await f.slots()).toEqual({ held: [], waiting: [] });
  });

  it("is freed when the test command throws or is aborted (its time limit ran out)", async () => {
    const f = await slotFixture();
    const thrown = recorder(f.slots, async () => { throw new Error("timed out"); });
    await expect(f.slot(id("a")).runChecks([TEST], new AbortController().signal, thrown.run)).rejects.toThrow("timed out");
    expect(await f.slots()).toEqual({ held: [], waiting: [] });
    const ctl = new AbortController();
    const aborted = recorder(f.slots, async () => (ctl.abort(), ok()));
    await f.slot(id("b")).runChecks([TEST], ctl.signal, aborted.run);
    expect(await f.slots()).toEqual({ held: [], waiting: [] });
  });
});

describe("a run that waits for a slot", () => {
  it("waits on the clock with its waiting row in the store, and its command starts only at the grant", async () => {
    const f = await slotFixture(1);
    expect(await f.store.takeTestSlot({ holder: id("other"), cap: 1, lease_ms: LEASE })).toBe(true);
    const r = recorder(f.slots);
    const slot = f.slot(id("a"));
    const done = slot.runChecks([TEST], new AbortController().signal, r.run);
    await settle();
    expect(slot.waiting()).toBe(true);
    expect(r.ran).toEqual([]);
    // The display reads who waits from the store.
    expect(await f.slots()).toEqual({ held: [id("other")], waiting: [id("a")] });
    f.clock.advance(TEST_SLOT_POLL_MS);
    await settle();
    expect(r.ran).toEqual([]);
    await f.store.releaseTestSlot(id("other"));
    f.clock.advance(TEST_SLOT_POLL_MS);
    expect((await done).failed).toBeNull();
    expect(slot.waiting()).toBe(false);
    expect(r.ran).toEqual([{ argv: TEST, held: [id("a")] }]);
    expect(await f.slots()).toEqual({ held: [], waiting: [] });
  });

  it("an abort while waiting ends the wait and leaves no row", async () => {
    const f = await slotFixture(1);
    await f.store.takeTestSlot({ holder: id("other"), cap: 1, lease_ms: LEASE });
    const ctl = new AbortController();
    const r = recorder(f.slots);
    const done = f.slot(id("a")).runChecks([TEST], ctl.signal, r.run);
    await settle();
    ctl.abort(new Error("lease lost"));
    await expect(done).rejects.toThrow("lease lost");
    expect(r.ran).toEqual([]);
    expect(await f.slots()).toEqual({ held: [id("other")], waiting: [] });
  });
});

describe("renewal with the heartbeat", () => {
  it("a renewal while held is a take by the same holder; with no slot held it takes nothing", async () => {
    const f = await slotFixture(2);
    const slot = f.slot(id("a"));
    await slot.renew();
    expect(f.takes).toEqual([]);
    let renewed = false;
    await slot.runChecks([TEST], new AbortController().signal, recorder(f.slots, async () => {
      await slot.renew();
      renewed = true;
      return ok();
    }).run);
    expect(renewed).toBe(true);
    expect(f.takes).toEqual([id("a"), id("a")]);
  });

  it("a renewal that finds the slot gone makes the run wait for a new slot, then run again, and not fail", async () => {
    const f = await slotFixture(1);
    const slot = f.slot(id("a"));
    let calls = 0;
    const r = recorder(f.slots, async () => {
      calls++;
      if (calls > 1) return ok();
      // The slot's lease ran out and another run took it; the next heartbeat's renewal finds it gone.
      await f.db.run("DELETE FROM worker_test_slots WHERE holder = ?", [id("a")]);
      await f.store.takeTestSlot({ holder: id("other"), cap: 1, lease_ms: LEASE });
      await slot.renew();
      expect(slot.waiting()).toBe(true);
      return { ...ok(), exit_code: 137 };
    });
    const done = slot.runChecks([TEST], new AbortController().signal, r.run);
    await settle();
    expect(calls).toBe(1);
    expect(await f.slots()).toEqual({ held: [id("other")], waiting: [id("a")] });
    await f.store.releaseTestSlot(id("other"));
    f.clock.advance(TEST_SLOT_POLL_MS);
    const round = await done;
    expect(round.failed).toBeNull();
    expect(calls).toBe(2);
    expect(f.warned).toContain("test slot gone at renewal; waiting for a new slot");
    expect(await f.slots()).toEqual({ held: [], waiting: [] });
  });
});

/** Manual timers for the gate hooks' `after`: `advance` fires every timer due, in order. */
function timers() {
  let now = 0;
  let list: { at: number; fn: () => void }[] = [];
  return {
    after: (ms: number, fn: () => void) => {
      const t = { at: now + ms, fn };
      list.push(t);
      return () => void (list = list.filter((x) => x !== t));
    },
    advance(ms: number) {
      const end = now + ms;
      for (;;) {
        const next = list.filter((t) => t.at <= end).sort((a, b) => a.at - b.at)[0];
        if (!next) break;
        list = list.filter((t) => t !== next);
        now = next.at;
        next.fn();
      }
      now = end;
    },
  };
}

describe("the Stop check", () => {
  const LIMIT = 10_000;

  async function stopFixture(exit: (o: ExecOptions) => Promise<ExecResult>) {
    const f = await slotFixture(1);
    const sandbox = new FakeSandbox();
    const ran: { cmd: string; held: RunId[] }[] = [];
    const gitExec = sandbox.exec.bind(sandbox);
    sandbox.exec = async (h: SandboxHandle, cmd: readonly string[], o: ExecOptions) => {
      if (cmd[0] === "git") return gitExec(h, cmd, o);
      ran.push({ cmd: cmd.join(" "), held: (await f.slots()).held });
      return cmd.join(" ") === "npm test" ? exit(o) : ok();
    };
    const workdir = mkdtempSync(join(tmpdir(), "sf-slot-stop-"));
    const dir = join(workdir, GATE_HOOKS_DIR, "r");
    mkdirSync(dir, { recursive: true });
    const gates: GateHooks = {
      allowed_paths: ["src/"], start_sha: "start", base_sha: "base", limits: { max_diff_lines: 1000, max_diff_files: 100 },
      check_commands: [TYPECHECK, TEST], check_env: {}, stop_checks: 3, stop_blocks_used: 0,
    };
    const slot = f.slot(id("a"));
    const t = timers();
    const spec = { run_id: id("a"), sandbox: { id: "h", workdir }, signal: new AbortController().signal, timeout_ms: 60_000, gate_hooks: gates, stop_check_ms: LIMIT, test_slot: slot } as unknown as AgentRunSpec & { gate_hooks: GateHooks; stop_check_ms: number };
    const answers = await gateAnswerer({ dir, spec, sandbox, after: t.after }, spec.signal);
    return { ...f, answers, ran, slot, t };
  }

  it("runs the full test command under the slot and frees it, also when the check fails", async () => {
    const s = await stopFixture(async () => ({ ...ok(), exit_code: 1 }));
    const a = await s.answers.answer({ event: "stop" });
    expect(a?.block.check).toBe("npm test");
    expect(s.ran).toEqual([{ cmd: "npm run typecheck", held: [] }, { cmd: "npm test", held: [id("a")] }]);
    expect(await s.slots()).toEqual({ held: [], waiting: [] });
  });

  it("while it waits for a slot, neither its limit nor the run timeout runs; its limit starts at the grant", async () => {
    let finish: ((r: ExecResult) => void) | null = null;
    const s = await stopFixture((o) => new Promise((resolve) => {
      finish = resolve;
      o.signal?.addEventListener("abort", () => resolve({ ...ok(), exit_code: null, signal: "SIGKILL" }), { once: true });
    }));
    await s.store.takeTestSlot({ holder: id("other"), cap: 1, lease_ms: LEASE });
    const answer = s.answers.answer({ event: "stop" });
    await settle();
    expect(s.slot.waiting()).toBe(true);
    // The run timeout holds while a Stop check (its wait included) is open.
    expect(s.answers.checking()).toBe(true);
    const run = runDeadline(1_000, () => s.answers.checking() || s.slot.waiting(), s.t.after);
    s.t.advance(5 * LIMIT);
    await settle();
    expect(run.signal.aborted).toBe(false);
    expect(s.answers.stopTimeout()).toBeNull();
    expect(s.ran.map((x) => x.cmd)).toEqual(["npm run typecheck"]);
    // The grant: the test command starts, and the limit counts from here.
    await s.store.releaseTestSlot(id("other"));
    s.clock.advance(TEST_SLOT_POLL_MS);
    await settle();
    expect(s.ran.at(-1)).toEqual({ cmd: "npm test", held: [id("a")] });
    s.t.advance(LIMIT - 2_000);
    await settle();
    expect(s.answers.stopTimeout()).toBeNull();
    s.t.advance(3_000);
    expect(await answer).toBeNull();
    expect(s.answers.stopTimeout()).toEqual({ check: "npm test", ms: LIMIT });
    expect(finish).not.toBeNull();
    expect(await s.slots()).toEqual({ held: [], waiting: [] });
    run.stop();
  });
});

describe("the worker's checks", () => {
  it("a pre-push check list opts in: the full test command runs under the run's slot, its time limit from the grant", async () => {
    const f = await pipeline({});
    const run = { id: id("prepush") } as Run;
    f.w1.testSlots.set(run.id, f.w1.newTestSlot(run));
    // Fill the host, so the run waits for its slot.
    const cap = testSlotCap(f.w1.live.values().test_slots, availableParallelism());
    for (let i = 0; i < cap; i++) await f.store.takeTestSlot({ holder: id(`busy${i}`), cap, lease_ms: LEASE });
    const db = storeSql(f.store);
    const ran: { cmd: string; held: boolean; timeout_ms: number | undefined; at: number }[] = [];
    const exec = f.sandbox.exec.bind(f.sandbox);
    f.sandbox.exec = async (h, cmd, o) => {
      if (cmd[0] !== "git") ran.push({ cmd: cmd.join(" "), held: (await readTestSlots(db, f.clock.now().toISOString())).held.includes(run.id), timeout_ms: o.timeout_ms, at: f.clock.now().getTime() });
      return exec(h, cmd, o);
    };
    const handle = { id: "h", workdir: "/w" } as SandboxHandle;
    const done = f.w1.runCheckList(run, handle, new AbortController().signal, { commands: [TYPECHECK, TEST], slot: true });
    await settle();
    expect(ran.map((x) => x.cmd)).toEqual(["npm run typecheck"]);
    expect((await readTestSlots(db, f.clock.now().toISOString())).waiting).toEqual([run.id]);
    await f.store.releaseTestSlot(id("busy0"));
    f.clock.advance(TEST_SLOT_POLL_MS);
    const grant = f.clock.now().getTime();
    expect((await done).failed).toBeNull();
    expect(ran.at(-1)).toEqual({ cmd: "npm test", held: true, timeout_ms: f.w1.cfg.run_timeout_ms, at: grant });
    expect(ran[0]!.held).toBe(false);
    expect((await readTestSlots(db, f.clock.now().toISOString())).held).not.toContain(run.id);
    // Without the opt-in (update, resolve, screenshot, implement sync) the same list takes no slot.
    const plain: string[] = [];
    f.sandbox.exec = async (h, cmd, o) => {
      if (cmd[0] !== "git" && (await readTestSlots(db, f.clock.now().toISOString())).held.includes(run.id)) plain.push(cmd.join(" "));
      return exec(h, cmd, o);
    };
    await f.w1.runCheckList(run, handle, new AbortController().signal, { commands: [TEST] });
    expect(plain).toEqual([]);
  });

  it("a merge check runs its full test command under the run's slot and frees it after; the install takes none", async () => {
    const f = await pipeline({ config: { repo: { ...config.repo, check_commands: [TYPECHECK, TEST] } } });
    const db = storeSql(f.store);
    const held: [string, RunId[]][] = [];
    const exec = f.sandbox.exec.bind(f.sandbox);
    f.sandbox.exec = async (h, cmd, o) => {
      if (cmd[0] !== "git" && cmd[0] !== "cat") held.push([cmd.join(" "), (await readTestSlots(db, f.clock.now().toISOString())).held]);
      return exec(h, cmd, o);
    };
    const { item } = await f.store.createWorkItem(issue(7), system);
    const moved = await f.store.transition({
      id: item.id, expected_version: item.version, actor: system, reason: "test_setup", patch: {},
      enqueue: { kind: "merge-check", idempotency_key: "mc-1", input: { merge_check: { base_ref: "main", branches: [`factory/${item.id}`] } } },
    });
    if (!moved.ok) throw new Error("setup");
    expect(await f.w1.tick()).toBe(true);
    const run = (await f.runs(moved.item, "merge-check"))[0]!;
    expect(run.outcome).toMatchObject({ status: "succeeded", data: { result: "green" } });
    expect(held.find(([c]) => c === "npm test")?.[1]).toEqual([run.id]);
    expect(held.filter(([c]) => c !== "npm test").every(([, h]) => h.length === 0)).toBe(true);
    expect(await readTestSlots(db, f.clock.now().toISOString())).toEqual({ held: [], waiting: [] });
  });
});

describe("the waiting row", () => {
  it("expires with its lease, so a waiter that died leaves the display", async () => {
    const f = await slotFixture(1);
      const at = (ms: number) => new Date(f.clock.now().getTime() + ms).toISOString() as never;
    await recordTestSlotWait(f.db, { now: () => at(0), after: at }, { holder: id("a"), lease_ms: LEASE });
    expect((await f.slots()).waiting).toEqual([id("a")]);
    // A waiting row counts against no cap.
    expect(await f.store.takeTestSlot({ holder: id("b"), cap: 1, lease_ms: LEASE })).toBe(true);
    f.clock.advance(LEASE);
    expect(await f.slots()).toEqual({ held: [], waiting: [] });
  });
});
