import type { WorkerId } from "./types.js";
import { Worker, type WorkerDeps } from "./worker.js";
import type { KeepAwake } from "../interfaces/keep-awake.js";

export interface WorkerPoolDeps extends Omit<WorkerDeps, "id" | "index"> {
  /** `<host>:<pid>`. Worker n's id is `<id_prefix>:<n>`. The number of workers is `config.workers`. */
  id_prefix: string;
  /**
   * The first worker index (SF_WORKER_INDEX_BASE from the supervisor; absent: 0). Workers are numbered
   * base … base + workers - 1, so two processes alive at once on one host (an old version draining beside the
   * new one) never hand the same SF_WORKER_INDEX to two runs.
   */
  index_base?: number;
}

/**
 * `config.workers` Worker loops in one process (architecture §4). They share every dependency, so they share
 * nothing in memory that matters for correctness: each claims through the store, whose claim keeps
 * implement-type runs of overlapping items apart, and each run gets its own worktree. Shared handling:
 * one counted KeepAwake (held while any run is in progress), and one signal, so a drain stops every loop
 * from claiming and `run` resolves only once every in-flight run has finished.
 */
export class WorkerPool {
  readonly workers: readonly Worker[];

  constructor(private readonly d: WorkerPoolDeps) {
    const { id_prefix, index_base = 0, ...shared } = d;
    const awake = new CountedKeepAwake(d.awake);
    this.workers = Array.from({ length: d.config.workers }, (_, i) => {
      const index = index_base + i;
      return new Worker({ ...shared, id: `${id_prefix}:${index}` as WorkerId, index, awake });
    });
  }

  /** Runs every loop until `signal` aborts; resolves after the last in-flight run is done. */
  async run(signal: AbortSignal): Promise<void> {
    await Promise.all(this.workers.map((w) => w.run(signal)));
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
