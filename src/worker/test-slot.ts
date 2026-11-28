// A run's host test slot (design 04-pre-push-gates, test slots; phase 2 of 3 of local-28caa30d). Only a full test
// command (argv equal to `repo.test_command`, no test files added) in a pre-push check, a merge check or a Stop check
// runs under it; every other command and a narrowed test command take none. The wait polls the store on the injected
// clock (never a sleep call) and is recorded as the run's waiting row; the worker's heartbeat renews a held slot with a
// take by the same holder. A renewal that finds the slot gone stops the command, and the run waits for a new slot.
// Types are structural (the gate entry, the check round, the worker), so this component file reads no legacy module
// but the store's slot functions.

import { availableParallelism } from "node:os";
import { recordTestSlotWait } from "../impl/store/sql/test-slots.js";
import { testSlotCap } from "./settings/test-slots.setting.js";

/** How often a waiting run asks for a slot again, on the worker's clock. */
export const TEST_SLOT_POLL_MS = 5_000;

type SlotStore = Parameters<typeof recordTestSlotWait>[0];
type Holder = Parameters<typeof recordTestSlotWait>[2]["holder"];
/** A gate entry (core/checks.ts `GateEntry`): an argv, or one run in a folder. */
type Entry = readonly string[] | { readonly dir: string; readonly argv: readonly string[] };
/** A check round (core/checks.ts `CheckRound`): the commands that ran, in order, and the failure if any. */
interface Round<R> { results: R[]; failed: R | null }
type Checks<E, R> = (commands: readonly E[], signal: AbortSignal) => Promise<Round<R>>;

export interface TestSlotDeps {
  store: SlotStore;
  clock: { sleep(ms: number, signal?: AbortSignal): Promise<void> };
  /** `repo.test_command`: the argv that holds the slot. */
  test_command: readonly string[];
  /** The live cap (`test_slots`, else the host's cores) and the live lease, read at each take. */
  cap(): number;
  lease_ms(): number;
  /** Records the run's waiting row (the store's recordTestSlotWait). */
  recordWait(holder: Holder, lease_ms: number): Promise<void>;
  warn(msg: string, fields: Record<string, string>): void;
}

/** Whether `entry` is the full test command: its argv equals `test`, with no test files added. */
export function isFullTestRun(entry: Entry, test: readonly string[]): boolean {
  const argv = "argv" in entry ? entry.argv : entry;
  return test.length > 0 && argv.length === test.length && argv.every((a, i) => a === test[i]);
}

type State = "idle" | "waiting" | "held";

/**
 * Releases in this process: a release wakes this process's waiters, which ask the store again at once instead of at
 * their next poll. Only a hint: the store's take decides, and a waiter in another process still polls.
 */
const local = { releases: 0, wake: new Set<() => void>() };

async function release(store: SlotStore, holder: Holder): Promise<void> {
  await store.releaseTestSlot(holder).catch(() => false);
  local.releases++;
  for (const wake of [...local.wake]) wake();
}

/** One run's slot (the run spec's `TestSlotHold`): idle, waiting for a grant, or held. Scratch for one run; the rows are the store's. */
export class TestSlot {
  private state: State = "idle";
  private lost: AbortController | null = null;

  constructor(private readonly d: TestSlotDeps, readonly holder: Holder) {}

  waiting(): boolean {
    return this.state === "waiting";
  }

  /**
   * `commands` through `run` in order, stopping at the first failure: the full test command on its own call under
   * the slot, every other command with no slot. `unwrap`: the command as configured, for a caller that wraps each
   * one (the merge check's Node choice); absent: as given.
   */
  async runChecks<E extends Entry, R>(commands: readonly E[], signal: AbortSignal, run: Checks<E, R>, unwrap: (entry: E) => Entry = (e) => e): Promise<Round<R>> {
    const full = (e: E): boolean => isFullTestRun(unwrap(e), this.d.test_command);
    if (!commands.some(full)) return run(commands, signal);
    const results: R[] = [];
    for (let i = 0; i < commands.length; ) {
      const isFull = full(commands[i]!);
      let j = i + 1;
      while (!isFull && j < commands.length && !full(commands[j]!)) j++;
      const part = commands.slice(i, j);
      const r = isFull ? await this.hold(signal, (sig) => run(part, sig)) : await run(part, signal);
      results.push(...r.results);
      if (r.failed || signal.aborted || r.results.length < part.length) return { results, failed: r.failed };
      i = j;
    }
    return { results, failed: null };
  }

  /** Waits for a grant, runs `fn` holding the slot, and frees it after, also on a throw; a lost slot runs `fn` again after a new grant. */
  async hold<T>(signal: AbortSignal, fn: (signal: AbortSignal) => Promise<T>): Promise<T> {
    try {
      for (;;) {
        await this.acquire(signal);
        const lost = (this.lost = new AbortController());
        let out: { value: T } | null = null;
        try {
          out = { value: await fn(AbortSignal.any([signal, lost.signal])) };
        } catch (err) {
          if (!lost.signal.aborted || signal.aborted) throw err;
        }
        if (out && (!lost.signal.aborted || signal.aborted)) return out.value;
        this.d.warn("test slot gone at renewal; waiting for a new slot", { run_id: this.holder });
      }
    } finally {
      this.lost = null;
      this.state = "idle";
      await release(this.d.store, this.holder);
    }
  }

  /**
   * The heartbeat renewal: a take by the same holder, which extends only its own slot. Nothing while no slot is held.
   * A store error keeps the slot (the next heartbeat tries again); a refused take (the slot is gone and the host
   * full) stops the command under it, and the run waits for a new slot. Never fails the run.
   */
  async renew(): Promise<void> {
    if (this.state !== "held") return;
    const ok = await this.take().catch((err: unknown) => {
      this.d.warn("test slot renewal failed; kept until the next heartbeat", { run_id: this.holder, error: err instanceof Error ? err.message : String(err) });
      return true;
    });
    // Freed meanwhile (the state moves while the take awaits): a take that wrote the slot again is undone.
    const now = this.state as State;
    if (now === "idle") await release(this.d.store, this.holder);
    else if (!ok && now === "held") {
      this.state = "waiting";
      this.lost?.abort();
    }
  }

  private take(): Promise<boolean> {
    return this.d.store.takeTestSlot({ holder: this.holder, cap: this.d.cap(), lease_ms: this.d.lease_ms() });
  }

  /** Takes a slot, polling every TEST_SLOT_POLL_MS on the clock while the host is full; a release in this process asks again at once. */
  private async acquire(signal: AbortSignal): Promise<void> {
    for (;;) {
      signal.throwIfAborted();
      const seen = local.releases;
      if (await this.take()) {
        this.state = "held";
        return;
      }
      this.state = "waiting";
      await this.d.recordWait(this.holder, this.d.lease_ms());
      if (local.releases !== seen) continue; // a slot was freed meanwhile
      const woke = new AbortController();
      const wake = () => woke.abort();
      local.wake.add(wake);
      try {
        await this.d.clock.sleep(TEST_SLOT_POLL_MS, AbortSignal.any([signal, woke.signal]));
      } catch (err) {
        if (!woke.signal.aborted || signal.aborted) throw err;
      } finally {
        local.wake.delete(wake);
      }
    }
  }
}

/** The worker as its test slots read it: the store, clock, log and cores, the live cap and lease, the test command. */
export interface SlotWorker {
  d: { store: SlotStore; clock: TestSlotDeps["clock"] & { now(): Date }; log: { warn(msg: string, fields: Record<string, string>): void }; cpus?: number };
  cfg: { repo: { test_command: readonly string[] } };
  live: { values(): { test_slots?: number | null; lease_ms: number } };
}

/** A worker's test slots, one per run it executes, made at the run's first use and dropped at its end. */
export class TestSlots {
  private readonly slots = new Map<Holder, TestSlot>();

  constructor(private readonly w: SlotWorker) {}

  /** The run's slot, made on first use. */
  slot(holder: Holder): TestSlot {
    let s = this.slots.get(holder);
    if (!s) {
      const { d, live } = this.w;
      s = new TestSlot({
        store: d.store, clock: d.clock, test_command: this.w.cfg.repo.test_command,
        cap: () => testSlotCap(live.values().test_slots, d.cpus ?? availableParallelism()),
        lease_ms: () => live.values().lease_ms,
        recordWait: (h, lease_ms) => recordTestSlotWait(d.store, d.clock.now(), { holder: h, lease_ms }),
        warn: (msg, fields) => d.log.warn(msg, fields),
      }, holder);
      this.slots.set(holder, s);
    }
    return s;
  }

  /** The heartbeat's renewal of the run's slot, if it has one. */
  async renew(holder: Holder): Promise<void> {
    await this.slots.get(holder)?.renew();
  }

  /** At the run's end. */
  end(holder: Holder): void {
    this.slots.delete(holder);
  }

  /** `commands` through `run`; with `slot` (true, or an `unwrap` for wrapped commands) the full test command under the run's slot. */
  run<E extends Entry, R>(holder: Holder, commands: readonly E[], signal: AbortSignal, slot: true | ((entry: E) => Entry) | undefined, run: Checks<E, R>): Promise<Round<R>> {
    if (!slot) return run(commands, signal);
    return this.slot(holder).runChecks(commands, signal, run, slot === true ? undefined : slot);
  }
}
