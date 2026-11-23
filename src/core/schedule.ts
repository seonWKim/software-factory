// Schedules (design 08-schedules): a schedule is its own stored record (`controller_schedules`), never a plain
// task's repeat. Each due occurrence is claimed by one conditional store update that moves `next_due_at` from the
// value the worker read; a second worker that read the same value changes nothing and fires nothing. Slots missed
// while no worker ran are one occurrence on return, recorded against the slot it was due for. A due occurrence of a
// schedule still running is refused, and the refusal is a run row too. A schedule with `skip_when_busy` on skips a
// due occurrence while the store holds the threshold or more queued implement runs: a `skipped` run row with the
// count, `next_due_at` moved on, never run later. A schedule whose action calls a model and whose runs used its
// token cap holds a due occurrence at a `checkpoint`: no model is called, the schedule stays idle, and a local item
// asks the owner, whose common `/approve` raises the cap and runs it and whose `/reject` ends it as `rejected`. Pure
// decisions over a ScheduleStore; the caller's tick supplies the time, and `fired` says which occurrences are to run.

import type { FactoryStore } from "../interfaces/factory-store.js";
import { overBudget } from "./budget.js";
import { type Cadence, cadenceProblem, nextDue } from "./schedule-cadence.js";
import type { Actor, Timestamp, UserId, WorkItem } from "./types.js";

/** What a claim made of a due occurrence: fired to run, refused (still running), skipped (busy) or held at a checkpoint (over its token cap). */
export type ClaimOutcome = "fired" | "refused" | "skipped" | "checkpoint";
/** A run row's outcome: its claim's, or `rejected` once the owner rejected a held checkpoint. */
export type ScheduleOutcome = ClaimOutcome | "rejected";

/** Queued implement runs at which a `skip_when_busy` schedule skips its due occurrence (the owner's "under 15"). */
export const SKIP_WHEN_BUSY_THRESHOLD = 15;

/** What a fired occurrence does: file one work item, run one read-only agent, or file the feedback agent's tasks. */
export type ScheduleActionKind = "build" | "agent" | "feedback";
export const SCHEDULE_ACTION_KINDS: readonly ScheduleActionKind[] = ["build", "agent", "feedback"];
/** The kinds that call a model, so the schedule's token cap holds them. */
const MODEL_KINDS: ReadonlySet<ScheduleActionKind> = new Set(["agent", "feedback"]);

/** A schedule's action: its kind and its settings (build `title`, `body`; agent `prompt`; feedback `prompt`, `max_tasks`). */
export interface ScheduleActionSpec {
  kind: ScheduleActionKind;
  settings: Readonly<Record<string, unknown>>;
}

/** Tokens a schedule's runs may use in total before a due occurrence is held (owner value), and what an `/approve` adds. */
export const SCHEDULE_TOKEN_CAP = 200_000;

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
  /** What a fired occurrence does; null: none, and the selected ScheduleAction refuses it. */
  action: ScheduleActionSpec | null;
  /** Tokens its runs may use in total; null: SCHEDULE_TOKEN_CAP. */
  token_cap: number | null;
}

export type NewSchedule = Omit<Schedule, "running_since" | "skip_when_busy" | "action" | "token_cap"> &
  { skip_when_busy?: boolean; action?: ScheduleActionSpec | null; token_cap?: number | null };

/** One row per claimed occurrence, unique per (schedule_id, occurrence_at). */
export interface ScheduleRun {
  schedule_id: string;
  /** The slot it was due for, not the time it was claimed. */
  occurrence_at: Timestamp;
  outcome: ScheduleOutcome;
  recorded_at: Timestamp;
  /** The queued implement runs a `skipped` occurrence saw; absent on every other outcome. */
  queued_implement_runs?: number;
  /** The action's result, egress-scanned; absent until the action recorded one. */
  output?: string;
  /** Tokens its model calls used, summed over every time it ran; absent until recorded. */
  tokens?: number;
  /** Their cost in USD as the harness reported it; absent when none was reported. */
  cost_usd?: number;
}

export interface ScheduleClaim {
  schedule_id: string;
  /** The `next_due_at` the worker read; the claim applies only while it is still stored. */
  occurrence_at: Timestamp;
  next_due_at: Timestamp | null;
  outcome: ClaimOutcome;
  /** Stored on the run row of a `skipped` claim. */
  queued_implement_runs?: number;
}

/** What an action's run used, added to its run row. */
export interface ScheduleRunResult {
  output: string;
  tokens: number;
  cost_usd: number | null;
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
   * idle (`fired`, which also sets `running_since`, or `skipped` and `checkpoint`, which do not) or running
   * (`refused`), and stores the run row in the same transaction. Null when the claim was lost: another worker
   * moved it first, or the schedule changed state.
   */
  claimScheduleOccurrence(c: ScheduleClaim): Promise<ScheduleRun | null>;
  /** Clears `running_since` only while it is still `running_since`; false when it was not. */
  endScheduleRun(schedule_id: string, running_since: Timestamp): Promise<boolean>;
  /** Every run row of the schedule, oldest occurrence first. Read-only. */
  listScheduleRuns(schedule_id: string): Promise<ScheduleRun[]>;
  /** Implement runs waiting to be claimed (status `queued`). Read-only. */
  countQueuedImplementRuns(): Promise<number>;
  /** Sets the run's output and adds its tokens and cost to what the row holds (a rerun's model calls count too). */
  recordScheduleRunResult(schedule_id: string, occurrence_at: Timestamp, r: ScheduleRunResult): Promise<void>;
  /** The tokens the schedule's runs used, summed. Read-only. */
  scheduleTokensUsed(schedule_id: string): Promise<number>;
  /** Every run row held at a checkpoint, oldest first. Read-only. */
  listHeldScheduleRuns(): Promise<ScheduleRun[]>;
  /**
   * One transaction: moves the held run to `fired` and sets the schedule's `token_cap` and `running_since`, only
   * while the run is still held and the schedule idle. Returns the `running_since` it set; null when it did not.
   */
  resumeHeldScheduleRun(schedule_id: string, occurrence_at: Timestamp, token_cap: number): Promise<Timestamp | null>;
  /** Moves the held run to `rejected` only while it is still held; false when it was not. */
  rejectHeldScheduleRun(schedule_id: string, occurrence_at: Timestamp): Promise<boolean>;
}

export type AddScheduleInput = Pick<Schedule, "id" | "title" | "cadence" | "zone" | "created_by"> &
  { skip_when_busy?: boolean; action?: ScheduleActionSpec | null; token_cap?: number | null };

/** Why `action` and `token_cap` cannot be stored, or null. */
function actionProblem(action: ScheduleActionSpec | null | undefined, cap: number | null | undefined): string | null {
  if (action && !SCHEDULE_ACTION_KINDS.includes(action.kind)) return `unknown action kind "${String(action.kind)}": one of ${SCHEDULE_ACTION_KINDS.join(", ")}`;
  if (action && (typeof action.settings !== "object" || action.settings === null || Array.isArray(action.settings))) return "the action's settings must be an object";
  if (cap != null && (!Number.isSafeInteger(cap) || cap < 1)) return "the token cap must be a whole number of tokens of at least 1";
  return null;
}

/** Stores a new schedule, first due at its cadence's next slot after `now`; refused with the cadence's or the action's problem. */
export async function addSchedule(store: ScheduleStore, input: AddScheduleInput, now: Date): Promise<{ ok: true; schedule: Schedule } | { ok: false; problem: string }> {
  const problem = cadenceProblem(input.cadence, input.zone) ?? actionProblem(input.action, input.token_cap);
  if (problem) return { ok: false, problem };
  const first = nextDue(input.cadence, input.zone, now, now);
  if (!first) return { ok: false, problem: "the cadence never falls due" };
  const schedule = await store.addSchedule({ ...input, created_at: now.toISOString() as Timestamp, next_due_at: first.toISOString() as Timestamp });
  return { ok: true, schedule };
}

/** The schedule's token cap: its own, else SCHEDULE_TOKEN_CAP. */
export const tokenCap = (s: Pick<Schedule, "token_cap">): number => s.token_cap ?? SCHEDULE_TOKEN_CAP;

/** Whether a due occurrence of `s` is held: its action calls a model and its runs used its cap (budget's overBudget). */
async function overCap(store: ScheduleStore, s: Schedule): Promise<boolean> {
  return s.action !== null && MODEL_KINDS.has(s.action.kind) && overBudget(await store.scheduleTokensUsed(s.id), tokenCap(s));
}

/**
 * One pass over the due schedules at `now`: each due occurrence is claimed once, its next due time the first slot
 * after `now` (so missed slots make one occurrence), fired when idle, refused when running, skipped when idle,
 * set to skip when busy and the store holds `busy_threshold` or more queued implement runs (counted once per pass,
 * only when such a schedule is due), and held at a checkpoint when idle and over its token cap. Safe to run on
 * several workers at once and to run twice: a lost claim fires nothing.
 */
export async function runDueSchedules(
  store: ScheduleStore, now: Date, { busy_threshold = SKIP_WHEN_BUSY_THRESHOLD }: { busy_threshold?: number } = {},
): Promise<Record<ClaimOutcome, ScheduleRun[]>> {
  const runs: Record<ClaimOutcome, ScheduleRun[]> = { fired: [], refused: [], skipped: [], checkpoint: [] };
  let queued: number | undefined;
  for (const s of await store.listDueSchedules(now.toISOString() as Timestamp)) {
    const next = nextDue(s.cadence, s.zone, now, new Date(s.created_at));
    let outcome: ClaimOutcome = s.running_since === null ? "fired" : "refused";
    if (outcome === "fired" && s.skip_when_busy && (queued ??= await store.countQueuedImplementRuns()) >= busy_threshold) outcome = "skipped";
    if (outcome === "fired" && (await overCap(store, s))) outcome = "checkpoint";
    const run = await store.claimScheduleOccurrence({
      schedule_id: s.id, occurrence_at: s.next_due_at!, next_due_at: next === null ? null : (next.toISOString() as Timestamp), outcome,
      ...(outcome === "skipped" ? { queued_implement_runs: queued! } : {}),
    });
    if (run) runs[outcome].push(run);
  }
  return runs;
}

// The checkpoint's item (design 08-schedules): a local work item per held occurrence, its source ID from the
// schedule and the slot, so a second pass finds it. It waits for a person; the common `/approve` closes it as
// completed (approveCheck, src/core/request-transition.ts) and `/reject` closes it as rejected; the next pass reads
// that answer and runs or rejects the held occurrence.

/** blocked_reason of a held occurrence's item; and the reason of the `/approve` that answers it. */
export const SCHEDULE_CHECKPOINT = "schedule_checkpoint";
export const SCHEDULE_CHECKPOINT_APPROVED = "schedule_checkpoint_approved";
/** The actor of the checkpoint item's writes. */
const SCHEDULER: Actor = { kind: "system", id: "system:schedule" };

/** A slot as an ID part: `2026-11-23T00:00:00.000Z` → `20261123T000000Z`. */
export const slotKey = (occurrence_at: string): string => occurrence_at.replace(/[-:]|\.\d+/g, "");
/** The source ID of the item that holds `schedule_id`'s occurrence at `occurrence_at`. */
export const checkpointSourceId = (schedule_id: string, occurrence_at: string): string => `schedule-checkpoint-${schedule_id}-${slotKey(occurrence_at)}`;

/** The cap an `/approve` sets: SCHEDULE_TOKEN_CAP more than the cap, or than what was used when that is more. */
export const raisedCap = (cap: number, used: number): number => Math.max(cap, used) + SCHEDULE_TOKEN_CAP;

/** The store reads and writes of the checkpoint item. */
export type CheckpointStore = ScheduleStore & Pick<FactoryStore, "createWorkItem" | "getWorkItemBySource" | "transition">;

/** The owner's answer a held occurrence has: none yet, `/approve` (run it with the cap given) or `/reject`. */
export type CheckpointAnswer = { answer: "waiting" } | { answer: "approved"; token_cap: number } | { answer: "rejected" };

/**
 * The answer to the held run `run` of `s`, read from its item; with no item yet, files it in `project` (idempotent
 * on its source ID) and moves it to wait for a person. Safe to run twice.
 */
export async function checkpointAnswer(store: CheckpointStore, project: string, s: Schedule, run: Pick<ScheduleRun, "occurrence_at">): Promise<CheckpointAnswer> {
  const used = await store.scheduleTokensUsed(s.id);
  const source_id = checkpointSourceId(s.id, run.occurrence_at);
  let item = await store.getWorkItemBySource("local", source_id);
  if (item?.stage === "CLOSED") return item.close_reason === "completed" ? { answer: "approved", token_cap: raisedCap(tokenCap(s), used) } : { answer: "rejected" };
  item ??= await fileCheckpoint(store, project, s, run.occurrence_at, used, source_id);
  if (item.blocked_on === "upstream" && item.blocked_reason === SCHEDULE_CHECKPOINT) {
    await store.transition({ id: item.id, expected_version: item.version, patch: { blocked_on: "human" }, actor: SCHEDULER, reason: SCHEDULE_CHECKPOINT });
  }
  return { answer: "waiting" };
}

async function fileCheckpoint(store: CheckpointStore, project: string, s: Schedule, slot: Timestamp, used: number, source_id: string): Promise<WorkItem> {
  const source = { type: "local", id: source_id, link: `local:${source_id}` };
  const title = `Schedule "${s.title}" reached its token cap`;
  const problem = [
    title, "",
    `Schedule \`${s.id}\` used ${used} tokens of its ${tokenCap(s)}-token cap, so its occurrence due ${slot} was held: no model was called, and its next occurrences still come due.`,
    "",
    `Reply \`/approve\` to raise the cap to ${raisedCap(tokenCap(s), used)} tokens and run the held occurrence, or \`/reject <reason>\` to end it as rejected.`,
  ].join("\n");
  const { item } = await store.createWorkItem(
    { source, title, requester_id: s.created_by, project, problem, resources: [], hold: { blocked_on: "upstream", blocked_reason: SCHEDULE_CHECKPOINT } }, SCHEDULER,
  );
  return item;
}
