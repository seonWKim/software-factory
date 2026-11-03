import type { WorkerId } from "./types.js";
import { Worker, type WorkerDeps } from "./worker.js";
import type { FactoryStore } from "../interfaces/factory-store.js";
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
