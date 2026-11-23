// Schedules (design 08-schedules): the ScheduleStore methods over `controller_schedules` and
// `controller_schedule_runs`, as SqlScheduleStore, which SqlFactoryStore extends, so these methods add no line to
// sql-factory-store.ts's budget. The claim is one UPDATE conditional on the `next_due_at` the worker read and on
// the schedule's running state; zero rows changed means another worker claimed it first, and nothing is recorded.
// A held checkpoint is resumed or rejected by UPDATEs conditional on its run row still being held.

import type { CadenceKind } from "../../../core/schedule-cadence.js";
import type {
  ClaimOutcome, NewSchedule, Schedule, ScheduleActionKind, ScheduleClaim, ScheduleOutcome, ScheduleRun, ScheduleRunResult, ScheduleStore,
} from "../../../core/schedule.js";
import type { Timestamp, UserId } from "../../../core/types.js";
import type { Row, SqlDriver } from "../../../state/index.js";
import { SqlRunOutputStore } from "./run-output.js";

const COLUMNS = "id, title, cadence_kind, cadence_spec, zone, created_by, created_at, next_due_at, running_since, skip_when_busy, action_kind, action_settings, token_cap";
const RUN_COLUMNS = "schedule_id, occurrence_at, outcome, recorded_at, queued_implement_runs, output, tokens, cost_usd";
/** The running state each outcome's claim requires: refused takes a running schedule, every other an idle one. */
const CLAIM_STATE: Readonly<Record<ClaimOutcome, string>> = {
  fired: "running_since IS NULL", refused: "running_since IS NOT NULL", skipped: "running_since IS NULL", checkpoint: "running_since IS NULL",
};
const HELD = "outcome = 'checkpoint'";

const time = (v: unknown) => (v == null ? null : (String(v) as Timestamp));

function rowToSchedule(r: Row): Schedule {
  return {
    id: String(r.id), title: String(r.title), cadence: { kind: String(r.cadence_kind) as CadenceKind, spec: String(r.cadence_spec) }, zone: String(r.zone),
    created_by: String(r.created_by) as UserId, created_at: String(r.created_at) as Timestamp, next_due_at: time(r.next_due_at), running_since: time(r.running_since),
    skip_when_busy: Number(r.skip_when_busy ?? 0) === 1,
    action: r.action_kind == null ? null : { kind: String(r.action_kind) as ScheduleActionKind, settings: JSON.parse(String(r.action_settings ?? "{}")) as Record<string, unknown> },
    token_cap: r.token_cap == null ? null : Number(r.token_cap),
  };
}

const rowToRun = (r: Row): ScheduleRun => ({
  schedule_id: String(r.schedule_id), occurrence_at: String(r.occurrence_at) as Timestamp, outcome: String(r.outcome) as ScheduleOutcome, recorded_at: String(r.recorded_at) as Timestamp,
  ...(r.queued_implement_runs == null ? {} : { queued_implement_runs: Number(r.queued_implement_runs) }),
  ...(r.output == null ? {} : { output: String(r.output) }),
  ...(r.tokens == null ? {} : { tokens: Number(r.tokens) }),
  ...(r.cost_usd == null ? {} : { cost_usd: Number(r.cost_usd) }),
});

/** ScheduleStore over a SqlDriver; `scheduleStamp` is the store's injected Clock's time. */
export class SqlScheduleStore extends SqlRunOutputStore implements ScheduleStore {
  constructor(db: SqlDriver, private readonly scheduleStamp: () => Timestamp) {
    super(db, scheduleStamp);
  }

  async addSchedule(s: NewSchedule): Promise<Schedule> {
    try {
      await this.db.run(`INSERT INTO controller_schedules (${COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?)`, [
        s.id, s.title, s.cadence.kind, s.cadence.spec, s.zone, s.created_by, s.created_at, s.next_due_at, s.skip_when_busy ? 1 : null,
        s.action?.kind ?? null, s.action ? JSON.stringify(s.action.settings) : null, s.token_cap ?? null,
      ]);
    } catch (err) {
      if (!this.db.isDuplicateKey(err)) throw err;
    }
    const [row] = await this.db.all(`SELECT ${COLUMNS} FROM controller_schedules WHERE id = ?`, [s.id]);
    return rowToSchedule(row!);
  }

  async listSchedules(): Promise<Schedule[]> {
    return (await this.db.all(`SELECT ${COLUMNS} FROM controller_schedules ORDER BY created_at, id`)).map(rowToSchedule);
  }

  async listDueSchedules(due_by: Timestamp): Promise<Schedule[]> {
    const rows = await this.db.all(`SELECT ${COLUMNS} FROM controller_schedules WHERE next_due_at IS NOT NULL AND next_due_at <= ? ORDER BY next_due_at, id`, [due_by]);
    return rows.map(rowToSchedule);
  }

  claimScheduleOccurrence(c: ScheduleClaim): Promise<ScheduleRun | null> {
    return this.db.transaction(async (tx) => {
      const now = this.scheduleStamp();
      const set = c.outcome === "fired" ? "next_due_at = ?, running_since = ?" : "next_due_at = ?";
      const moved = await tx.run(`UPDATE controller_schedules SET ${set} WHERE id = ? AND next_due_at = ? AND ${CLAIM_STATE[c.outcome]}`, [
        c.next_due_at, ...(c.outcome === "fired" ? [now] : []), c.schedule_id, c.occurrence_at,
      ]);
      if (moved !== 1) return null;
      const run: ScheduleRun = {
        schedule_id: c.schedule_id, occurrence_at: c.occurrence_at, outcome: c.outcome, recorded_at: now,
        ...(c.queued_implement_runs === undefined ? {} : { queued_implement_runs: c.queued_implement_runs }),
      };
      await tx.run("INSERT INTO controller_schedule_runs (schedule_id, occurrence_at, outcome, recorded_at, queued_implement_runs) VALUES (?, ?, ?, ?, ?)", [
        run.schedule_id, run.occurrence_at, run.outcome, run.recorded_at, run.queued_implement_runs ?? null,
      ]);
      return run;
    });
  }

  async endScheduleRun(schedule_id: string, running_since: Timestamp): Promise<boolean> {
    return (await this.db.run("UPDATE controller_schedules SET running_since = NULL WHERE id = ? AND running_since = ?", [schedule_id, running_since])) === 1;
  }

  async countQueuedImplementRuns(): Promise<number> {
    const [row] = await this.db.all("SELECT COUNT(*) AS n FROM worker_runs WHERE status = 'queued' AND kind = 'implement'");
    return Number(row?.n ?? 0);
  }

  async listScheduleRuns(schedule_id: string): Promise<ScheduleRun[]> {
    return (await this.db.all(`SELECT ${RUN_COLUMNS} FROM controller_schedule_runs WHERE schedule_id = ? ORDER BY occurrence_at`, [schedule_id])).map(rowToRun);
  }

  async recordScheduleRunResult(schedule_id: string, occurrence_at: Timestamp, r: ScheduleRunResult): Promise<void> {
    const cost = r.cost_usd === null ? "" : ", cost_usd = COALESCE(cost_usd, 0) + ?";
    await this.db.run(`UPDATE controller_schedule_runs SET output = ?, tokens = COALESCE(tokens, 0) + ?${cost} WHERE schedule_id = ? AND occurrence_at = ?`, [
      r.output, r.tokens, ...(r.cost_usd === null ? [] : [r.cost_usd]), schedule_id, occurrence_at,
    ]);
  }

  async scheduleTokensUsed(schedule_id: string): Promise<number> {
    const [row] = await this.db.all("SELECT COALESCE(SUM(tokens), 0) AS n FROM controller_schedule_runs WHERE schedule_id = ?", [schedule_id]);
    return Number(row?.n ?? 0);
  }

  async listHeldScheduleRuns(): Promise<ScheduleRun[]> {
    return (await this.db.all(`SELECT ${RUN_COLUMNS} FROM controller_schedule_runs WHERE ${HELD} ORDER BY occurrence_at, schedule_id`)).map(rowToRun);
  }

  resumeHeldScheduleRun(schedule_id: string, occurrence_at: Timestamp, token_cap: number): Promise<Timestamp | null> {
    return this.db.transaction(async (tx) => {
      const now = this.scheduleStamp();
      const took = await tx.run(
        `UPDATE controller_schedule_runs SET outcome = 'fired' WHERE schedule_id = ? AND occurrence_at = ? AND ${HELD} AND EXISTS (SELECT 1 FROM controller_schedules WHERE id = ? AND running_since IS NULL)`,
        [schedule_id, occurrence_at, schedule_id],
      );
      if (took !== 1) return null;
      await tx.run("UPDATE controller_schedules SET token_cap = ?, running_since = ? WHERE id = ?", [token_cap, now, schedule_id]);
      return now;
    });
  }

  async rejectHeldScheduleRun(schedule_id: string, occurrence_at: Timestamp): Promise<boolean> {
    return (await this.db.run(`UPDATE controller_schedule_runs SET outcome = 'rejected' WHERE schedule_id = ? AND occurrence_at = ? AND ${HELD}`, [schedule_id, occurrence_at])) === 1;
  }
}
