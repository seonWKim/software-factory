// Schedules (design 08-schedules): the ScheduleStore methods over `controller_schedules` and
// `controller_schedule_runs`, as SqlScheduleStore, which SqlFactoryStore extends, so these methods add no line to
// sql-factory-store.ts's budget. The claim is one UPDATE conditional on the `next_due_at` the worker read and on
// the schedule's running state; zero rows changed means another worker claimed it first, and nothing is recorded.
// A held checkpoint is resumed or rejected by UPDATEs conditional on its run row still being held. An edit, pause,
// resume or run is one UPDATE conditional on the `next_due_at` it read, so it and a claim never both apply. The
// missed-time rule is `missed_rule`; `skip_when_busy`, the column it replaced, is no longer read or written. A delete
// removes the schedule row and its suggestions and ends its held checkpoints as `rejected` in one transaction; its
// other run rows stay.
// `scheduleTokensUsed` with a UTC date sums only the runs whose occurrence falls on it (a `day` token_period's cap).
// The schedule list (unless asked for them: the CLI's list and every write's read) and the due list leave out Check a
// page rows (action_kind 'check_page', routines copied by the 20261124T1100-controller-routines-into-schedules
// migration, or added by `schedule add --action check-page`, its `instruction` and `url` in their columns): the
// Schedules page and its API do not show them, and
// the claim pass reads them through `listCheckPages` instead, with the row's `instruction` and `url` as the action's
// settings, and claims each with `claimCheckPage`, conditional on its marks (a trigger row has no `next_due_at`).
// The routine store (src/impl/store/sql/routines.ts) writes the same rows; a trigger routine's row has a null
// cadence and its trigger in `trigger_kind`.
// Each claim also stores its `reason` and a log `ref` on its run row and writes its `schedule_run` Activity row, in
// the claim's transaction (design 08-schedules-actions).

import type { RoutineTrigger } from "../../../core/schedule.js";
import type { Cadence, CadenceKind } from "../../../core/schedule-cadence.js";
import type {
  CheckPageClaim, ClaimOutcome, NewSchedule, Schedule, ScheduleActionKind, ScheduleClaim, ScheduleOutcome, SchedulePatch, ScheduleRun, ScheduleRunResult, ScheduleStore, TokenPeriod,
} from "../../../core/schedule.js";
import type { Timestamp, UserId } from "../../../core/types.js";
import type { Row, SqlDriver, SqlExecutor, SqlValue } from "../../../state/index.js";
import { SqlActivityStore, activityOf, insertActivity, scheduleRunsRef } from "./activity.js";

const COLUMNS = "id, title, cadence_kind, cadence_spec, zone, created_by, created_at, next_due_at, running_since, missed_rule, action_kind, action_settings, token_cap, token_period, " +
  "trigger_kind, run_cap_usd, daily_cap_usd, cap_raise_usd, cap_raise_day, cap_hold_key, paused, last_run_at";
const RUN_COLUMNS = "schedule_id, occurrence_at, outcome, recorded_at, queued_implement_runs, output, tokens, cost_usd";
/** The running state each outcome's claim requires: refused takes a running schedule, every other an idle one. */
const CLAIM_STATE: Readonly<Record<ClaimOutcome, string>> = {
  fired: "running_since IS NULL", refused: "running_since IS NOT NULL", skipped: "running_since IS NULL", checkpoint: "running_since IS NULL",
};
const HELD = "outcome = 'checkpoint'";

/** Why a claim came out as it did: the run row's `reason` and its Activity row's (design 08-schedules-actions). */
function claimReason(outcome: ClaimOutcome, occurrence_at: Timestamp, queued?: number): string {
  if (outcome === "fired") return `due at ${occurrence_at}`;
  if (outcome === "refused") return `due at ${occurrence_at}, but the schedule's previous run is still running`;
  if (outcome === "skipped") return `due at ${occurrence_at}, skipped: ${queued ?? 0} implement run${queued === 1 ? "" : "s"} queued`;
  return `due at ${occurrence_at}, held at a checkpoint for the owner's approval`;
}

/** The run row's `reason` and `ref` (its schedule's runs, whose output the action records) and its Activity row, written on the claim's transaction. */
async function recordClaim(tx: SqlExecutor, now: Timestamp, run: ScheduleRun, outcome: ClaimOutcome): Promise<void> {
  const reason = claimReason(outcome, run.occurrence_at, run.queued_implement_runs), ref = scheduleRunsRef(run.schedule_id);
  await tx.run("UPDATE controller_schedule_runs SET reason = ?, ref = ? WHERE schedule_id = ? AND occurrence_at = ?", [reason, ref, run.schedule_id, run.occurrence_at]);
  await insertActivity(tx, now, activityOf("schedule_run", { subject: run.schedule_id, outcome, reason, ref }));
}
/** Leaves out Check a page rows: the routine API shows them, and the claim pass reads them on their own (listCheckPages). */
const NOT_CHECK_PAGE = "COALESCE(action_kind, '') <> 'check_page'";
const CHECK_PAGE = "action_kind = 'check_page'";

/** `column = ?` or `column IS NULL`, with its value when it has one. */
const equals = (column: string, v: string | null): [string, SqlValue[]] => (v === null ? [`${column} IS NULL`, []] : [`${column} = ?`, [v]]);
const time = (v: unknown) => (v == null ? null : (String(v) as Timestamp));
const num = (v: unknown) => (v == null ? null : Number(v));

/** A row's cadence, null when it has none (a trigger routine's row). */
export const rowCadence = (r: Row): Cadence | null => (r.cadence_kind == null ? null : { kind: String(r.cadence_kind) as CadenceKind, spec: String(r.cadence_spec) });
/** A row's cap raise, null until an `/approve` answered a hold. */
export const rowCapRaise = (r: Row): Schedule["cap_raise"] =>
  r.cap_hold_key == null ? null : { usd: Number(r.cap_raise_usd ?? 0), day: String(r.cap_raise_day), hold_key: String(r.cap_hold_key) };

/** The action's settings: a Check a page row's `instruction` and `url` columns, else the stored JSON. */
const rowSettings = (r: Row): Record<string, unknown> =>
  String(r.action_kind) === "check_page" ? { instruction: String(r.instruction ?? ""), url: r.url == null ? null : String(r.url) } : (JSON.parse(String(r.action_settings ?? "{}")) as Record<string, unknown>);

/** The action's `action_settings`, `instruction` and `url` columns: a Check a page action's settings go in the last two. */
function actionColumns(a: Schedule["action"]): [SqlValue, SqlValue, SqlValue] {
  if (a?.kind !== "check_page") return [a ? JSON.stringify(a.settings) : null, null, null];
  const v = (k: string) => (typeof a.settings[k] === "string" ? (a.settings[k] as string) : null);
  return [null, v("instruction") ?? "", v("url")];
}

function rowToSchedule(r: Row): Schedule {
  return {
    id: String(r.id), title: String(r.title), cadence: rowCadence(r), zone: String(r.zone),
    created_by: String(r.created_by) as UserId, created_at: String(r.created_at) as Timestamp, next_due_at: time(r.next_due_at), running_since: time(r.running_since),
    missed_rule: r.missed_rule === "skip" ? "skip" : "catch_up",
    action: r.action_kind == null ? null : { kind: String(r.action_kind) as ScheduleActionKind, settings: rowSettings(r) },
    token_cap: num(r.token_cap), token_period: r.token_period == null ? null : (String(r.token_period) as TokenPeriod),
    trigger: r.trigger_kind == null ? null : (String(r.trigger_kind) as RoutineTrigger), run_cap_usd: num(r.run_cap_usd), daily_cap_usd: num(r.daily_cap_usd),
    cap_raise: rowCapRaise(r), paused: Number(r.paused ?? 0) === 1, last_run_at: time(r.last_run_at),
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
export class SqlScheduleStore extends SqlActivityStore implements ScheduleStore {
  constructor(db: SqlDriver, private readonly scheduleStamp: () => Timestamp) {
    super(db, scheduleStamp);
  }

  async addSchedule(s: NewSchedule): Promise<Schedule> {
    try {
      const [settings, instruction, url] = actionColumns(s.action ?? null);
      await this.db.run(`INSERT INTO controller_schedules (${COLUMNS}, instruction, url) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
        s.id, s.title, s.cadence?.kind ?? null, s.cadence?.spec ?? null, s.zone, s.created_by, s.created_at, s.next_due_at, s.missed_rule ?? "catch_up",
        s.action?.kind ?? null, settings, s.token_cap ?? null, s.token_period ?? null,
        s.trigger ?? null, s.run_cap_usd ?? null, s.daily_cap_usd ?? null, s.cap_raise?.usd ?? null, s.cap_raise?.day ?? null, s.cap_raise?.hold_key ?? null,
        s.paused ? 1 : null, s.last_run_at ?? null, instruction, url,
      ]);
    } catch (err) {
      if (!this.db.isDuplicateKey(err)) throw err;
    }
    const [row] = await this.db.all(`SELECT ${COLUMNS}, instruction, url FROM controller_schedules WHERE id = ?`, [s.id]);
    return rowToSchedule(row!);
  }

  async listSchedules(opts: { check_pages?: boolean } = {}): Promise<Schedule[]> {
    const where = opts.check_pages ? "" : ` WHERE ${NOT_CHECK_PAGE}`;
    return (await this.db.all(`SELECT ${COLUMNS}, instruction, url FROM controller_schedules${where} ORDER BY created_at, id`)).map(rowToSchedule);
  }

  async listDueSchedules(due_by: Timestamp): Promise<Schedule[]> {
    const rows = await this.db.all(`SELECT ${COLUMNS} FROM controller_schedules WHERE next_due_at IS NOT NULL AND next_due_at <= ? AND ${NOT_CHECK_PAGE} ORDER BY next_due_at, id`, [due_by]);
    return rows.map(rowToSchedule);
  }

  async listCheckPages(): Promise<Schedule[]> {
    return (await this.db.all(`SELECT ${COLUMNS}, instruction, url FROM controller_schedules WHERE ${CHECK_PAGE} ORDER BY created_at, id`)).map(rowToSchedule);
  }

  claimCheckPage(c: CheckPageClaim): Promise<ScheduleRun | null> {
    return this.db.transaction(async (tx) => {
      const now = this.scheduleStamp();
      const [due, dueArgs] = equals("next_due_at", c.read.next_due_at), [last, lastArgs] = equals("last_run_at", c.read.last_run_at);
      const moved = await tx.run(`UPDATE controller_schedules SET next_due_at = ?, last_run_at = ? WHERE id = ? AND ${CHECK_PAGE} AND ${due} AND ${last}`, [
        c.marks.next_due_at, c.marks.last_run_at, c.schedule_id, ...dueArgs, ...lastArgs,
      ]);
      if (moved !== 1) return null;
      const run: ScheduleRun = { schedule_id: c.schedule_id, occurrence_at: c.occurrence_at, outcome: c.outcome, recorded_at: now };
      await tx.run("INSERT INTO controller_schedule_runs (schedule_id, occurrence_at, outcome, recorded_at) VALUES (?, ?, ?, ?)", [run.schedule_id, run.occurrence_at, run.outcome, now]);
      await recordClaim(tx, now, run, c.outcome);
      return run;
    });
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
      await recordClaim(tx, now, run, c.outcome);
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

  async scheduleTokensUsed(schedule_id: string, day?: string): Promise<number> {
    // occurrence_at is a UTC ISO time, so its first ten characters are its UTC date.
    const onDay = day === undefined ? "" : " AND substr(occurrence_at, 1, 10) = ?";
    const [row] = await this.db.all(`SELECT COALESCE(SUM(tokens), 0) AS n FROM controller_schedule_runs WHERE schedule_id = ?${onDay}`, [schedule_id, ...(day === undefined ? [] : [day])]);
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

  async updateSchedule(id: string, read: Timestamp | null, patch: SchedulePatch): Promise<boolean> {
    const cols: [string, SqlValue][] = [];
    if (patch.title !== undefined) cols.push(["title", patch.title]);
    if (patch.cadence !== undefined) cols.push(["cadence_kind", patch.cadence?.kind ?? null], ["cadence_spec", patch.cadence?.spec ?? null]);
    if (patch.zone !== undefined) cols.push(["zone", patch.zone]);
    if (patch.next_due_at !== undefined) cols.push(["next_due_at", patch.next_due_at]);
    if (patch.missed_rule !== undefined) cols.push(["missed_rule", patch.missed_rule]);
    if (patch.action !== undefined) {
      const [settings, instruction, url] = actionColumns(patch.action);
      cols.push(["action_kind", patch.action?.kind ?? null], ["action_settings", settings], ["instruction", instruction], ["url", url]);
    }
    if (patch.token_cap !== undefined) cols.push(["token_cap", patch.token_cap]);
    if (patch.run_cap_usd !== undefined) cols.push(["run_cap_usd", patch.run_cap_usd]);
    if (patch.daily_cap_usd !== undefined) cols.push(["daily_cap_usd", patch.daily_cap_usd]);
    if (patch.paused !== undefined) cols.push(["paused", patch.paused ? 1 : null]);
    if (cols.length === 0) return false;
    const due = read === null ? "next_due_at IS NULL" : "next_due_at = ?";
    const sql = `UPDATE controller_schedules SET ${cols.map(([c]) => `${c} = ?`).join(", ")} WHERE id = ? AND ${due}`;
    return (await this.db.run(sql, [...cols.map(([, v]) => v), id, ...(read === null ? [] : [read])])) === 1;
  }

  deleteSchedule(id: string): Promise<boolean> {
    return this.db.transaction(async (tx) => {
      if ((await tx.run("DELETE FROM controller_schedules WHERE id = ?", [id])) !== 1) return false;
      await tx.run(`UPDATE controller_schedule_runs SET outcome = 'rejected' WHERE schedule_id = ? AND ${HELD}`, [id]);
      await tx.run("DELETE FROM controller_schedule_suggestions WHERE schedule_id = ?", [id]);
      return true;
    });
  }

  scheduleNow(): Timestamp {
    return this.scheduleStamp();
  }

  async rejectHeldScheduleRun(schedule_id: string, occurrence_at: Timestamp): Promise<boolean> {
    return (await this.db.run(`UPDATE controller_schedule_runs SET outcome = 'rejected' WHERE schedule_id = ? AND occurrence_at = ? AND ${HELD}`, [schedule_id, occurrence_at])) === 1;
  }
}
