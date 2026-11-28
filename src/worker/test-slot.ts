// A run's host test slot (design 04-pre-push-gates, test slots; phase 2 of 3 of local-28caa30d). Only a full test
// command (argv equal to `repo.test_command`, no test files added) in a pre-push check, a merge check or a Stop check
// runs under it; every other command and a narrowed test command take none. The wait polls the store on the injected
// clock (never a sleep call) and is recorded as the run's waiting row; the worker's heartbeat renews a held slot with a
// take by the same holder. A renewal that finds the slot gone stops the command, and the run waits for a new slot.

import { type CheckRound, type GateEntry, gateArgv } from "../core/checks.js";
import type { LogFields } from "../core/log.js";
import type { RunId } from "../core/types.js";
import type { TestSlotHold } from "../interfaces/agent-runner.js";
import type { Clock } from "../interfaces/clock.js";
import type { FactoryStore } from "../interfaces/factory-store.js";

/** How often a waiting run asks for a slot again, on the worker's clock. */
export const TEST_SLOT_POLL_MS = 5_000;

export interface TestSlotDeps {
  store: Pick<FactoryStore, "takeTestSlot" | "releaseTestSlot">;
  clock: Clock;
  /** `repo.test_command`: the argv that holds the slot. */
  test_command: readonly string[];
  /** The live cap (`test_slots`, else the host's cores) and the live lease, read at each take. */
  cap(): number;
  lease_ms(): number;
  /** Records the run's waiting row (the store's recordTestSlotWait); absent: a store with no rows to write. */
  recordWait?: (holder: RunId, lease_ms: number) => Promise<void>;
  warn(msg: string, fields: LogFields): void;
}

/** Whether `entry` is the full test command: its argv equals `test`, with no test files added. */
export function isFullTestRun(entry: GateEntry, test: readonly string[]): boolean {
  const argv = gateArgv(entry);
  return test.length > 0 && argv.length === test.length && argv.every((a, i) => a === test[i]);
}

type State = "idle" | "waiting" | "held";

/** One run's slot: idle, waiting for a grant, or held. Scratch for one run; the rows are the store's. */
export class TestSlot implements TestSlotHold {
  private state: State = "idle";
  private lost: AbortController | null = null;

  constructor(private readonly d: TestSlotDeps, readonly holder: RunId) {}

  waiting(): boolean {
    return this.state === "waiting";
  }

  /** `unwrap`: the command as configured, for a caller that wraps each one (the merge check's Node choice); absent: as given. */
  async runChecks(commands: readonly GateEntry[], signal: AbortSignal, run: (commands: readonly GateEntry[], signal: AbortSignal) => Promise<CheckRound>, unwrap: (entry: GateEntry) => GateEntry = (e) => e): Promise<CheckRound> {
    const full = (e: GateEntry): boolean => isFullTestRun(unwrap(e), this.d.test_command);
    if (!commands.some(full)) return run(commands, signal);
    const results: CheckRound["results"] = [];
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
      await this.d.store.releaseTestSlot(this.holder).catch(() => false);
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
    if (now === "idle") await this.d.store.releaseTestSlot(this.holder).catch(() => false);
    else if (!ok && now === "held") {
      this.state = "waiting";
      this.lost?.abort();
    }
  }

  private take(): Promise<boolean> {
    return this.d.store.takeTestSlot({ holder: this.holder, cap: this.d.cap(), lease_ms: this.d.lease_ms() });
  }

  private async acquire(signal: AbortSignal): Promise<void> {
    for (;;) {
      signal.throwIfAborted();
      if (await this.take()) {
        this.state = "held";
        return;
      }
      this.state = "waiting";
      await this.d.recordWait?.(this.holder, this.d.lease_ms());
      await this.d.clock.sleep(TEST_SLOT_POLL_MS, signal);
    }
  }
}
