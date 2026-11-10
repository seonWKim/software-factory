// The default ExecutionEngine (RFC 0015 §7 Workers): a step journal in the worker's own tables.
//
// - worker_run_steps holds one row per (run, step). A step runs only when it has no succeeded row; its result
//   is stored as JSON and returned instead of running it again, so a resumed run skips finished steps.
// - The lease on worker_runs (lease_owner, lease_token, lease_expires_at) says which worker executes a run.
//   Every journal write is conditional on status 'running' and this worker's lease_token: a worker whose run
//   was taken over loses its writes (LeaseLostError) and never overwrites the new owner's journal. As in the
//   legacy store, the token fences, not lease_expires_at: a worker past its expiry that nobody took over yet
//   may still renew and finish.
// - Time is the latest tick's: `heartbeat` renews this worker's leases, times out steps and aborts a run past
//   deadline_at. No takeover here: the controller's reaper requeues a run whose lease expired, and the next claim
//   resumes it from the journal (one takeover path).
// - code_version: a run with a stored step result from other code is resumed only if `resumes(version)` says so;
//   otherwise it is left for a worker on that revision (RFC 0015 §8 version pinning).

import { errorText } from "../../../../core/log.js";
import type { Row, SqlDriver, SqlExecutor, SqlValue } from "../../../../state/index.js";
import type { Tick } from "../../../../shared/ticks/tick-generator.js";
import {
  LeaseLostError,
  RunDeadlineError,
  StepTimeoutError,
  type EngineOptions,
  type ExecutionEngine,
  type ExecutionEngines,
  type RunRef,
  type RunResult,
  type RunTimeouts,
  type StepContext,
  type StepId,
} from "../../index.js";

export interface JournalEngineOptions extends EngineOptions {
  readonly db: SqlDriver;
  /** Whether this code may resume a run journaled by `version`. Default: only its own version. */
  readonly resumes?: (version: string) => boolean;
  /** Most runs held at once; claims beyond it are refused. Default: no limit. */
  readonly slots?: number;
}

/** The `journal` plugin's product: a JournalEngine per worker loop, all over one database. */
export class JournalEngines implements ExecutionEngines {
  constructor(private readonly db: SqlDriver) {}

  create(o: EngineOptions): ExecutionEngine {
    return new JournalEngine({ db: this.db, ...o });
  }
}

interface InFlight {
  readonly stepId: StepId;
  readonly startedMs: number;
  readonly timeoutMs: number;
  readonly controller: AbortController;
}

interface Held {
  readonly ref: RunRef;
  readonly timeouts: RunTimeouts;
  readonly deadline: string;
  readonly seen: Set<StepId>;
  inFlight: InFlight | null;
}

type Begun = { readonly kind: "lost" } | { readonly kind: "done"; readonly result: string } | { readonly kind: "run"; readonly partial: string | null };

const ERROR_CODE_MAX = 64;

export class JournalEngine implements ExecutionEngine {
  private readonly held = new Map<string, Held>();
  private nowMs: number | null = null;

  constructor(private readonly opts: JournalEngineOptions) {}

  async claim(runId: string): Promise<RunRef | null> {
    const now = this.now();
    if (this.full()) return null;
    const { forUpdate } = this.opts.db.dialect;
    const ref = await this.opts.db.transaction(async (tx): Promise<{ ref: RunRef; deadline: string } | null> => {
      const [row] = await tx.all(
        `SELECT kind, status, attempt, lease_token, created_at, not_before, code_version, deadline_at FROM worker_runs WHERE id = ?${forUpdate}`,
        [runId],
      );
      if (!row || row.status !== "queued") return null;
      const timeouts = this.opts.kinds[String(row.kind)];
      if (!timeouts) return null;
      if (row.not_before !== null && Date.parse(String(row.not_before)) > now) return null;
      if (!(await this.mayResume(tx, runId, row.code_version))) return null;
      const deadline = row.deadline_at === null ? iso(Date.parse(String(row.created_at)) + timeouts.schedule_to_close_ms) : String(row.deadline_at);
      const claimed = await tx.run(
        `UPDATE worker_runs SET status = 'running', attempt = attempt + 1, lease_owner = ?, lease_token = lease_token + 1,
           lease_expires_at = ?, started_at = COALESCE(started_at, ?), updated_at = ?, code_version = ?, deadline_at = ?
         WHERE id = ? AND status = 'queued' AND lease_token = ?`,
        [this.opts.workerId, iso(now + timeouts.heartbeat_ms), iso(now), iso(now), this.opts.codeVersion, deadline, runId, Number(row.lease_token)],
      );
      return claimed === 1 ? { ref: nextRef(runId, row), deadline } : null;
    });
    return ref && this.hold(ref.ref, ref.deadline);
  }

  async adopt(run: RunRef, tick: Tick): Promise<boolean> {
    const now = this.observe(tick);
    const timeouts = this.opts.kinds[run.kind];
    if (!timeouts) return false;
    const { forUpdate } = this.opts.db.dialect;
    const deadline = await this.opts.db.transaction(async (tx): Promise<string | null> => {
      const [row] = await tx.all(`SELECT status, lease_token, created_at, code_version, deadline_at FROM worker_runs WHERE id = ?${forUpdate}`, [run.id]);
      if (!row || row.status !== "running" || Number(row.lease_token) !== run.lease_token) return null;
      if (!(await this.mayResume(tx, run.id, row.code_version))) return null;
      const deadline = row.deadline_at === null ? iso(Date.parse(String(row.created_at)) + timeouts.schedule_to_close_ms) : String(row.deadline_at);
      const n = await tx.run(
        "UPDATE worker_runs SET code_version = ?, deadline_at = ?, updated_at = ? WHERE id = ? AND status = 'running' AND lease_token = ?",
        [this.opts.codeVersion, deadline, iso(now), run.id, run.lease_token],
      );
      return n === 1 ? deadline : null;
    });
    if (deadline === null) return false;
    this.hold(run, deadline);
    return true;
  }

  release(run: RunRef): void {
    if (this.held.get(run.id)?.ref.lease_token === run.lease_token) this.held.delete(run.id);
  }

  async step<T>(run: RunRef, stepId: StepId, fn: (ctx: StepContext) => Promise<T>): Promise<T> {
    const held = this.holding(run);
    if (held.inFlight) throw new Error(`run ${run.id}: step ${stepId} started while ${held.inFlight.stepId} is running`);
    if (held.seen.has(stepId)) throw new Error(`run ${run.id}: step ${stepId} used twice`);
    held.seen.add(stepId);
    const now = this.now();
    if (now >= Date.parse(held.deadline)) throw new RunDeadlineError(run.id, held.deadline);

    const begun = await this.begin(run, stepId, now);
    if (begun.kind === "lost") throw this.lose(run.id);
    if (begun.kind === "done") return JSON.parse(begun.result) as T;

    const controller = new AbortController();
    const timeoutMs = held.timeouts.steps?.[stepId]?.start_to_close_ms ?? held.timeouts.start_to_close_ms;
    held.inFlight = { stepId, startedMs: now, timeoutMs, controller };
    const aborted = new Promise<never>((_, reject) => {
      controller.signal.addEventListener("abort", () => reject(controller.signal.reason as Error), { once: true });
    });
    const ctx: StepContext = {
      signal: controller.signal,
      attempt: run.attempt,
      partial: begun.partial === null ? null : JSON.parse(begun.partial),
      savePartial: (value) => this.savePartial(run, stepId, value),
    };
    let stored: string;
    try {
      const work = Promise.resolve().then(() => fn(ctx));
      work.catch(() => {}); // an aborted step may still settle later; its outcome is dropped
      stored = JSON.stringify((await Promise.race([work, aborted])) ?? null);
    } catch (err) {
      held.inFlight = null;
      // The step's own error is the failure: a journal write that fails here is only logged. The row stays
      // `running`, which the next attempt's `begin` overwrites.
      if (!(err instanceof LeaseLostError)) {
        await this.finish(run, stepId, { status: "failed", error_code: errorCode(err) }).catch((journal: unknown) =>
          this.opts.log?.warn("step failure not journaled", {
            run_id: run.id, step_id: stepId, error_code: errorCode(err), error: errorText(journal),
          }));
      }
      throw err;
    }
    held.inFlight = null;
    if (!(await this.finish(run, stepId, { status: "succeeded", result: stored }))) throw this.lose(run.id);
    // The stored form, so a first run and a resumed one see the same value.
    return JSON.parse(stored) as T;
  }

  async complete(run: RunRef, result: RunResult): Promise<boolean> {
    const held = this.holding(run);
    if (held.inFlight) throw new Error(`run ${run.id}: completed while step ${held.inFlight.stepId} is running`);
    const now = iso(this.now());
    const done = await this.opts.db.run(
      `UPDATE worker_runs SET status = ?, outcome = ?, lease_owner = NULL, lease_expires_at = NULL, finished_at = ?, updated_at = ?
       WHERE id = ? AND status = 'running' AND lease_token = ?`,
      [result.status, JSON.stringify(result), now, now, run.id, run.lease_token],
    );
    this.held.delete(run.id);
    return done === 1;
  }

  async heartbeat(tick: Tick): Promise<void> {
    const now = this.observe(tick);
    for (const held of [...this.held.values()]) {
      const renewed = await this.opts.db.run(
        "UPDATE worker_runs SET lease_expires_at = ?, updated_at = ? WHERE id = ? AND status = 'running' AND lease_token = ?",
        [iso(now + (this.opts.leaseMs?.(held.ref) ?? held.timeouts.heartbeat_ms)), iso(now), held.ref.id, held.ref.lease_token],
      );
      if (renewed !== 1) {
        this.lose(held.ref.id);
        continue;
      }
      const f = held.inFlight;
      if (!f) continue;
      if (now >= Date.parse(held.deadline)) f.controller.abort(new RunDeadlineError(held.ref.id, held.deadline));
      else if (now - f.startedMs >= f.timeoutMs) f.controller.abort(new StepTimeoutError(f.stepId, f.timeoutMs));
    }
  }

  /** Marks the step running for this attempt, keeping a partial result; or reports its stored result. */
  private begin(run: RunRef, stepId: StepId, now: number): Promise<Begun> {
    const { forUpdate } = this.opts.db.dialect;
    return this.opts.db.transaction(async (tx): Promise<Begun> => {
      if (!(await this.leaseHeld(tx, run))) return { kind: "lost" };
      const [row] = await tx.all(`SELECT status, result_ref FROM worker_run_steps WHERE run_id = ? AND step_id = ?${forUpdate}`, [run.id, stepId]);
      if (row?.status === "succeeded") return { kind: "done", result: String(row.result_ref) };
      if (row) {
        await tx.run(
          "UPDATE worker_run_steps SET attempt = ?, status = 'running', error_code = NULL, started_at = ?, finished_at = NULL WHERE run_id = ? AND step_id = ?",
          [run.attempt, iso(now), run.id, stepId],
        );
      } else {
        await tx.run(
          "INSERT INTO worker_run_steps (run_id, step_id, attempt, status, result_ref, error_code, started_at, finished_at) VALUES (?, ?, ?, 'running', NULL, NULL, ?, NULL)",
          [run.id, stepId, run.attempt, iso(now)],
        );
      }
      return { kind: "run", partial: row?.result_ref == null ? null : String(row.result_ref) };
    });
  }

  /** Journals a step's end under this worker's lease. False when the lease is gone (nothing written). */
  private finish(run: RunRef, stepId: StepId, end: { status: "succeeded"; result: string } | { status: "failed"; error_code: string }): Promise<boolean> {
    return this.opts.db.transaction(async (tx) => {
      if (!(await this.leaseHeld(tx, run))) return false;
      const now = iso(this.now());
      const [sql, params]: [string, SqlValue[]] =
        end.status === "succeeded"
          ? ["UPDATE worker_run_steps SET status = 'succeeded', result_ref = ?, error_code = NULL, finished_at = ?", [end.result, now]]
          : ["UPDATE worker_run_steps SET status = 'failed', error_code = ?, finished_at = ?", [end.error_code, now]];
      await tx.run(`${sql} WHERE run_id = ? AND step_id = ? AND attempt = ?`, [...params, run.id, stepId, run.attempt]);
      return true;
    });
  }

  private async savePartial(run: RunRef, stepId: StepId, value: unknown): Promise<void> {
    this.holding(run);
    const saved = await this.opts.db.transaction(async (tx) => {
      if (!(await this.leaseHeld(tx, run))) return false;
      await tx.run("UPDATE worker_run_steps SET result_ref = ? WHERE run_id = ? AND step_id = ? AND attempt = ? AND status = 'running'", [
        JSON.stringify(value ?? null), run.id, stepId, run.attempt,
      ]);
      return true;
    });
    if (!saved) throw this.lose(run.id);
  }

  private async leaseHeld(tx: SqlExecutor, run: RunRef): Promise<boolean> {
    const rows = await tx.all(`SELECT 1 AS held FROM worker_runs WHERE id = ? AND status = 'running' AND lease_token = ?${this.opts.db.dialect.forShare}`, [
      run.id, run.lease_token,
    ]);
    return rows.length > 0;
  }

  /**
   * A run with a stored step result from other code is resumed only when this code says it can. A run with none
   * adopts this code: a failed or running row holds only a partial, which its step checks again anyway, so a
   * paused or requeued run whose only step failed survives a deploy.
   */
  private async mayResume(tx: SqlExecutor, runId: string, version: unknown): Promise<boolean> {
    if (version === null || version === this.opts.codeVersion) return true;
    if (this.opts.resumes?.(String(version))) return true;
    return (await tx.all("SELECT 1 AS x FROM worker_run_steps WHERE run_id = ? AND status = 'succeeded' LIMIT 1", [runId])).length === 0;
  }

  private hold(ref: RunRef, deadline: string): RunRef {
    this.held.set(ref.id, { ref, timeouts: this.opts.kinds[ref.kind]!, deadline, seen: new Set(), inFlight: null });
    return ref;
  }

  private holding(run: RunRef): Held {
    const held = this.held.get(run.id);
    if (!held || held.ref.lease_token !== run.lease_token) throw new LeaseLostError(run.id);
    return held;
  }

  /** Forgets a run this worker no longer holds and aborts its running step. Returns the error to throw. */
  private lose(runId: string, reason: Error = new LeaseLostError(runId)): Error {
    const held = this.held.get(runId);
    this.held.delete(runId);
    held?.inFlight?.controller.abort(reason);
    if (held) this.opts.onLost?.(held.ref, reason);
    return reason;
  }

  private full(): boolean {
    return this.held.size >= (this.opts.slots ?? Infinity);
  }

  private observe(tick: Tick): number {
    this.nowMs = Math.max(this.nowMs ?? -Infinity, Date.parse(tick.now));
    return this.nowMs;
  }

  private now(): number {
    if (this.nowMs === null) throw new Error("the engine has had no tick yet: hand it the claim's or a heartbeat tick first");
    return this.nowMs;
  }
}

function nextRef(id: string, row: Row): RunRef {
  return { id, kind: String(row.kind), attempt: Number(row.attempt) + 1, lease_token: Number(row.lease_token) + 1 };
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

function errorCode(err: unknown): string {
  const code = (err as { code?: unknown } | null)?.code;
  return (typeof code === "string" && code !== "" ? code : "step_failed").slice(0, ERROR_CODE_MAX);
}
