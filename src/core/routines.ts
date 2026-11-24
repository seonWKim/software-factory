// Routines: an owner-set instruction the factory runs on a schedule or on a trigger, as a read-only `routine` run,
// whose findings come back as suggestions for the owner. A routine is a Check a page schedule row (action
// `check_page`, design 08-schedules); the schedule claim pass runs it (runDueCheckPages, planned by planRoutine).
// Pure, apart from the managing writes (addRoutine, writeRoutine), the claim pass and the run queue, each one keyed
// or conditional store write: every time comes in as an argument, read from the injected Clock.
//
// - Form: a routine has a schedule (a cadence in a zone, src/core/schedule-cadence.ts) or a trigger (`merge`: a change
//   merged since its last run), never both and never neither.
// - Caps, in USD from each run's harness cost (src/core/spend.ts): a run that cost more than `run_cap_usd` pauses its
//   routine; a due run that would take the day's spend past `daily_cap_usd` is held on a local item that waits for
//   the common `/approve` (raises the day's cap by the last run's cost, and runs) or `/reject` (skips the run).
// - Suggestions: one per finding, its text normalized into a fingerprint; a finding whose fingerprint the routine has
//   already stored is a duplicate: skipped and counted. A snoozed suggestion is pending again after SNOOZE_MS.

import type { FactoryStore, NewWorkItem } from "../interfaces/factory-store.js";
import { cyrb53 } from "./hash.js";
import { SYSTEM_ITEM } from "./improver.js";
import { type Schedule, type ScheduleRun, type ScheduleStore, overCap } from "./schedule.js";
import { type Cadence, cadenceProblem, nextDue } from "./schedule-cadence.js";
import { DAY_MS, spendTotals, utcDay } from "./spend.js";
import { type Actor, type Run, type SourceRef, type Timestamp, type UserId, type WorkItem, outcomeCost } from "./types.js";

/** The triggers a routine may run on: `merge`, a change merged into the base branch since the routine's last run. */
export const ROUTINE_TRIGGERS = ["merge"] as const;
export type RoutineTrigger = (typeof ROUTINE_TRIGGERS)[number];

/** How long a snoozed suggestion stays out of the pending list: 14 days. */
export const SNOOZE_MS = 14 * DAY_MS;
/** blocked_reason of a routine run held at its daily cap; and the reasons of the `/approve` and `/reject` that answer it. */
export const ROUTINE_CAP = "routine_cap";
export const ROUTINE_CAP_APPROVED = "routine_cap_approved";
export const ROUTINE_CAP_REJECTED = "routine_cap_rejected";
/** The actor of the routines' own writes. */
export const ROUTINES: Actor = { kind: "system", id: "system:routines" };

export interface Routine {
  id: string;
  name: string;
  /** The owner's instruction, given to the run as it is. */
  instruction: string;
  /** The one page the run's Browse may GET; null for none. */
  url: string | null;
  /** The schedule form: a cadence in `zone`. Null for a trigger routine. */
  schedule: Cadence | null;
  zone: string;
  /** The trigger form. Null for a scheduled routine. */
  trigger: RoutineTrigger | null;
  /** The most one run may cost before the routine pauses; null for no cap. */
  run_cap_usd: number | null;
  /** The most the routine's runs may cost in one UTC day; null for no cap. */
  daily_cap_usd: number | null;
  /** What `/approve` added to the daily cap, on `day`, and the hold item it answered (each hold raises it once). */
  cap_raise: { usd: number; day: string; hold_key: string } | null;
  paused: boolean;
  created_by: UserId;
  created_at: Timestamp;
  /** A scheduled routine's next slot; null for a trigger routine or a schedule that never falls due again. */
  next_due_at: Timestamp | null;
  /** When it last fired or skipped a slot; null before its first. */
  last_run_at: Timestamp | null;
}

export type NewRoutine = Omit<Routine, "cap_raise" | "paused" | "last_run_at">;
/** What a fire or a skip moves, conditional on the values it read. */
export interface RoutineMarks { next_due_at: Timestamp | null; last_run_at: Timestamp | null }
export type RoutinePatch = Partial<RoutineMarks & { paused: boolean }>;
/** The fields an owner may change on a routine. */
export type RoutineFields = Partial<Pick<Routine, "name" | "instruction" | "url" | "schedule" | "zone" | "trigger" | "run_cap_usd" | "daily_cap_usd">>;
/** What an edit writes: the fields changed, and the next slot a changed form moves. */
export type RoutineEdit = RoutineFields & Partial<Pick<Routine, "next_due_at">>;

export type SuggestionState = "pending" | "accepted" | "dismissed" | "snoozed";

export interface RoutineSuggestion {
  id: string;
  routine_id: string;
  /** The run that first found it. */
  run_id: string;
  text: string;
  fingerprint: string;
  /** As read now: a snooze that has run out reads as `pending`. */
  state: SuggestionState;
  /** How many later findings were this one again, skipped. */
  duplicates: number;
  snoozed_until: Timestamp | null;
  /** The item an accepted suggestion was filed as. */
  filed_ref: string | null;
  decided_by: string | null;
  decided_at: Timestamp | null;
  created_at: Timestamp;
}

/** An owner's answer to a pending suggestion: accept (with the filed item's ref), dismiss, or snooze for `snooze_ms`. */
export type SuggestionDecision =
  | { to: "accepted"; by: string; filed_ref: string }
  | { to: "dismissed"; by: string }
  | { to: "snoozed"; by: string; snooze_ms: number };

/** The routine store, on the Check a page rows of `controller_schedules` and `controller_schedule_suggestions`; times from the store's Clock. */
export interface RoutineStore {
  /** Stores `r`; an ID already stored returns the stored routine unchanged. */
  addRoutine(r: NewRoutine): Promise<Routine>;
  getRoutine(id: string): Promise<Routine | null>;
  /** Every routine, oldest first. */
  listRoutines(): Promise<Routine[]>;
  /** Applies `patch` only while the routine's marks still equal `read`: false when another write came first. */
  updateRoutine(id: string, read: RoutineMarks, patch: RoutinePatch): Promise<boolean>;
  /** Writes only the fields given, only while the routine's marks still equal `read`: false when another write came first, or with no field. */
  editRoutine(id: string, read: RoutineMarks, fields: RoutineEdit): Promise<boolean>;
  /** Removes the routine and its suggestions in one transaction; the runs on its carrier item stay. False when it was not stored. */
  deleteRoutine(id: string): Promise<boolean>;
  /** Adds `usd` to the routine's cap for `day` (a new day starts from 0), once per `hold_key`: false when already raised for it. */
  raiseRoutineCap(id: string, r: { hold_key: string; usd: number; day: string }): Promise<boolean>;
  /**
   * Stores each finding of `run_id` as a pending suggestion, in one transaction. A fingerprint the routine already
   * holds is a duplicate: not stored, its suggestion's count raised. A run's second call adds and counts nothing.
   */
  addRoutineSuggestions(routine_id: string, run_id: string, findings: readonly { fingerprint: string; text: string }[]): Promise<{ added: number; duplicates: number }>;
  /** The routine's suggestions, oldest first, each state as of now. */
  listRoutineSuggestions(routine_id: string): Promise<RoutineSuggestion[]>;
  getRoutineSuggestion(id: string): Promise<RoutineSuggestion | null>;
  /** Applies `d` only while the suggestion reads pending: false otherwise. */
  decideRoutineSuggestion(id: string, d: SuggestionDecision): Promise<boolean>;
}

/** What a routine is made from. */
export type RoutineInput = Pick<Routine, "id" | "name" | "instruction" | "url" | "schedule" | "zone" | "trigger" | "run_cap_usd" | "daily_cap_usd" | "created_by">;

const positiveOrNull = (v: number | null) => v === null || (Number.isFinite(v) && v > 0);

/** Why `r` cannot be a routine, or null: it needs a name and an instruction, exactly one of a schedule and a trigger, an http(s) page or none, and positive caps. */
export function routineProblem(r: Omit<RoutineInput, "id" | "created_by">): string | null {
  if (r.name.trim() === "") return "a routine needs a name";
  if (r.instruction.trim() === "") return "a routine needs an instruction";
  if (r.schedule !== null && r.trigger !== null) return "a routine runs on a schedule or on a trigger, not both";
  if (r.schedule === null && r.trigger === null) return "a routine needs a schedule or a trigger";
  if (r.trigger !== null && !(ROUTINE_TRIGGERS as readonly string[]).includes(r.trigger)) return `"${r.trigger}" is not a trigger (${ROUTINE_TRIGGERS.join(", ")})`;
  if (r.schedule !== null) {
    const p = cadenceProblem(r.schedule, r.zone);
    if (p) return p;
  }
  if (r.url !== null && !/^https?:\/\/\S+$/.test(r.url)) return "a routine's page is an http or https URL";
  if (!positiveOrNull(r.run_cap_usd) || !positiveOrNull(r.daily_cap_usd)) return "a cap is a positive dollar amount, or none";
  return null;
}

/** The first slot of a scheduled routine made at `now`; null for a trigger routine. */
export function firstDue(r: Pick<Routine, "schedule" | "zone">, now: Date): Timestamp | null {
  if (r.schedule === null) return null;
  return (nextDue(r.schedule, r.zone, now, now)?.toISOString() ?? null) as Timestamp | null;
}

/** Stores a routine made from `input` at `now`, or says why it cannot be one (nothing stored). */
export async function addRoutine(store: Pick<RoutineStore, "addRoutine">, input: RoutineInput, now: Date): Promise<{ ok: true; routine: Routine } | { ok: false; problem: string }> {
  const problem = routineProblem(input);
  if (problem) return { ok: false, problem };
  const created_at = now.toISOString() as Timestamp;
  return { ok: true, routine: await store.addRoutine({ ...input, created_at, next_due_at: firstDue(input, now) }) };
}

// Managing routines (design 08-routines): the /api/v1/routines writes. Each reads the routine, decides, then writes
// once, conditional on the marks it read, so a fire or another write since then makes it change nothing. Pause and
// resume set `paused`; resume also moves a scheduled routine's next slot to the first after now. Run now sets a
// scheduled routine's `next_due_at` to now, so the schedule claim pass (dueSlot, runDueCheckPages) fires it on the
// next tick and afterSlot moves the slot on: there is no second path. A trigger routine has no next slot to move.

/** The store methods managing routines reads and writes through. */
export type RoutineAdminStore = Pick<RoutineStore, "addRoutine" | "getRoutine" | "updateRoutine" | "editRoutine" | "deleteRoutine">;
/** The writes, each the owner's only. */
export type RoutineWrite = "add" | "edit" | "pause" | "resume" | "delete" | "run";
/** A write's result: the routine as stored (as it was, for a delete), or why nothing was written. */
export type RoutineResult = { ok: true; routine: Routine } | { ok: false; problem: string };
/** The refusal of a write whose condition was lost. */
export const ROUTINE_LOST = "changed by another worker, try again";
/** The refusal of Run now on a trigger routine. */
export const NO_NEXT_SLOT = "a trigger routine has no next slot: it runs on its trigger";

const refused = (problem: string): RoutineResult => ({ ok: false, problem });
const marksOf = (r: Routine): RoutineMarks => ({ next_due_at: r.next_due_at, last_run_at: r.last_run_at });
/** A scheduled routine's first slot after `now`, an interval counted from its creation (as afterSlot counts it); null for a trigger routine. */
const slotAfter = (r: Pick<Routine, "schedule" | "zone" | "created_at">, now: Date): Timestamp | null =>
  r.schedule === null ? null : ((nextDue(r.schedule, r.zone, now, new Date(r.created_at))?.toISOString() ?? null) as Timestamp | null);

/** Stores a new routine from `fields` (zone UTC when not given); refused when it is not a routine or its ID is already stored. */
export async function createRoutine(store: RoutineAdminStore, id: string, f: RoutineFields, created_by: UserId, now: Date): Promise<RoutineResult> {
  const exists = `routine ${id} is already stored`;
  if (await store.getRoutine(id)) return refused(exists);
  const r = await addRoutine(store, {
    id, created_by, name: f.name ?? "", instruction: f.instruction ?? "", url: f.url ?? null, schedule: f.schedule ?? null, zone: f.zone ?? "UTC",
    trigger: f.trigger ?? null, run_cap_usd: f.run_cap_usd ?? null, daily_cap_usd: f.daily_cap_usd ?? null,
  }, now);
  // Another worker stored the ID between the read and the insert: theirs stays.
  return r.ok && r.routine.created_at !== now.toISOString() ? refused(exists) : r;
}

/** Reads the routine, decides its write (or a refusal), and writes it once, conditional on the marks read. */
async function decide(store: RoutineAdminStore, id: string, write: (r: Routine) => { patch: RoutinePatch } | { edit: RoutineEdit } | string): Promise<RoutineResult> {
  const r = await store.getRoutine(id);
  if (r === null) return refused(`no routine ${id}`);
  const w = write(r);
  if (typeof w === "string") return refused(w);
  const done = "patch" in w ? await store.updateRoutine(id, marksOf(r), w.patch) : await store.editRoutine(id, marksOf(r), w.edit);
  return done ? { ok: true, routine: { ...r, ...("patch" in w ? w.patch : w.edit) } } : refused(ROUTINE_LOST);
}

/**
 * Changes only the fields given; refused with no field, or when the routine they make fails routineProblem. A
 * changed schedule, zone or trigger on an unpaused routine sets `next_due_at` to its first slot after `now` (none for
 * a trigger routine); a paused routine stays paused, and its resume sets the slot.
 */
export function editRoutine(store: RoutineAdminStore, id: string, f: RoutineFields, now: Date): Promise<RoutineResult> {
  if (Object.values(f).every((v) => v === undefined)) return Promise.resolve(refused("nothing to change: give at least one field"));
  return decide(store, id, (r) => {
    const next = { ...r, ...Object.fromEntries(Object.entries(f).filter(([, v]) => v !== undefined)) } as Routine;
    const problem = routineProblem(next);
    if (problem) return problem;
    const edit: RoutineEdit = { ...f };
    if (f.schedule !== undefined || f.zone !== undefined || f.trigger !== undefined) {
      if (next.schedule === null) edit.next_due_at = null;
      else if (!r.paused) edit.next_due_at = slotAfter(next, now);
    }
    return { edit };
  });
}

/** Removes the routine and its suggestions; its runs stay on its carrier item. Refused for an unknown ID. */
async function removeRoutine(store: RoutineAdminStore, id: string): Promise<RoutineResult> {
  const r = await store.getRoutine(id);
  return r !== null && (await store.deleteRoutine(id)) ? { ok: true, routine: r } : refused(`no routine ${id}`);
}

/** One write, as the HTTP routes run it; `fields` only for add and edit. */
export function writeRoutine(store: RoutineAdminStore, w: RoutineWrite, id: string, fields: RoutineFields, user: UserId, now: Date): Promise<RoutineResult> {
  if (w === "add") return createRoutine(store, id, fields, user, now);
  if (w === "edit") return editRoutine(store, id, fields, now);
  if (w === "delete") return removeRoutine(store, id);
  return decide(store, id, (r) => {
    if (w === "pause") return r.paused ? "already paused" : { patch: { paused: true } };
    if (w === "resume") return !r.paused ? "not paused" : { patch: { paused: false, ...(r.schedule === null ? {} : { next_due_at: slotAfter(r, now) }) } };
    if (r.paused) return "paused";
    return r.schedule === null ? NO_NEXT_SLOT : { patch: { next_due_at: now.toISOString() as Timestamp } };
  });
}

/**
 * The slot `r` is due for at `now`, or null: a scheduled routine's next slot once it has come; a trigger routine's
 * latest merge (`latest_merge`) when it came after its last run (or, before any, after it was made).
 */
export function dueSlot(r: Routine, now: Date, latest_merge: Timestamp | null): Timestamp | null {
  if (r.schedule !== null) return r.next_due_at !== null && Date.parse(r.next_due_at) <= now.getTime() ? r.next_due_at : null;
  if (r.trigger === "merge" && latest_merge !== null) return latest_merge > (r.last_run_at ?? r.created_at) ? latest_merge : null;
  return null;
}

/** The marks after `r` fires or skips a slot at `now`: a schedule's next slot after now (an interval counts from its creation). */
export function afterSlot(r: Routine, now: Date): RoutineMarks {
  const next = r.schedule === null ? null : nextDue(r.schedule, r.zone, now, new Date(r.created_at));
  return { next_due_at: (next?.toISOString() ?? null) as Timestamp | null, last_run_at: now.toISOString() as Timestamp };
}

/** The known cost of the routine runs among `runs` that finished on the UTC `day`. */
export const spentOn = (runs: readonly Run[], day: string): number => spendTotals(runs.filter((r) => r.kind === "routine" && r.finished_at?.slice(0, 10) === day)).cost_usd;

/** The cost of the last finished routine run among `runs` (by finish time); 0 with none or with no stored cost. */
export function lastCost(runs: readonly Run[]): number {
  const last = runs.filter((r) => r.kind === "routine" && r.finished_at !== null).sort((a, b) => (a.finished_at! < b.finished_at! ? -1 : 1)).at(-1);
  return last ? (outcomeCost(last.outcome) ?? 0) : 0;
}

/** The daily cap of `r` on `day`: its cap plus what `/approve` added that day; null for no cap. */
export function dailyCap(r: Pick<Routine, "daily_cap_usd" | "cap_raise">, day: string): number | null {
  if (r.daily_cap_usd === null) return null;
  return r.daily_cap_usd + (r.cap_raise?.day === day ? r.cap_raise.usd : 0);
}

/** Whether a run like the last one would take the day's spend past the day's cap. */
export const overDailyCap = (cap: number | null, spent: number, last: number): boolean => cap !== null && spent + last > cap;

/** Whether a finished run's cost is over its routine's per-run cap. */
export const overRunCap = (r: Pick<Routine, "run_cap_usd">, cost: number | null): boolean => r.run_cap_usd !== null && cost !== null && cost > r.run_cap_usd;

const local = (id: string): SourceRef => ({ type: "local", id, link: `local:${id}` });
const CARRIER = "routine:";
const HOLD = "routine-cap:";
/** The local system item that carries a routine's runs. */
export const carrierSource = (routine_id: string): SourceRef => local(`${CARRIER}${routine_id}`);
/** The local item that holds `routine_id`'s run for `slot` at its daily cap. */
export const holdSource = (routine_id: string, slot: string): SourceRef => local(`${HOLD}${routine_id}@${slot}`);
/** The routine a carrier item carries; null for any other item. */
export const routineOfCarrier = (it: Pick<WorkItem, "source">): string | null => (it.source.type === "local" && it.source.id.startsWith(CARRIER) ? it.source.id.slice(CARRIER.length) : null);

/** The routine and slot a hold item holds; null for any other item. */
export function routineOfHold(it: Pick<WorkItem, "source">): { routine_id: string; slot: string } | null {
  if (it.source.type !== "local" || !it.source.id.startsWith(HOLD)) return null;
  const rest = it.source.id.slice(HOLD.length), at = rest.lastIndexOf("@");
  return at <= 0 ? null : { routine_id: rest.slice(0, at), slot: rest.slice(at + 1) };
}

/** The run key of `routine_id`'s run for `slot`: a second fire of one slot queues nothing. */
export const routineRunKey = (routine_id: string, slot: string): string => `routine:${routine_id}:${slot}`;

/** The carrier item of `r` in `project`, held as a system item so no stage ever moves it (as the improve runs' item). */
export const carrierItem = (r: Routine, project: string): NewWorkItem => ({
  source: carrierSource(r.id), title: `Routine "${r.name}" runs`, requester_id: r.created_by, project,
  problem: `The system work item that carries routine \`${r.id}\`'s runs. Nothing implements it.`, resources: [],
  hold: { blocked_on: "upstream", blocked_reason: SYSTEM_ITEM },
});

const usd = (n: number) => `$${n.toFixed(2)}`;

/** The hold item of `r`'s run for `slot`, which the daily cap held. */
export function holdItem(r: Routine, project: string, slot: string, spent: number, last: number, cap: number): NewWorkItem {
  const title = `Routine "${r.name}" reached its daily cap`;
  const problem = [
    title, "",
    `Routine \`${r.id}\` has spent ${usd(spent)} today of its ${usd(cap)} daily cap, and its last run cost ${usd(last)}, so its run due ${slot} is held: no model was called.`,
    "",
    `Reply \`/approve\` to raise today's cap by ${usd(last)} (the last run's cost) and run it, or \`/reject <reason>\` to skip this run; the cap holds either way.`,
  ].join("\n");
  return { source: holdSource(r.id, slot), title, requester_id: r.created_by, project, problem, resources: [], hold: { blocked_on: "upstream", blocked_reason: ROUTINE_CAP } };
}

/**
 * What a due routine does now. `fire`: claim its slot (its marks move) and queue its run on the carrier. `skip`: move
 * its marks only (the owner rejected the held run). `hold`: file the hold item (over the daily cap, not yet asked).
 * `wait`: nothing (a run still going, or the hold item waits for its answer).
 */
export type RoutinePlan =
  | { kind: "fire" | "skip"; routine: Routine; slot: Timestamp; read: RoutineMarks; marks: RoutineMarks }
  | { kind: "hold"; routine: Routine; slot: Timestamp; item: NewWorkItem }
  | { kind: "wait"; routine: Routine; slot: Timestamp };

/** What planRoutine reads: the routine due at `slot`, the routine runs on its carrier, and the slot's hold item if filed. */
export interface PlanInput { routine: Routine; slot: Timestamp; now: Date; project: string; runs: readonly Run[]; hold: Pick<WorkItem, "stage" | "close_reason"> | null }

/**
 * The plan for a due routine (see RoutinePlan). A held slot waits for its answer, a new day included; an approved
 * hold fires whatever the cap says (the approve raised it), a rejected one is skipped.
 */
export function planRoutine(p: PlanInput): RoutinePlan {
  const { routine: r, slot, now } = p;
  const read = { next_due_at: r.next_due_at, last_run_at: r.last_run_at };
  if (p.runs.some((x) => x.kind === "routine" && x.finished_at === null)) return { kind: "wait", routine: r, slot };
  if (p.hold?.stage === "CLOSED" && p.hold.close_reason !== "completed") return { kind: "skip", routine: r, slot, read, marks: afterSlot(r, now) };
  if (p.hold && p.hold.stage !== "CLOSED") return { kind: "wait", routine: r, slot };
  const day = utcDay(now.getTime()), spent = spentOn(p.runs, day), last = lastCost(p.runs), cap = dailyCap(r, day);
  if (!p.hold && overDailyCap(cap, spent, last)) return { kind: "hold", routine: r, slot, item: holdItem(r, p.project, slot, spent, last, cap!) };
  return { kind: "fire", routine: r, slot, read, marks: afterSlot(r, now) };
}

/** A Check a page schedule row as the routine it is: its title the name, its action's settings the instruction and page. */
export function routineOfSchedule(s: Schedule): Routine {
  const settings = s.action?.settings ?? {};
  return {
    id: s.id, name: s.title, instruction: String(settings.instruction ?? ""), url: typeof settings.url === "string" ? settings.url : null, schedule: s.cadence,
    zone: s.zone, trigger: s.trigger, run_cap_usd: s.run_cap_usd, daily_cap_usd: s.daily_cap_usd, cap_raise: s.cap_raise, paused: s.paused,
    created_by: s.created_by, created_at: s.created_at, next_due_at: s.next_due_at, last_run_at: s.last_run_at,
  };
}

/** The store reads and writes the Check a page pass makes. */
export type CheckPageStore = Pick<ScheduleStore, "listCheckPages" | "claimCheckPage" | "scheduleTokensUsed"> & Pick<RoutineStore, "updateRoutine"> &
  Pick<FactoryStore, "listMergeEvaluations" | "getWorkItemBySource" | "listRuns" | "createWorkItem" | "transition">;

/**
 * One pass over the unpaused Check a page rows at `now` (design 08-schedules): one read of the latest merge when a
 * row runs on one, then each due row's carrier runs and hold item, planned by planRoutine. A skip moves its marks; a
 * hold files its item and moves it to wait for the owner; a fire claims the slot (claimCheckPage), `checkpoint`
 * instead when its runs used the token cap (overCap). Returns each claim made. Safe on several workers and to run
 * twice: every write is keyed or conditional on the marks read.
 */
export async function runDueCheckPages(store: CheckPageStore, now: Date, project: string): Promise<ScheduleRun[]> {
  const rows = (await store.listCheckPages()).filter((s) => !s.paused);
  const since = rows.filter((s) => s.trigger !== null).map((s) => s.last_run_at ?? s.created_at).sort()[0];
  const latest = since === undefined ? null : ((await store.listMergeEvaluations(since)).at(-1)?.merged_at ?? null);
  const claimed: ScheduleRun[] = [];
  for (const s of rows) {
    const routine = routineOfSchedule(s), slot = dueSlot(routine, now, latest);
    if (slot === null) continue;
    const carrier = await store.getWorkItemBySource("local", carrierSource(s.id).id);
    const runs = carrier ? await store.listRuns(carrier.id) : [];
    const hold = await store.getWorkItemBySource("local", holdSource(s.id, slot).id);
    const plan = planRoutine({ routine, slot, now, project, runs, hold });
    if (plan.kind === "skip") await store.updateRoutine(s.id, plan.read, plan.marks);
    else if (plan.kind === "hold") {
      const { item } = await store.createWorkItem(plan.item, ROUTINES);
      if (item.blocked_on === "upstream") await store.transition({ id: item.id, expected_version: item.version, patch: { blocked_on: "human" }, actor: ROUTINES, reason: ROUTINE_CAP });
    } else if (plan.kind === "fire") {
      const outcome = (await overCap(store, s)) ? "checkpoint" : "fired";
      const run = await store.claimCheckPage({ schedule_id: s.id, occurrence_at: slot, read: plan.read, marks: plan.marks, outcome });
      if (run) claimed.push(run);
    }
  }
  return claimed;
}

/** The store writes that queue a routine run. */
export type RoutineRunStore = Pick<RoutineStore, "getRoutine"> & Pick<FactoryStore, "createWorkItem" | "enqueueRun">;

/**
 * Queues routine `id`'s run for `slot` on its carrier item (made once), keyed on the slot (routineRunKey), so a
 * second call queues nothing: the Check a page action's run. Throws when the routine is gone.
 */
export async function queueRoutineRun(store: RoutineRunStore, project: string, id: string, slot: string): Promise<{ run: Run; created: boolean }> {
  const r = await store.getRoutine(id);
  if (r === null) throw new Error(`no routine ${id}`);
  const { item } = await store.createWorkItem(carrierItem(r, project), ROUTINES);
  return store.enqueueRun({ work_item_id: item.id, kind: "routine", idempotency_key: routineRunKey(id, slot), input: { routine: { instruction: r.instruction, url: r.url } } });
}

/** The slot of routine `routine_id`'s run keyed `key` (routineRunKey); null for another key. */
export function slotOfRun(routine_id: string, key: string): Timestamp | null {
  const prefix = routineRunKey(routine_id, "");
  return key.startsWith(prefix) && key.length > prefix.length ? (key.slice(prefix.length) as Timestamp) : null;
}

/** A finding's fingerprint: its text lowercased, whitespace collapsed and end punctuation dropped, hashed. */
export const fingerprint = (text: string): string => cyrb53(text.toLowerCase().replace(/\s+/g, " ").trim().replace(/[.!;:,]+$/, ""));

/**
 * The finding texts of a routine run's stored answer (`data.routine`, src/worker/runs/routine/routine.run.ts): none
 * for `pass` or an answer that does not parse, and no empty text. Read here as well, since the worker imports no core/.
 */
export function routineFindings(answer: unknown): string[] {
  const o = typeof answer === "object" && answer !== null ? (answer as { verdict?: unknown; findings?: unknown }) : {};
  if (o.verdict !== "bug" || !Array.isArray(o.findings)) return [];
  return (o.findings as { text?: unknown }[]).flatMap((f) => (typeof f?.text === "string" && f.text.trim() !== "" ? [f.text.trim()] : []));
}
