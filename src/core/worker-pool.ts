import { LiveSettings } from "./settings.js";
import type { WorkerId } from "./types.js";
import { Worker, type WorkerDeps } from "./worker.js";
import type { FactoryStore } from "../interfaces/factory-store.js";
import type { KeepAwake } from "../interfaces/keep-awake.js";

export interface WorkerPoolDeps extends Omit<WorkerDeps, "id" | "index" | "active"> {
  /**
   * `<host>:<pid>`. Worker n's id is `<id_prefix>:<n>`. The pool has `config.max_workers` slots (absent:
   * `config.workers`); how many of them claim is the live `workers` setting, capped at that.
   */
  id_prefix: string;
  /**
   * The first worker index (SF_WORKER_INDEX_BASE from the supervisor; absent: 0). Workers are numbered
   * base … base + max_workers - 1, so two processes alive at once on one host (an old version draining beside the
   * new one) never hand the same SF_WORKER_INDEX to two runs.
   */
  index_base?: number;
}

/** One running slot: its own stop signal (a drop in `workers`) and the loop's promise. */
interface Slot {
  stop: AbortController;
  done: Promise<void>;
}

/**
 * Up to `config.max_workers` Worker loops in one process (architecture §4). They share every dependency, so they
 * share nothing in memory that matters for correctness: each claims through the store, whose claim keeps
 * implement-type runs of overlapping items apart, and each run gets its own worktree. Shared handling:
 * one counted KeepAwake (held while any run is in progress), and one signal, so a drain stops every loop
 * from claiming and `run` resolves only once every in-flight run has finished.
 *
 * Live size (design 2026-11-03): each tick the pool re-reads the settings. Slots below the effective `workers`
 * run; a slot at or above it stops claiming, finishes its current run and stops; a stopped slot starts again
 * once `workers` rises. The slot count is the file's `max_workers` (absent: its `workers`), which sizes the
 * supervisor's index block, so no index is ever shared with another process.
 */
export class WorkerPool {
  /** Every slot's Worker, running or not. Slot i has index `index_base + i`. */
  readonly workers: readonly Worker[];
  private readonly live: LiveSettings;

  constructor(private readonly d: WorkerPoolDeps) {
    const { id_prefix, index_base = 0, ...shared } = d;
    const awake = new CountedKeepAwake(d.awake);
    this.live = d.settings ?? LiveSettings.fixed(d.config, d.models);
    const settings = this.live;
    this.workers = Array.from({ length: d.config.max_workers ?? d.config.workers }, (_, i) => {
      const index = index_base + i;
      return new Worker({ ...shared, settings, id: `${id_prefix}:${index}` as WorkerId, index, awake, active: () => i < settings.workers() });
    });
  }

  /** Slots that may claim now: the live `workers`, capped at the slot count. */
  size(): number {
    return Math.min(this.live.workers(), this.workers.length);
  }

  /**
   * Runs the slots until `signal` aborts, starting and stopping them as `workers` changes; resolves after the
   * last in-flight run is done.
   */
  async run(signal: AbortSignal): Promise<void> {
    const slots = new Map<number, Slot>();
    const all = new Set<Promise<void>>();
    while (!signal.aborted) {
      await this.live.refresh();
      const want = this.size();
      this.workers.forEach((w, i) => {
        const slot = slots.get(i);
        if (i < want && !slot) {
          const stop = new AbortController();
          const onAbort = () => stop.abort();
          signal.addEventListener("abort", onAbort, { once: true });
          const done: Promise<void> = w.run(stop.signal).finally(() => {
            signal.removeEventListener("abort", onAbort);
            all.delete(done);
            if (slots.get(i)?.done === done) slots.delete(i);
          });
          all.add(done);
          slots.set(i, { stop, done });
        } else if (i >= want && slot && !slot.stop.signal.aborted) {
          // Stops claiming; the loop finishes its current run, then ends and frees the slot.
          slot.stop.abort();
          this.d.log.info("worker slot stopping: workers lowered", { worker_id: w.id, workers: want });
        }
      });
      await this.d.clock.sleep(this.live.config().tick_ms, signal).catch(() => undefined);
    }
    while (all.size > 0) await Promise.all([...all]);
  }
}

/** `factory workers …` (design §5 Pause). */
export type WorkersAction =
  | { op: "pause"; count: number; by: string }
  | { op: "pause_all"; by: string }
  | { op: "resume" }
  | { op: "status" };

/** The paused-by ID when `--by` is not given: the operator's command line, not a person's display name. */
export const WORKERS_CLI_ACTOR = "system:cli";

export const WORKERS_USAGE = `factory workers pause <n> [--by <user id>]   pause the n workers whose runs started most recently
factory workers pause --all [--by <user id>] pause every worker loop, idle ones included
factory workers resume                       clear every pause
factory workers status                       list the pauses in force`;

/** Parses `workers` arguments; an error string for anything else. */
export function parseWorkersArgs(args: readonly string[]): WorkersAction | { error: string } {
  const rest = [...args];
  let by = WORKERS_CLI_ACTOR;
  const at = rest.indexOf("--by");
  if (at !== -1) {
    const v = rest[at + 1];
    if (!v || v.startsWith("--") || !/^[\w.:@-]{1,255}$/.test(v)) return { error: "--by needs a user or agent ID, e.g. github:12345" };
    by = v;
    rest.splice(at, 2);
  }
  const [op, arg, extra] = rest;
  if (op === "resume" && rest.length === 1) return { op: "resume" };
  if ((op === "status" || op === undefined) && rest.length <= 1) return { op: "status" };
  if (op === "pause" && extra === undefined) {
    if (arg === "--all") return { op: "pause_all", by };
    if (arg !== undefined && /^[1-9]\d{0,3}$/.test(arg)) return { op: "pause", count: Number(arg), by };
  }
  return { error: WORKERS_USAGE };
}

/**
 * Applies a `workers` action to the store, the only place pauses live: running workers see it within one
 * tick_ms, on every host. Returns the lines to print.
 */
export async function runWorkersCommand(store: FactoryStore, action: WorkersAction): Promise<string[]> {
  switch (action.op) {
    case "pause": {
      const { paused } = await store.pauseWorkers({ count: action.count }, action.by);
      const lines = paused.length
        ? [`paused ${paused.length} worker${paused.length === 1 ? "" : "s"}: ${paused.join(", ")}`]
        : ["paused no worker: no unpaused worker has a run in progress"];
      if (paused.length > 0 && paused.length < action.count) lines.push(`only ${paused.length} unpaused worker${paused.length === 1 ? " has" : "s have"} a run in progress`);
      if (paused.length) lines.push(PAUSE_NOTE);
      return lines;
    }
    case "pause_all": {
      const { paused } = await store.pauseWorkers({ all: true }, action.by);
      return [paused.length ? "paused every worker loop, idle ones included" : "every worker loop was already paused", PAUSE_NOTE];
    }
    case "resume": {
      const { cleared } = await store.resumeWorkers();
      return [cleared ? `cleared ${cleared} pause${cleared === 1 ? "" : "s"}: workers claim again, paused runs resume` : "no pause was in force"];
    }
    case "status": {
      const pauses = await store.listWorkerPauses();
      if (pauses.length === 0) return ["no worker is paused"];
      return pauses.map((p) => `${p.worker_id === "*" ? "every worker" : p.worker_id} paused by ${p.paused_by} since ${p.paused_at}`);
    }
  }
}

const PAUSE_NOTE =
  "implement and review runs go back to the queue within one tick, WIP committed locally and nothing pushed; other runs finish first. Undo with: factory workers resume";

/**
 * Several holders of one KeepAwake: the first hold holds the inner one, the last release releases it. A
 * release with nothing held does nothing. Calls to the inner KeepAwake go out one at a time, in order, so a
 * quick hold-release-hold never reaches it out of order.
 */
export class CountedKeepAwake implements KeepAwake {
  private holders = 0;
  private chain: Promise<unknown> = Promise.resolve();

  constructor(private readonly inner: KeepAwake) {}

  hold(): Promise<void> {
    this.holders++;
    return this.holders === 1 ? this.next(() => this.inner.hold()) : this.chain.then(() => undefined, () => undefined);
  }

  release(): Promise<void> {
    if (this.holders === 0) return Promise.resolve();
    this.holders--;
    return this.holders === 0 ? this.next(() => this.inner.release()) : Promise.resolve();
  }

  private next(fn: () => Promise<void>): Promise<void> {
    const result = this.chain.then(fn, fn);
    this.chain = result.catch(() => undefined);
    return result;
  }
}
