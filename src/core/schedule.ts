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
import { type Cadence, type CadenceKind, cadenceProblem, nextDue } from "./schedule-cadence.js";
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
  /**
   * One UPDATE: sets only the patch's fields, only while `next_due_at` is still `read` (IS NULL when null), so an edit,
   * pause, resume or run loses to a claim or another write made since its read. False when no row changed.
   */
  updateSchedule(id: string, read: Timestamp | null, patch: SchedulePatch): Promise<boolean>;
  /** The store's Clock's time: the `now` the CLI's schedule writes decide at (the CLI has no Clock of its own). */
  scheduleNow(): Timestamp;
}

/** The fields an edit, pause, resume or run may change. */
export type SchedulePatch = Partial<Pick<Schedule, "title" | "cadence" | "zone" | "next_due_at" | "skip_when_busy" | "action" | "token_cap">>;

export type AddScheduleInput = Pick<Schedule, "id" | "title" | "cadence" | "zone" | "created_by"> &
  { skip_when_busy?: boolean; action?: ScheduleActionSpec | null; token_cap?: number | null };

/** A write's result: the schedule as stored, or why nothing was stored. */
export type ScheduleResult = { ok: true; schedule: Schedule } | { ok: false; problem: string };

/** Why `action` and `token_cap` cannot be stored, or null. */
function actionProblem(action: ScheduleActionSpec | null | undefined, cap: number | null | undefined): string | null {
  if (action && !SCHEDULE_ACTION_KINDS.includes(action.kind)) return `unknown action kind "${String(action.kind)}": one of ${SCHEDULE_ACTION_KINDS.join(", ")}`;
  if (action && (typeof action.settings !== "object" || action.settings === null || Array.isArray(action.settings))) return "the action's settings must be an object";
  if (cap != null && (!Number.isSafeInteger(cap) || cap < 1)) return "the token cap must be a whole number of tokens of at least 1";
  return null;
}

/** Stores a new schedule, first due at its cadence's next slot after `now`; refused with the cadence's or the action's problem. */
export async function addSchedule(store: Pick<ScheduleStore, "addSchedule">, input: AddScheduleInput, now: Date): Promise<ScheduleResult> {
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

/** The source ID of the item that holds `schedule_id`'s occurrence at `occurrence_at` (slot `2026-11-23T00:00:00.000Z` → `20261123T000000Z`). */
export const checkpointSourceId = (schedule_id: string, occurrence_at: string): string => `schedule-checkpoint-${schedule_id}-${occurrence_at.replace(/[-:]|\.\d+/g, "")}`;

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

// Managing schedules (design 08-schedules): `factory schedule …` and the /api/v1/schedules routes call the same
// functions. Each write reads the schedule, decides, then writes once through `updateSchedule`, conditional on the
// `next_due_at` it read: a claim or another write since then makes it change nothing. Pause clears `next_due_at`, so
// a paused schedule is never listed due and its slots never fire; resume sets the first slot after now; run sets now,
// so the next tick claims it once.

/** The store methods managing schedules reads and writes through. */
export type ScheduleAdminStore = Pick<ScheduleStore, "listSchedules" | "listScheduleRuns" | "addSchedule" | "updateSchedule" | "scheduleNow">;

/** The refusal of a write whose condition was lost. */
export const SCHEDULE_LOST = "changed by another worker, try again";

/** A schedule's fields as the CLI's flags and an HTTP body give them; each absent when not given. */
export interface ScheduleFields {
  title?: string;
  cadence?: string;
  spec?: string;
  zone?: string;
  action?: string;
  /** build: the item's body; agent and feedback: the prompt. */
  body?: string;
  skip_when_busy?: boolean;
  token_cap?: number;
}

/** The writes, each the owner's only. */
export type ScheduleWrite = "add" | "edit" | "pause" | "resume" | "run";

/** The action a kind and a body make (the CLI and the HTTP routes): build `body`, agent and feedback `prompt`, which they need. */
export function scheduleActionOf(kind: string, body: string | undefined): ScheduleActionSpec | { problem: string } {
  if (!(SCHEDULE_ACTION_KINDS as readonly string[]).includes(kind)) return { problem: `unknown action kind "${kind}": one of ${SCHEDULE_ACTION_KINDS.join(", ")}` };
  const text = body?.trim() ?? "";
  if (kind === "build") return { kind, settings: text === "" ? {} : { body: text } };
  if (text === "") return { problem: `a${kind === "agent" ? "n" : ""} ${kind} action needs a body (--body): its prompt` };
  return { kind: kind as ScheduleActionKind, settings: { prompt: text } };
}

const refused = (problem: string): ScheduleResult => ({ ok: false, problem });
const findSchedule = async (store: ScheduleAdminStore, id: string): Promise<Schedule | null> => (await store.listSchedules()).find((s) => s.id === id) ?? null;
/** The first slot of `c` in `zone` after `now`, an interval counted from the schedule's creation (as the claim counts it). */
function firstSlot(c: Cadence, zone: string, now: Date, created_at: Timestamp): Timestamp | null {
  const next = nextDue(c, zone, now, new Date(created_at));
  return next === null ? null : (next.toISOString() as Timestamp);
}

/** Stores a new schedule from its fields; refused when one is missing or bad, or the ID is already stored. */
export async function createSchedule(store: ScheduleAdminStore, id: string, f: ScheduleFields, created_by: UserId, now: Date): Promise<ScheduleResult> {
  const missing = [...(id.trim() ? [] : ["id"]), ...(["title", "cadence", "spec", "zone", "action"] as const).filter((k) => !f[k]?.trim())];
  if (missing.length > 0) return refused(`missing ${missing.join(", ")}`);
  const action = scheduleActionOf(f.action!, f.body);
  if ("problem" in action) return refused(action.problem);
  const cadence = { kind: f.cadence!.trim() as CadenceKind, spec: f.spec!.trim() };
  const problem = cadenceProblem(cadence, f.zone!.trim()) ?? actionProblem(action, f.token_cap);
  if (problem) return refused(problem);
  const exists = `schedule ${id} is already stored`;
  if (await findSchedule(store, id)) return refused(exists);
  const r = await addSchedule(store, {
    id, title: f.title!.trim(), cadence, zone: f.zone!.trim(), created_by, action, skip_when_busy: f.skip_when_busy ?? false, token_cap: f.token_cap ?? null,
  }, now);
  // Another worker stored the ID between the read and the insert: theirs stays.
  return r.ok && r.schedule.created_at !== now.toISOString() ? refused(exists) : r;
}

/** Reads the schedule, decides its patch (or a refusal), and writes it once, conditional on the `next_due_at` read. */
async function decide(store: ScheduleAdminStore, id: string, patchOf: (s: Schedule) => SchedulePatch | string): Promise<ScheduleResult> {
  const s = await findSchedule(store, id);
  if (s === null) return refused(`no schedule ${id}`);
  const patch = patchOf(s);
  if (typeof patch === "string") return refused(patch);
  if (!(await store.updateSchedule(id, s.next_due_at, patch))) return refused(SCHEDULE_LOST);
  return { ok: true, schedule: { ...s, ...patch } };
}

/** Clears `next_due_at`, so no slot comes due; refused when it is already clear. */
export const pauseSchedule = (store: ScheduleAdminStore, id: string, _now: Date): Promise<ScheduleResult> =>
  decide(store, id, (s) => (s.next_due_at === null ? "already paused" : { next_due_at: null }));

/** Sets `next_due_at` to the first slot after `now`; refused when it is set, or the cadence never falls due. */
export const resumeSchedule = (store: ScheduleAdminStore, id: string, now: Date): Promise<ScheduleResult> =>
  decide(store, id, (s) => {
    if (s.next_due_at !== null) return "not paused";
    const next = firstSlot(s.cadence, s.zone, now, s.created_at);
    return next === null ? "never falls due" : { next_due_at: next };
  });

/** Sets `next_due_at` to `now`, so the next tick claims it once (a running schedule's as `refused`); refused when paused. */
export const runSchedule = (store: ScheduleAdminStore, id: string, now: Date): Promise<ScheduleResult> =>
  decide(store, id, (s) => (s.next_due_at === null ? "paused" : { next_due_at: now.toISOString() as Timestamp }));

/**
 * Changes only the fields given; refused with no field, or a bad cadence, zone, action or token cap. A changed cadence
 * or zone on an unpaused schedule sets `next_due_at` to its first slot after `now`; a paused one stays paused.
 */
export async function editSchedule(store: ScheduleAdminStore, id: string, f: ScheduleFields, now: Date): Promise<ScheduleResult> {
  if (Object.values(f).every((v) => v === undefined)) return refused("nothing to change: give at least one field");
  return decide(store, id, (s) => {
    const patch: SchedulePatch = {};
    if (f.title !== undefined) {
      if (!f.title.trim()) return "the title cannot be empty";
      patch.title = f.title.trim();
    }
    if (f.cadence !== undefined || f.spec !== undefined || f.zone !== undefined) {
      const cadence = { kind: (f.cadence?.trim() ?? s.cadence.kind) as CadenceKind, spec: f.spec?.trim() ?? s.cadence.spec };
      const zone = f.zone?.trim() ?? s.zone;
      const problem = cadenceProblem(cadence, zone);
      if (problem) return problem;
      if (f.cadence !== undefined || f.spec !== undefined) patch.cadence = cadence;
      if (f.zone !== undefined) patch.zone = zone;
      if (s.next_due_at !== null) {
        const next = firstSlot(cadence, zone, now, s.created_at);
        if (next === null) return "the cadence never falls due";
        patch.next_due_at = next;
      }
    }
    if (f.action !== undefined || f.body !== undefined) {
      const kind = f.action ?? s.action?.kind;
      if (kind === undefined) return "the schedule has no action: give --action too";
      const old = s.action?.kind === kind ? s.action.settings : {};
      const action = scheduleActionOf(kind, f.body ?? String(old.body ?? old.prompt ?? ""));
      if ("problem" in action) return action.problem;
      patch.action = { kind: action.kind, settings: { ...old, ...action.settings } };
    }
    if (f.skip_when_busy !== undefined) patch.skip_when_busy = f.skip_when_busy;
    if (f.token_cap !== undefined) {
      const problem = actionProblem(null, f.token_cap);
      if (problem) return problem;
      patch.token_cap = f.token_cap;
    }
    return patch;
  });
}

/** One write, as the CLI and the HTTP routes run it; `fields` only for add and edit. */
export function writeSchedule(store: ScheduleAdminStore, w: ScheduleWrite, id: string, fields: ScheduleFields, user: UserId, now: Date): Promise<ScheduleResult> {
  if (w === "add") return createSchedule(store, id, fields, user, now);
  if (w === "edit") return editSchedule(store, id, fields, now);
  return { pause: pauseSchedule, resume: resumeSchedule, run: runSchedule }[w](store, id, now);
}

// `factory schedule …` (src/core/local-cli.ts hands the word here, as it stays within its size budget).

export type ScheduleCommand = { verb: "list" } | { verb: "runs"; id: string } | { verb: ScheduleWrite; id: string; fields: ScheduleFields };

const FLAGS: Readonly<Record<string, keyof ScheduleFields>> = {
  "--title": "title", "--cadence": "cadence", "--spec": "spec", "--zone": "zone", "--action": "action", "--body": "body", "--skip-when-busy": "skip_when_busy", "--token-cap": "token_cap",
};

/** The words after `factory schedule`, or why they are no command (nothing is read or written). */
export function parseScheduleArgs(args: readonly string[]): ScheduleCommand | string {
  const [verb = "", ...rest] = args;
  if (verb === "list") return rest.length === 0 ? { verb } : "schedule list takes no arguments";
  if (verb === "runs" || verb === "pause" || verb === "resume" || verb === "run") {
    if (rest.length !== 1 || !rest[0]) return `schedule ${verb} needs one schedule ID`;
    return verb === "runs" ? { verb, id: rest[0] } : { verb, id: rest[0], fields: {} };
  }
  if (verb !== "add" && verb !== "edit") return `unknown schedule command ${JSON.stringify(verb)}`;
  let id = verb === "edit" ? rest.shift() : undefined;
  if (verb === "edit" && (id === undefined || id.startsWith("--"))) return "schedule edit needs a schedule ID, then the flags to change";
  const fields: ScheduleFields = {};
  for (let i = 0; i < rest.length; i += 2) {
    const [flag, v] = [rest[i]!, rest[i + 1]];
    const key = FLAGS[flag];
    if (v === undefined || (flag === "--id" ? verb === "edit" || id !== undefined : key === undefined || key in fields)) return `schedule ${verb}: unexpected ${JSON.stringify(flag)}`;
    if (flag === "--id") id = v;
    else if (key === "skip_when_busy") {
      if (v !== "on" && v !== "off") return "--skip-when-busy takes on or off";
      fields.skip_when_busy = v === "on";
    } else if (key === "token_cap") {
      if (!/^\d+$/.test(v)) return "--token-cap takes a whole number of tokens";
      fields.token_cap = Number(v);
    } else fields[key!] = v;
  }
  if (id === undefined) return "schedule add needs --id <id>";
  return { verb, id, fields };
}

/** One schedule as `schedule list` prints it. */
export const scheduleLine = (s: Schedule): string => [
  s.id, s.title, s.next_due_at ?? "paused", s.running_since === null ? "idle" : "running", s.action?.kind ?? "no action",
  `skip when busy ${s.skip_when_busy ? "on" : "off"}`, `token cap ${tokenCap(s)}`,
].join("\t");

const runLine = (r: ScheduleRun): string =>
  [r.occurrence_at, r.outcome, r.recorded_at, `${r.tokens ?? 0} tokens`, r.cost_usd === undefined ? "no cost" : `$${r.cost_usd}`].join("\t");

/** Runs one `factory schedule` command as `user`; a write first asks `isOwner` (which may make `user` the owner). */
export async function runScheduleCommand(store: ScheduleAdminStore, c: ScheduleCommand, user: UserId, isOwner: () => Promise<boolean>): Promise<{ code: number; lines: string[] }> {
  const fail = (line: string) => ({ code: 1, lines: [line] });
  if (c.verb === "list") {
    const all = await store.listSchedules();
    return { code: 0, lines: all.length === 0 ? ["no schedules"] : all.map(scheduleLine) };
  }
  if (c.verb === "runs") {
    if ((await findSchedule(store, c.id)) === null) return fail(`no schedule ${c.id}`);
    const runs = await store.listScheduleRuns(c.id);
    return { code: 0, lines: runs.length === 0 ? [`no runs of ${c.id}`] : runs.map(runLine) };
  }
  if (!(await isOwner())) return fail(`schedule ${c.verb} refused: only the owner manages schedules; you are ${user}`);
  const r = await writeSchedule(store, c.verb, c.id, c.fields, user, new Date(store.scheduleNow()));
  if (!r.ok) return fail(`schedule ${c.verb} ${c.id} refused: ${r.problem}`);
  const done = { add: "added", edit: "edited", pause: "paused", resume: "resumed", run: "set to run on the next tick:" }[c.verb];
  return { code: 0, lines: [`${done} ${scheduleLine(r.schedule)}`] };
}
