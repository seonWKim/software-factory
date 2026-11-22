// Schedules (design 08-schedules): the ScheduleStore methods over `controller_schedules` and
// `controller_schedule_runs`, as SqlScheduleStore, which SqlFactoryStore extends, so these methods add no line to
// sql-factory-store.ts's budget. The claim is one UPDATE conditional on the `next_due_at` the worker read and on
// the schedule's running state; zero rows changed means another worker claimed it first, and nothing is recorded.

import type { CadenceKind } from "../../../core/schedule-cadence.js";
import type { NewSchedule, Schedule, ScheduleClaim, ScheduleOutcome, ScheduleRun, ScheduleStore } from "../../../core/schedule.js";
import type { Timestamp, UserId } from "../../../core/types.js";
import type { Row, SqlDriver } from "../../../state/index.js";
import { SqlRunOutputStore } from "./run-output.js";

const COLUMNS = "id, title, cadence_kind, cadence_spec, zone, created_by, created_at, next_due_at, running_since";
const RUN_COLUMNS = "schedule_id, occurrence_at, outcome, recorded_at";
/** The running state each outcome's claim requires: fired takes an idle schedule, refused a running one. */
const CLAIM_STATE: Readonly<Record<ScheduleOutcome, string>> = { fired: "running_since IS NULL", refused: "running_since IS NOT NULL" };

const time = (v: unknown) => (v == null ? null : (String(v) as Timestamp));

function rowToSchedule(r: Row): Schedule {
  return {
    id: String(r.id), title: String(r.title), cadence: { kind: String(r.cadence_kind) as CadenceKind, spec: String(r.cadence_spec) }, zone: String(r.zone),
    created_by: String(r.created_by) as UserId, created_at: String(r.created_at) as Timestamp, next_due_at: time(r.next_due_at), running_since: time(r.running_since),
  };
}

const rowToRun = (r: Row): ScheduleRun => ({
  schedule_id: String(r.schedule_id), occurrence_at: String(r.occurrence_at) as Timestamp, outcome: String(r.outcome) as ScheduleOutcome, recorded_at: String(r.recorded_at) as Timestamp,
});

/** ScheduleStore over a SqlDriver; `scheduleStamp` is the store's injected Clock's time. */
export class SqlScheduleStore extends SqlRunOutputStore implements ScheduleStore {
  constructor(db: SqlDriver, private readonly scheduleStamp: () => Timestamp) {
    super(db, scheduleStamp);
  }

  async addSchedule(s: NewSchedule): Promise<Schedule> {
    try {
      await this.db.run(`INSERT INTO controller_schedules (${COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)`, [
        s.id, s.title, s.cadence.kind, s.cadence.spec, s.zone, s.created_by, s.created_at, s.next_due_at,
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
      const run: ScheduleRun = { schedule_id: c.schedule_id, occurrence_at: c.occurrence_at, outcome: c.outcome, recorded_at: now };
      await tx.run(`INSERT INTO controller_schedule_runs (${RUN_COLUMNS}) VALUES (?, ?, ?, ?)`, [run.schedule_id, run.occurrence_at, run.outcome, run.recorded_at]);
      return run;
    });
  }

  async endScheduleRun(schedule_id: string, running_since: Timestamp): Promise<boolean> {
    return (await this.db.run("UPDATE controller_schedules SET running_since = NULL WHERE id = ? AND running_since = ?", [schedule_id, running_since])) === 1;
  }

  async listScheduleRuns(schedule_id: string): Promise<ScheduleRun[]> {
    return (await this.db.all(`SELECT ${RUN_COLUMNS} FROM controller_schedule_runs WHERE schedule_id = ? ORDER BY occurrence_at`, [schedule_id])).map(rowToRun);
  }
}
