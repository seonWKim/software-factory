// Schedules (design 08-schedules): a schedule is its own stored record (`controller_schedules`), never a plain
// task's repeat. Each due occurrence is claimed by one conditional store update that moves `next_due_at` from the
// value the worker read; a second worker that read the same value changes nothing and fires nothing. Slots missed
// while no worker ran are one occurrence on return, recorded against the slot it was due for. A due occurrence of a
// schedule still running is refused, and the refusal is a run row too. A schedule with `skip_when_busy` on skips a
// due occurrence while the store holds the threshold or more queued implement runs: a `skipped` run row with the
// count, `next_due_at` moved on, never run later. Pure decisions over a ScheduleStore; the caller's tick supplies the
// time, and `fired` says which occurrences are to run.

import { type Cadence, cadenceProblem, nextDue } from "./schedule-cadence.js";
import type { Timestamp, UserId } from "./types.js";

/**
 * What became of a due occurrence: claimed to run, refused because the schedule was still running, or skipped
 * because its schedule skips when busy and the factory was.
 */
export type ScheduleOutcome = "fired" | "refused" | "skipped";

/** Queued implement runs at which a `skip_when_busy` schedule skips its due occurrence (the owner's "under 15"). */
export const SKIP_WHEN_BUSY_THRESHOLD = 15;

export interface Schedule {
  id: string;
  title: string;
  cadence: Cadence;
  /** IANA zone name: the cadence's wall clock. */
  zone: string;
  /** The owner's user ID, never a display name. */
  created_by: UserId;
  created_at: Timestamp;
  /** The occurrence the next claim takes; null when the cadence never falls due again. */
  next_due_at: Timestamp | null;
  /** When the fired occurrence started; null while idle. */
  running_since: Timestamp | null;
  /** Skip a due occurrence while the factory is busy (SKIP_WHEN_BUSY_THRESHOLD queued implement runs); off when unset. */
  skip_when_busy: boolean;
}

export type NewSchedule = Omit<Schedule, "running_since" | "skip_when_busy"> & { skip_when_busy?: boolean };

/** One row per claimed occurrence, unique per (schedule_id, occurrence_at). */
export interface ScheduleRun {
  schedule_id: string;
  /** The slot it was due for, not the time it was claimed. */
  occurrence_at: Timestamp;
  outcome: ScheduleOutcome;
  recorded_at: Timestamp;
  /** The queued implement runs a `skipped` occurrence saw; absent on every other outcome. */
  queued_implement_runs?: number;
}

export interface ScheduleClaim {
  schedule_id: string;
  /** The `next_due_at` the worker read; the claim applies only while it is still stored. */
  occurrence_at: Timestamp;
  next_due_at: Timestamp | null;
  outcome: ScheduleOutcome;
  /** Stored on the run row of a `skipped` claim. */
  queued_implement_runs?: number;
}

/** The store's schedule methods, part of FactoryStore. */
export interface ScheduleStore {
  /** Inserts the schedule unless its ID is stored; returns the stored row either way. */
  addSchedule(s: NewSchedule): Promise<Schedule>;
  listSchedules(): Promise<Schedule[]>;
  /** Schedules whose `next_due_at` is at or before `due_by`, earliest first. Read-only. */
  listDueSchedules(due_by: Timestamp): Promise<Schedule[]>;
  /**
   * One conditional update: moves `next_due_at` from `occurrence_at` to `next_due_at` only while the schedule is
   * idle (`fired`, which also sets `running_since`, or `skipped`, which does not) or running (`refused`), and stores the run row in the same
   * transaction. Null when the claim was lost: another worker moved it first, or the schedule changed state.
   */
  claimScheduleOccurrence(c: ScheduleClaim): Promise<ScheduleRun | null>;
  /** Clears `running_since` only while it is still `running_since`; false when it was not. */
  endScheduleRun(schedule_id: string, running_since: Timestamp): Promise<boolean>;
  /** Every run row of the schedule, oldest occurrence first. Read-only. */
  listScheduleRuns(schedule_id: string): Promise<ScheduleRun[]>;
  /** Implement runs waiting to be claimed (status `queued`). Read-only. */
  countQueuedImplementRuns(): Promise<number>;
}

export type AddScheduleInput = Pick<Schedule, "id" | "title" | "cadence" | "zone" | "created_by"> & { skip_when_busy?: boolean };

/** Stores a new schedule, first due at its cadence's next slot after `now`; refused with the cadence's problem. */
export async function addSchedule(store: ScheduleStore, input: AddScheduleInput, now: Date): Promise<{ ok: true; schedule: Schedule } | { ok: false; problem: string }> {
  const problem = cadenceProblem(input.cadence, input.zone);
  if (problem) return { ok: false, problem };
  const first = nextDue(input.cadence, input.zone, now, now);
  if (!first) return { ok: false, problem: "the cadence never falls due" };
  const schedule = await store.addSchedule({ ...input, created_at: now.toISOString() as Timestamp, next_due_at: first.toISOString() as Timestamp });
  return { ok: true, schedule };
}

/**
 * One pass over the due schedules at `now`: each due occurrence is claimed once, its next due time the first slot
 * after `now` (so missed slots make one occurrence), fired when idle, refused when running, and skipped when idle,
 * set to skip when busy and the store holds `busy_threshold` or more queued implement runs (counted once per pass,
 * only when such a schedule is due). Safe to run on several workers at once and to run twice: a lost claim fires
 * nothing.
 */
export async function runDueSchedules(
  store: ScheduleStore, now: Date, { busy_threshold = SKIP_WHEN_BUSY_THRESHOLD }: { busy_threshold?: number } = {},
): Promise<Record<"fired" | "refused" | "skipped", ScheduleRun[]>> {
  const runs: Record<ScheduleOutcome, ScheduleRun[]> = { fired: [], refused: [], skipped: [] };
  let queued: number | undefined;
  for (const s of await store.listDueSchedules(now.toISOString() as Timestamp)) {
    const next = nextDue(s.cadence, s.zone, now, new Date(s.created_at));
    let outcome: ScheduleOutcome = s.running_since === null ? "fired" : "refused";
    if (outcome === "fired" && s.skip_when_busy && (queued ??= await store.countQueuedImplementRuns()) >= busy_threshold) outcome = "skipped";
    const run = await store.claimScheduleOccurrence({
      schedule_id: s.id, occurrence_at: s.next_due_at!, next_due_at: next === null ? null : (next.toISOString() as Timestamp), outcome,
      ...(outcome === "skipped" ? { queued_implement_runs: queued! } : {}),
    });
    if (run) runs[outcome].push(run);
  }
  return runs;
}
