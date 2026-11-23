// Routines (src/core/routines.ts): the RoutineStore methods over `controller_routines` and
// `controller_routine_suggestions`, as SqlRoutineStore, which SqlFactoryStore extends, so these methods add no line to
// sql-factory-store.ts's budget. Every routine write is one UPDATE conditional on what the caller read (its marks, the
// hold a raise answers); a suggestion's answer is conditional on it reading pending. A snooze that has run out reads
// as pending, by the store's injected Clock, with no write.

import type { CadenceKind } from "../../../core/schedule-cadence.js";
import type {
  NewRoutine, Routine, RoutineMarks, RoutinePatch, RoutineStore, RoutineSuggestion, RoutineTrigger, SuggestionDecision, SuggestionState,
} from "../../../core/routines.js";
import type { Timestamp, UserId } from "../../../core/types.js";
import type { Row, SqlDriver, SqlValue } from "../../../state/index.js";
import { SqlAttachmentStore } from "./attachments.js";

const COLUMNS = "id, name, instruction, url, cadence_kind, cadence_spec, zone, trigger_kind, run_cap_usd, daily_cap_usd, cap_raise_usd, cap_raise_day, cap_hold_key, paused, created_by, created_at, next_due_at, last_run_at";
const S_COLUMNS = "id, routine_id, run_id, fingerprint, text, state, duplicates, last_run_id, snoozed_until, filed_ref, decided_by, decided_at, created_at";
/** A suggestion's state as of `?` (now): a snooze that has run out is pending. */
const LIVE_STATE = "CASE WHEN state = 'snoozed' AND snoozed_until <= ? THEN 'pending' ELSE state END";

const text = (v: unknown) => (v == null ? null : String(v));
const num = (v: unknown) => (v == null ? null : Number(v));

function rowToRoutine(r: Row): Routine {
  return {
    id: String(r.id), name: String(r.name), instruction: String(r.instruction), url: text(r.url),
    schedule: r.cadence_kind == null ? null : { kind: String(r.cadence_kind) as CadenceKind, spec: String(r.cadence_spec) }, zone: String(r.zone),
    trigger: text(r.trigger_kind) as RoutineTrigger | null, run_cap_usd: num(r.run_cap_usd), daily_cap_usd: num(r.daily_cap_usd),
    cap_raise: r.cap_hold_key == null ? null : { usd: Number(r.cap_raise_usd ?? 0), day: String(r.cap_raise_day), hold_key: String(r.cap_hold_key) },
    paused: Number(r.paused ?? 0) === 1, created_by: String(r.created_by) as UserId, created_at: String(r.created_at) as Timestamp,
    next_due_at: text(r.next_due_at) as Timestamp | null, last_run_at: text(r.last_run_at) as Timestamp | null,
  };
}

const rowToSuggestion = (r: Row): RoutineSuggestion => ({
  id: String(r.id), routine_id: String(r.routine_id), run_id: String(r.run_id), text: String(r.text), fingerprint: String(r.fingerprint),
  state: String(r.live_state) as SuggestionState, duplicates: Number(r.duplicates), snoozed_until: text(r.snoozed_until) as Timestamp | null,
  filed_ref: text(r.filed_ref), decided_by: text(r.decided_by), decided_at: text(r.decided_at) as Timestamp | null, created_at: String(r.created_at) as Timestamp,
});

/** `column = ?` or `column IS NULL`, with its value when it has one. */
const equals = (column: string, v: string | null): [string, SqlValue[]] => (v === null ? [`${column} IS NULL`, []] : [`${column} = ?`, [v]]);

/** RoutineStore over a SqlDriver; `routineStamp` is the store's injected Clock's time. */
export class SqlRoutineStore extends SqlAttachmentStore implements RoutineStore {
  constructor(db: SqlDriver, private readonly routineStamp: () => Timestamp) {
    super(db, routineStamp);
  }

  async addRoutine(r: NewRoutine): Promise<Routine> {
    try {
      await this.db.run(`INSERT INTO controller_routines (${COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, ?, ?, ?, NULL)`, [
        r.id, r.name, r.instruction, r.url, r.schedule?.kind ?? null, r.schedule?.spec ?? null, r.zone, r.trigger, r.run_cap_usd, r.daily_cap_usd,
        r.created_by, r.created_at, r.next_due_at,
      ]);
    } catch (err) {
      if (!this.db.isDuplicateKey(err)) throw err;
    }
    return (await this.getRoutine(r.id))!;
  }

  async getRoutine(id: string): Promise<Routine | null> {
    const [row] = await this.db.all(`SELECT ${COLUMNS} FROM controller_routines WHERE id = ?`, [id]);
    return row ? rowToRoutine(row) : null;
  }

  async listRoutines(): Promise<Routine[]> {
    return (await this.db.all(`SELECT ${COLUMNS} FROM controller_routines ORDER BY created_at, id`)).map(rowToRoutine);
  }

  async updateRoutine(id: string, read: RoutineMarks, patch: RoutinePatch): Promise<boolean> {
    const cols: [string, SqlValue][] = [];
    if (patch.next_due_at !== undefined) cols.push(["next_due_at", patch.next_due_at]);
    if (patch.last_run_at !== undefined) cols.push(["last_run_at", patch.last_run_at]);
    if (patch.paused !== undefined) cols.push(["paused", patch.paused ? 1 : null]);
    if (cols.length === 0) return false;
    const [due, dueArgs] = equals("next_due_at", read.next_due_at), [last, lastArgs] = equals("last_run_at", read.last_run_at);
    const sql = `UPDATE controller_routines SET ${cols.map(([c]) => `${c} = ?`).join(", ")} WHERE id = ? AND ${due} AND ${last}`;
    return (await this.db.run(sql, [...cols.map(([, v]) => v), id, ...dueArgs, ...lastArgs])) === 1;
  }

  async raiseRoutineCap(id: string, r: { hold_key: string; usd: number; day: string }): Promise<boolean> {
    const sql = `UPDATE controller_routines SET cap_raise_usd = CASE WHEN cap_raise_day = ? THEN COALESCE(cap_raise_usd, 0) + ? ELSE ? END, cap_raise_day = ?, cap_hold_key = ?
      WHERE id = ? AND (cap_hold_key IS NULL OR cap_hold_key <> ?)`;
    return (await this.db.run(sql, [r.day, r.usd, r.usd, r.day, r.hold_key, id, r.hold_key])) === 1;
  }

  addRoutineSuggestions(routine_id: string, run_id: string, findings: readonly { fingerprint: string; text: string }[]): Promise<{ added: number; duplicates: number }> {
    return this.db.transaction(async (tx) => {
      const now = this.routineStamp();
      let added = 0, duplicates = 0;
      for (const [i, f] of findings.entries()) {
        const [known] = await tx.all("SELECT last_run_id FROM controller_routine_suggestions WHERE routine_id = ? AND fingerprint = ?", [routine_id, f.fingerprint]);
        if (known) {
          // This run's second pass (or a finding it repeated) is already recorded: nothing to count again.
          if (String(known.last_run_id) === run_id) continue;
          await tx.run("UPDATE controller_routine_suggestions SET duplicates = duplicates + 1, last_run_id = ? WHERE routine_id = ? AND fingerprint = ?", [run_id, routine_id, f.fingerprint]);
          duplicates++;
          continue;
        }
        await tx.run(`INSERT INTO controller_routine_suggestions (${S_COLUMNS}) VALUES (?, ?, ?, ?, ?, 'pending', 0, ?, NULL, NULL, NULL, NULL, ?)`, [
          `${run_id}:${i}`, routine_id, run_id, f.fingerprint, f.text, run_id, now,
        ]);
        added++;
      }
      return { added, duplicates };
    });
  }

  async listRoutineSuggestions(routine_id: string): Promise<RoutineSuggestion[]> {
    const rows = await this.db.all(`SELECT ${S_COLUMNS}, ${LIVE_STATE} AS live_state FROM controller_routine_suggestions WHERE routine_id = ? ORDER BY created_at, id`, [this.routineStamp(), routine_id]);
    return rows.map(rowToSuggestion);
  }

  async getRoutineSuggestion(id: string): Promise<RoutineSuggestion | null> {
    const [row] = await this.db.all(`SELECT ${S_COLUMNS}, ${LIVE_STATE} AS live_state FROM controller_routine_suggestions WHERE id = ?`, [this.routineStamp(), id]);
    return row ? rowToSuggestion(row) : null;
  }

  async decideRoutineSuggestion(id: string, d: SuggestionDecision): Promise<boolean> {
    const now = this.routineStamp();
    const until = d.to === "snoozed" ? (new Date(Date.parse(now) + d.snooze_ms).toISOString() as Timestamp) : null;
    const sql = `UPDATE controller_routine_suggestions SET state = ?, snoozed_until = ?, filed_ref = ?, decided_by = ?, decided_at = ? WHERE id = ? AND ${LIVE_STATE} = 'pending'`;
    return (await this.db.run(sql, [d.to, until, d.to === "accepted" ? d.filed_ref : null, d.by, now, id, now])) === 1;
  }
}
