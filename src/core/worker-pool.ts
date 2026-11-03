import { LiveSettings } from "./settings.js";
import type { WorkerId } from "./types.js";
import { Worker, type WorkerDeps } from "./worker.js";
import type { KeepAwake } from "../interfaces/keep-awake.js";

export interface WorkerPoolDeps extends Omit<WorkerDeps, "id" | "index" | "active"> {
  /**
   * `<host>:<pid>`. Worker n's id is `<id_prefix>:<n>`. The pool has `config.workers` slots (the config file's
   * value); how many of them claim is the live `workers` setting, capped at that.
   */
  id_prefix: string;
  /**
   * The first worker index (SF_WORKER_INDEX_BASE from the supervisor; absent: 0). Workers are numbered
   * base … base + workers - 1, so two processes alive at once on one host (an old version draining beside the
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
 * Up to `config.workers` Worker loops in one process (architecture §4). They share every dependency, so they
 * share nothing in memory that matters for correctness: each claims through the store, whose claim keeps
 * implement-type runs of overlapping items apart, and each run gets its own worktree. Shared handling:
 * one counted KeepAwake (held while any run is in progress), and one signal, so a drain stops every loop
 * from claiming and `run` resolves only once every in-flight run has finished.
 *
 * Live size (design 2026-11-03): each tick the pool re-reads the settings. Slots below the effective `workers`
 * run; a slot at or above it stops claiming, finishes its current run and stops; a stopped slot starts again
 * once `workers` rises. The slot count never exceeds the file's `workers`, which sizes the supervisor's index
 * block, so no index is ever shared with another process.
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
    this.workers = Array.from({ length: d.config.workers }, (_, i) => {
      const index = index_base + i;
      return new Worker({ ...shared, settings, id: `${id_prefix}:${index}` as WorkerId, index, awake, active: () => i < settings.workers() });
    });
  }

  /** Slots that may claim now: the live `workers`, capped at the file's value. */
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
