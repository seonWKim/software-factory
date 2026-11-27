// Schedules (design 08-schedules): a schedule is its own stored record (`controller_schedules`), never a plain
// task's repeat. Each due occurrence is claimed by one conditional store update that moves `next_due_at` from the
// value the worker read; a second worker that read the same value changes nothing and fires nothing. Slots missed
// while no worker ran are one occurrence on return, recorded against the slot it was due for. A due occurrence of a
// schedule still running is refused, and the refusal is a run row too. A schedule whose `missed_rule` is `skip` skips
// a due occurrence claimed more than one tick after its slot (a `skipped` run row with no count), or while the store
// holds the threshold or more queued implement runs (a `skipped` run row with the count); either way `next_due_at`
// moves on and the slot never runs later. A `catch_up` schedule fires its due occurrence once, however late or busy. A schedule whose action calls a model and whose runs used its
// token cap (a `day` cap: the runs of the slot's UTC date; `lifetime`: all of them) holds a due occurrence at a `checkpoint`: no model is called, the schedule stays idle, and a local item
// asks the owner, whose common `/approve` raises the cap and runs it and whose `/reject` ends it as `rejected`. Pure
// decisions over a ScheduleStore; the caller's tick supplies the time, and `fired` says which occurrences are to run.

import type { FactoryStore } from "../interfaces/factory-store.js";
import { overBudget } from "./budget.js";
import { type Cadence, type CadenceKind, cadenceProblem, nextDue } from "./schedule-cadence.js";
import { grantsLine, scheduleIdProblem, withGrantWords } from "./schedule-grants.js";
import type { Actor, Timestamp, UserId, WorkItem } from "./types.js";

/** The triggers a routine may run on: `merge`, a change merged into the base branch since the routine's last run. */
export const ROUTINE_TRIGGERS = ["merge"] as const; export type RoutineTrigger = (typeof ROUTINE_TRIGGERS)[number];
/** What a claim made of a due occurrence: fired to run, refused (still running), skipped (busy) or held at a checkpoint (over its token cap). */
export type ClaimOutcome = "fired" | "refused" | "skipped" | "checkpoint";
/** A run row's outcome: its claim's, or `rejected` once the owner rejected a held checkpoint. */
export type ScheduleOutcome = ClaimOutcome | "rejected";

/** Queued implement runs at which a `skip` schedule skips its due occurrence (the owner's "under 15"). */
export const SKIP_WHEN_BUSY_THRESHOLD = 15;
/** What a schedule does with a due occurrence claimed late or while busy: `catch_up` fires it once, `skip` drops it. */
export type MissedRule = "catch_up" | "skip";

/**
 * What a fired occurrence does: file one work item, run one read-only agent, file the feedback agent's tasks, queue
 * the daily improve run of its slot's UTC day, queue a routine run (Check a page, src/core/check-page.ts), or post the
 * owner's summary (src/core/summary.ts). Stored and routed; schedule add and edit (and the HTTP routes) write every
 * kind but those setup adds (SETUP_ONLY_KINDS), and name `check_page` `check-page` (SCHEDULE_WRITE_WORDS). */
export type ScheduleActionKind = "build" | "agent" | "feedback" | "improve" | "check_page" | "summary";
export const SCHEDULE_ACTION_KINDS: readonly ScheduleActionKind[] = ["build", "agent", "feedback", "improve", "check_page", "summary"];
const SETUP_ONLY_KINDS: Readonly<Record<string, string>> = { improve: "improver.daily_trigger off", summary: "the owner's summary posts" };
/** The action words `schedule add` and `schedule edit` accept (design 08-schedules), and the kind each stores. */
const SCHEDULE_WRITE_WORDS: Readonly<Record<string, ScheduleActionKind>> = { build: "build", agent: "agent", feedback: "feedback", "check-page": "check_page", check_page: "check_page" };
const WRITE_WORDS = "build, agent, feedback, check-page";
/** The cadence word of a Check a page schedule that runs on each merge, not on a cadence (its `trigger` merge). */
export const ON_MERGE = "on-merge";
/** The kinds that call a model, so the schedule's token cap holds them. */
const MODEL_KINDS: ReadonlySet<ScheduleActionKind> = new Set(["agent", "feedback", "check_page"]);

/** A schedule's action: its kind and its settings (build `title`, `body`; agent `prompt`; feedback `prompt`, `max_tasks`; check_page `instruction`, `url`, read from the row's own columns). */
export interface ScheduleActionSpec {
  kind: ScheduleActionKind;
  settings: Readonly<Record<string, unknown>>;
}

/** Tokens a schedule's runs may use in its cap period before a due occurrence is held (owner value), and what an `/approve` adds. */
export const SCHEDULE_TOKEN_CAP = 200_000;

/** The runs a token cap counts: `day`, those whose occurrence falls on the UTC date of the slot claimed; `lifetime`, all. */
export type TokenPeriod = "day" | "lifetime";

export interface Schedule {
  id: string;
  title: string;
  /** Null for a Check a page row with a trigger instead (a routine's trigger form). */
  cadence: Cadence | null;
  /** IANA zone name: the cadence's wall clock. */
  zone: string;
  /** The owner's user ID, never a display name. */
  created_by: UserId;
  created_at: Timestamp;
  /** The occurrence the next claim takes; null when the cadence never falls due again. */
  next_due_at: Timestamp | null;
  /** When the fired occurrence started; null while idle. */
  running_since: Timestamp | null;
  /** `skip`: a due occurrence claimed more than a tick late, or while SKIP_WHEN_BUSY_THRESHOLD implement runs are queued, is skipped; `catch_up` when unset. */
  missed_rule: MissedRule;
  /** What a fired occurrence does; null: none, and the selected ScheduleAction refuses it. */
  action: ScheduleActionSpec | null;
  /** Tokens its runs may use in its `token_period`; null: SCHEDULE_TOKEN_CAP. */
  token_cap: number | null;
  /** The runs its token cap counts; null (stored before the period existed) resolves from the cadence (tokenPeriod). */
  token_period: TokenPeriod | null;
  /** A Check a page row's trigger form (a routine's); null with a cadence. */
  trigger: RoutineTrigger | null;
  /** The most one run may cost in USD; null for no cap. */
  run_cap_usd: number | null;
  /** The most its runs may cost in one UTC day, in USD; null for no cap. */
  daily_cap_usd: number | null;
  /** What `/approve` added to the daily cap, on `day`, and the hold item it answered. */
  cap_raise: { usd: number; day: string; hold_key: string } | null;
  /** Paused by a run over its run cap (a Check a page row); a schedule's pause clears `next_due_at` instead. */
  paused: boolean;
  /** When it last fired or skipped a slot; null before its first. */
  last_run_at: Timestamp | null;
}

/** The fields a new row may leave out: each defaults to off, none or null. */
type Defaulted = "running_since" | "missed_rule" | "action" | "token_cap" | "token_period" | "trigger" | "run_cap_usd" | "daily_cap_usd" | "cap_raise" | "paused" | "last_run_at";
export type NewSchedule = Omit<Schedule, Defaulted> & Partial<Pick<Schedule, Exclude<Defaulted, "running_since">>>;

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

/**
 * The claim of a Check a page occurrence (design 08-schedules): its marks move from `read` to `marks` (a trigger row
 * has no `next_due_at` to claim on), `fired` or held at a `checkpoint`, with the run row for `occurrence_at`.
 */
export interface CheckPageClaim {
  schedule_id: string;
  occurrence_at: Timestamp;
  read: Pick<Schedule, "next_due_at" | "last_run_at">;
  marks: Pick<Schedule, "next_due_at" | "last_run_at">;
  outcome: "fired" | "checkpoint";
}

/** What an action's run used, added to its run row. */
export interface ScheduleRunResult {
  output: string;
  tokens: number;
  cost_usd: number | null;
}

/** The store's schedule methods, part of FactoryStore. */
export interface ScheduleStore {
  /** Inserts the schedule unless its ID is stored (a Check a page row's `instruction` and `url` in their columns); returns the stored row either way. */
  addSchedule(s: NewSchedule): Promise<Schedule>;
  /** Every schedule, oldest first; no Check a page row unless `check_pages` (the CLI's list and every write's read). Read-only. */
  listSchedules(opts?: { check_pages?: boolean }): Promise<Schedule[]>;
  /** Schedules whose `next_due_at` is at or before `due_by`, earliest first; no Check a page row. Read-only. */
  listDueSchedules(due_by: Timestamp): Promise<Schedule[]>;
  /** Every Check a page row (action `check_page`, its settings `instruction` and `url`), oldest first: what the due list leaves out. Read-only. */
  listCheckPages(): Promise<Schedule[]>;
  /**
   * One transaction: moves a Check a page row's marks only while they still equal `c.read` (another pass or a routine
   * write since then: null, nothing stored), and stores its run row. Never sets `running_since`.
   */
  claimCheckPage(c: CheckPageClaim): Promise<ScheduleRun | null>;
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
  /** The tokens the schedule's runs used, summed; with `day` (a UTC date, `2026-11-25`), only the runs whose occurrence falls on it. Read-only. */
  scheduleTokensUsed(schedule_id: string, day?: string): Promise<number>;
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
  /**
   * One transaction: removes the schedule and its suggestions, so nothing of it comes due again, and ends its runs held
   * at a checkpoint as `rejected`; its other run rows stay readable and no item is touched. A run in flight finishes
   * (its end changes no row). False when no schedule had the ID.
   */
  deleteSchedule(id: string): Promise<boolean>;
  /** The store's Clock's time: the `now` the CLI's schedule writes decide at (the CLI has no Clock of its own). */
  scheduleNow(): Timestamp;
}

/** The fields an edit, pause, resume or run may change (a Check a page row's caps and `paused` too). */
export type SchedulePatch = Partial<Pick<NewSchedule, "title" | "cadence" | "zone" | "next_due_at" | "missed_rule" | "action" | "token_cap" | "run_cap_usd" | "daily_cap_usd" | "paused">>;

export type AddScheduleInput = Pick<NewSchedule, "id" | "title" | "zone" | "created_by"> & { cadence: Cadence } &
  Partial<Pick<NewSchedule, "run_cap_usd" | "daily_cap_usd">> &
  { missed_rule?: MissedRule; action?: ScheduleActionSpec | null; token_cap?: number | null; token_period?: TokenPeriod; run_now?: boolean };

/** A write's result: the schedule as stored, or why nothing was stored. */
export type ScheduleResult = { ok: true; schedule: Schedule } | { ok: false; problem: string };

/** Why `action` and `token_cap` cannot be stored, or null. */
function actionProblem(action: ScheduleActionSpec | null | undefined, cap: number | null | undefined): string | null {
  if (action && !SCHEDULE_ACTION_KINDS.includes(action.kind)) return `unknown action kind "${String(action.kind)}": one of ${SCHEDULE_ACTION_KINDS.join(", ")}`;
  if (action && (typeof action.settings !== "object" || action.settings === null || Array.isArray(action.settings))) return "the action's settings must be an object";
  if (cap != null && (!Number.isSafeInteger(cap) || cap < 1)) return "the token cap must be a whole number of tokens of at least 1";
  return null;
}

/**
 * Stores a new schedule, first due at `now` with `run_now`, else at its cadence's next slot after `now` (after a
 * run-now occurrence, the claim sets the slot after it); refused with the cadence's or the action's problem. With no
 * `token_period`, a daily cadence's cap is per `day` and any other's `lifetime`.
 */
export async function addSchedule(store: Pick<ScheduleStore, "addSchedule">, { run_now, ...input }: AddScheduleInput, now: Date): Promise<ScheduleResult> {
  const problem = cadenceProblem(input.cadence, input.zone) ?? actionProblem(input.action, input.token_cap);
  if (problem) return { ok: false, problem };
  const first = nextDue(input.cadence, input.zone, now, now);
  if (!first) return { ok: false, problem: "the cadence never falls due" };
  const token_period = tokenPeriod({ token_period: input.token_period ?? null, cadence: input.cadence });
  const schedule = await store.addSchedule({ ...input, token_period, created_at: now.toISOString() as Timestamp, next_due_at: (run_now ? now : first).toISOString() as Timestamp });
  return { ok: true, schedule };
}

/** The schedule's token cap: its own, else SCHEDULE_TOKEN_CAP. */
export const tokenCap = (s: Pick<Schedule, "token_cap">): number => s.token_cap ?? SCHEDULE_TOKEN_CAP;
/** The runs `s`'s token cap counts: its stored `token_period`, else (null, stored before the period existed) `day` for a daily cadence and `lifetime` for any other. */
export const tokenPeriod = (s: Pick<Schedule, "token_period" | "cadence">): TokenPeriod => s.token_period ?? (s.cadence?.kind === "daily" ? "day" : "lifetime");
/** The tokens `s`'s cap counts for its occurrence at `slot`: a `day` cap's, that slot's UTC date's runs; else all its runs. */
const tokensUsed = (store: Pick<ScheduleStore, "scheduleTokensUsed">, s: Schedule, slot: string | null): Promise<number> => tokenPeriod(s) === "day" && slot !== null ? store.scheduleTokensUsed(s.id, new Date(slot).toISOString().slice(0, 10)) : store.scheduleTokensUsed(s.id);

/** Whether `s`'s occurrence at `slot` (its due one by default) is held: its action calls a model and its runs used its cap (budget's overBudget). */
export async function overCap(store: Pick<ScheduleStore, "scheduleTokensUsed">, s: Schedule, slot: string | null = s.next_due_at): Promise<boolean> {
  return s.action !== null && MODEL_KINDS.has(s.action.kind) && overBudget(await tokensUsed(store, s, slot), tokenCap(s));
}

/**
 * One pass over the due schedules at `now`: each due occurrence is claimed once, its next due time the first slot
 * after `now` (so missed slots make one occurrence), fired when idle, refused when running, and held at a checkpoint
 * when idle and over its token cap. An idle `skip` schedule's occurrence is skipped instead when claimed more than
 * `tick_ms` after its slot (no count; with no `tick_ms`, no claim is late), else when the store holds
 * `busy_threshold` or more queued implement runs (counted once per pass, only when such a schedule is due). Safe to
 * run on several workers at once and to run twice: a lost claim fires nothing.
 */
export async function runDueSchedules(
  store: ScheduleStore, now: Date, { busy_threshold = SKIP_WHEN_BUSY_THRESHOLD, tick_ms }: { busy_threshold?: number; tick_ms?: number | undefined } = {},
): Promise<Record<ClaimOutcome, ScheduleRun[]>> {
  const runs: Record<ClaimOutcome, ScheduleRun[]> = { fired: [], refused: [], skipped: [], checkpoint: [] };
  let queued: number | undefined;
  for (const s of await store.listDueSchedules(now.toISOString() as Timestamp)) {
    const next = s.cadence && nextDue(s.cadence, s.zone, now, new Date(s.created_at));
    let outcome: ClaimOutcome = s.running_since === null ? "fired" : "refused";
    let count: number | undefined;
    if (outcome === "fired" && s.missed_rule === "skip") {
      const late = tick_ms !== undefined && now.getTime() - Date.parse(s.next_due_at!) > tick_ms;
      if (late) outcome = "skipped";
      else if ((queued ??= await store.countQueuedImplementRuns()) >= busy_threshold) [outcome, count] = ["skipped", queued];
    }
    if (outcome === "fired" && (await overCap(store, s))) outcome = "checkpoint";
    const run = await store.claimScheduleOccurrence({
      schedule_id: s.id, occurrence_at: s.next_due_at!, next_due_at: next === null ? null : (next.toISOString() as Timestamp), outcome,
      ...(count === undefined ? {} : { queued_implement_runs: count }),
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

/** The cap an `/approve` sets: SCHEDULE_TOKEN_CAP more than the cap, or than what its period used when that is more. */
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
  const used = await tokensUsed(store, s, run.occurrence_at);
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
// so the next tick claims it once. Delete removes the schedule, its suggestions and its held checkpoints; its past
// runs stay. A Check a page schedule (`check-page`, a routine's row) takes a `url`, instruction, USD caps and the
// `on-merge` cadence; its pause and resume set `paused`, and edit changes no cadence or trigger of it.

/** The store methods managing schedules reads and writes through. */
export type ScheduleAdminStore = Pick<ScheduleStore, "listSchedules" | "listScheduleRuns" | "addSchedule" | "updateSchedule" | "deleteSchedule" | "scheduleNow">;

/** The refusal of a write whose condition was lost. */
export const SCHEDULE_LOST = "changed by another worker, try again";

/** A schedule's fields as the CLI's flags and an HTTP body give them; each absent when not given. */
export interface ScheduleFields {
  title?: string;
  cadence?: string;
  spec?: string;
  zone?: string;
  action?: string;
  /** build: the item's body; agent and feedback: the prompt; check-page: its instruction. */
  body?: string;
  /** check-page: its instruction (`--instruction`, or `--body`, not both), its http(s) page, and the USD caps of one run and of a UTC day's runs (null clears one). */
  instruction?: string; url?: string; run_cap_usd?: number | null; daily_cap_usd?: number | null;
  /** The missed-time rule (`--missed catch-up|skip`; HTTP `skip_when_busy` true is skip). */
  missed?: MissedRule;
  /** Add only: first due now (`--run-now on`), not at the cadence's next slot. */
  run_now?: boolean;
  token_cap?: number; grants?: string[]; // grants: feedback only, the `--grant` words (src/core/schedule-grants.ts)
}

/** The writes, each the owner's only. */
export type ScheduleWrite = "add" | "edit" | "pause" | "resume" | "run" | "delete";

const ONLY_PAGE = "only a check-page schedule takes --url, --instruction, --run-cap and --daily-cap";
const ON_MERGE_ONLY = `${ON_MERGE} goes only with --action check-page`;
const PAGE_FIELDS = ["instruction", "url", "run_cap_usd", "daily_cap_usd"] as const;
/** Why a USD cap cannot be stored, or null: it is a positive amount, or none. */
const capProblem = (f: Pick<ScheduleFields, "run_cap_usd" | "daily_cap_usd">): string | null =>
  [f.run_cap_usd, f.daily_cap_usd].some((v) => v != null && !(Number.isFinite(v) && v > 0)) ? "a cap is a positive dollar amount, or none" : null;

/** The action a word and its text make (CLI, HTTP): build `body`; agent, feedback `prompt` (needed); check-page an http(s) `url` and an `instruction` (or `body`), whose fields any other refuses. */
export function scheduleActionOf(word: string, body: string | undefined, page: Pick<ScheduleFields, (typeof PAGE_FIELDS)[number] | "grants"> = {}): ScheduleActionSpec | { problem: string } {
  if (Object.hasOwn(SETUP_ONLY_KINDS, word)) return { problem: `the ${word} action is added by setup only (${SETUP_ONLY_KINDS[word]}), not by schedule add or edit: one of ${WRITE_WORDS}` };
  const kind = Object.hasOwn(SCHEDULE_WRITE_WORDS, word) ? SCHEDULE_WRITE_WORDS[word]! : undefined;
  if (kind === undefined) return { problem: `unknown action kind "${word}": one of ${WRITE_WORDS}` };
  if (kind === "check_page") {
    if (page.instruction !== undefined && body !== undefined) return { problem: "give the instruction as --instruction or --body, not both" };
    const instruction = (page.instruction ?? body ?? "").trim(), url = page.url?.trim() ?? "";
    if (instruction === "") return { problem: "a check-page action needs an instruction (--instruction or --body)" };
    if (url === "") return { problem: "a check-page action needs --url: the page it checks" };
    if (!/^https?:\/\/\S+$/.test(url)) return { problem: "a check-page action's page is an http or https URL" };
    return withGrantWords({ kind, settings: { instruction, url } }, page.grants);
  }
  if (PAGE_FIELDS.some((k) => page[k] !== undefined)) return { problem: ONLY_PAGE };
  const text = body?.trim() ?? "";
  if (kind === "build") return withGrantWords({ kind, settings: text === "" ? {} : { body: text } }, page.grants);
  if (text === "") return { problem: `a${kind === "agent" ? "n" : ""} ${kind} action needs a body (--body): its prompt` };
  return withGrantWords({ kind, settings: { prompt: text } }, page.grants);
}

const refused = (problem: string): ScheduleResult => ({ ok: false, problem });
/** The schedule with the ID, a Check a page one too, or null. */
const findSchedule = async (store: Pick<ScheduleStore, "listSchedules">, id: string): Promise<Schedule | null> =>
  (await store.listSchedules({ check_pages: true })).find((s) => s.id === id) ?? null;
const isPage = (s: Schedule): boolean => s.action?.kind === "check_page";
/** The first slot of `c` in `zone` after `now`, an interval counted from the schedule's creation (as the claim counts it). */
function firstSlot(c: Cadence | null, zone: string, now: Date, created_at: Timestamp): Timestamp | null {
  const next = c && nextDue(c, zone, now, new Date(created_at));
  return next === null ? null : (next.toISOString() as Timestamp);
}

/** Stores a new schedule from its fields; refused when one is missing or bad, or its ID stored. `on-merge` (check-page only): no spec, zone UTC, no next due time. */
export async function createSchedule(store: ScheduleAdminStore, id: string, f: ScheduleFields, created_by: UserId, now: Date): Promise<ScheduleResult> {
  const merge = f.cadence?.trim() === ON_MERGE;
  const needs = merge ? (["title", "action"] as const) : (["title", "cadence", "spec", "zone", "action"] as const);
  const missing = [...(id.trim() ? [] : ["id"]), ...needs.filter((k) => !f[k]?.trim())];
  if (missing.length > 0 || scheduleIdProblem(id)) return refused(missing.length > 0 ? `missing ${missing.join(", ")}` : scheduleIdProblem(id)!);
  const action = scheduleActionOf(f.action!.trim(), f.body, f);
  if ("problem" in action) return refused(action.problem);
  if (merge && action.kind !== "check_page") return refused(ON_MERGE_ONLY);
  if (merge && f.spec !== undefined) return refused(`${ON_MERGE} takes no --spec: it runs on each merge`);
  if (merge && f.run_now) return refused(`an ${ON_MERGE} schedule runs on each merge: it takes no --run-now`);
  const zone = f.zone?.trim() || "UTC";
  const cadence = merge ? null : { kind: f.cadence!.trim() as CadenceKind, spec: f.spec!.trim() };
  const problem = (cadence && cadenceProblem(cadence, zone)) ?? actionProblem(action, f.token_cap) ?? capProblem(f);
  if (problem) return refused(problem);
  const exists = `schedule ${id} is already stored`;
  if (await findSchedule(store, id)) return refused(exists);
  const input = { id, title: f.title!.trim(), zone, created_by, action, missed_rule: f.missed ?? "catch_up", token_cap: f.token_cap ?? null, run_cap_usd: f.run_cap_usd ?? null, daily_cap_usd: f.daily_cap_usd ?? null };
  const r: ScheduleResult = cadence
    ? await addSchedule(store, { ...input, cadence, run_now: f.run_now ?? false }, now)
    : { ok: true, schedule: await store.addSchedule({ ...input, cadence: null, trigger: "merge", token_period: "lifetime", created_at: now.toISOString() as Timestamp, next_due_at: null }) };
  // Another worker stored the ID between the read and the insert: theirs stays.
  return r.ok && r.schedule.created_at !== now.toISOString() ? refused(exists) : r;
}

/** Reads the schedule, decides its patch (or a refusal), and writes it once, conditional on the `next_due_at` read. */
async function decide(store: ScheduleAdminStore, id: string, patchOf: (s: Schedule) => SchedulePatch | string): Promise<ScheduleResult> {
  const s = await findSchedule(store, id);
  if (s === null) return refused(noSchedule(id));
  const patch = patchOf(s);
  if (typeof patch === "string") return refused(patch);
  if (!(await store.updateSchedule(id, s.next_due_at, patch))) return refused(SCHEDULE_LOST);
  return { ok: true, schedule: { ...s, ...patch } };
}

/** Clears `next_due_at`, so no slot comes due (a Check a page schedule: sets `paused`); refused when already paused. */
export const pauseSchedule = (store: ScheduleAdminStore, id: string, _now: Date): Promise<ScheduleResult> =>
  decide(store, id, (s) => ((isPage(s) ? s.paused : s.next_due_at === null) ? "already paused" : isPage(s) ? { paused: true } : { next_due_at: null }));

/** Sets `next_due_at` to the first slot after `now` (a Check a page schedule also clears `paused`); refused when not paused, or the cadence never falls due. */
export const resumeSchedule = (store: ScheduleAdminStore, id: string, now: Date): Promise<ScheduleResult> =>
  decide(store, id, (s) => {
    if (isPage(s)) return !s.paused ? "not paused" : { paused: false, ...(s.cadence ? { next_due_at: firstSlot(s.cadence, s.zone, now, s.created_at) } : {}) };
    if (s.next_due_at !== null) return "not paused";
    const next = firstSlot(s.cadence, s.zone, now, s.created_at);
    return next === null ? "never falls due" : { next_due_at: next };
  });

/** The refusal of a write to an ID no schedule has. */
const noSchedule = (id: string): string => `no schedule ${id}`;

/** Removes the schedule and its suggestions (deleteSchedule): nothing of it fires again, its past runs stay; refused for an unknown ID. */
export async function deleteSchedule(store: ScheduleAdminStore, id: string, _now: Date): Promise<ScheduleResult> {
  const s = await findSchedule(store, id);
  if (s === null || !(await store.deleteSchedule(id))) return refused(noSchedule(id));
  return { ok: true, schedule: s };
}

/** Sets `next_due_at` to `now`, so the next tick claims it once (a running schedule's as `refused`); refused when paused, or on-merge. */
export const runSchedule = (store: ScheduleAdminStore, id: string, now: Date): Promise<ScheduleResult> =>
  decide(store, id, (s) =>
    s.paused || s.next_due_at === null ? (s.trigger !== null && !s.paused ? `an ${ON_MERGE} schedule runs on each merge: it has no next run to set` : "paused") : { next_due_at: now.toISOString() as Timestamp });

/** Changes only the fields given; refused with none, or a bad one. A new cadence or zone on an unpaused schedule sets `next_due_at` to its first slot after `now`. */
// A Check a page schedule's cadence, zone or trigger does not change, and no action changes to or from check-page.
export async function editSchedule(store: ScheduleAdminStore, id: string, f: ScheduleFields, now: Date): Promise<ScheduleResult> {
  if (Object.values(f).every((v) => v === undefined)) return refused("nothing to change: give at least one field");
  if (f.run_now !== undefined) return refused("run now is set only when a schedule is added: use schedule run");
  return decide(store, id, (s) => {
    const page = isPage(s);
    if (f.action !== undefined && (SCHEDULE_WRITE_WORDS[f.action.trim()] === "check_page") !== page) return "schedule edit changes no action to or from check-page: add a new schedule";
    if (page && (f.cadence !== undefined || f.spec !== undefined || f.zone !== undefined)) return "a check-page schedule's cadence or trigger does not change through schedule edit: add a new schedule";
    if (f.cadence?.trim() === ON_MERGE) return ON_MERGE_ONLY;
    const patch: SchedulePatch = {};
    if (f.title !== undefined) {
      if (!f.title.trim()) return "the title cannot be empty";
      patch.title = f.title.trim();
    }
    if (f.cadence !== undefined || f.spec !== undefined || f.zone !== undefined) {
      const cadence = { kind: (f.cadence?.trim() ?? s.cadence?.kind ?? "") as CadenceKind, spec: f.spec?.trim() ?? s.cadence?.spec ?? "" };
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
    if ([f.action, f.body, f.instruction, f.url, f.grants].some((v) => v !== undefined)) {
      const kind = page ? "check-page" : (f.action ?? s.action?.kind);
      if (kind === undefined) return "the schedule has no action: give --action too";
    if (f.grants?.includes("notes") && scheduleIdProblem(id)) return `a notes grant needs a plain schedule ID: ${scheduleIdProblem(id)}`;
      if (page && f.instruction !== undefined && f.body !== undefined) return "give the instruction as --instruction or --body, not both";
      const old = page || s.action?.kind === kind ? s.action!.settings : {};
      const action = page
        ? scheduleActionOf(kind, undefined, { instruction: f.instruction ?? f.body ?? String(old.instruction ?? ""), url: f.url ?? String(old.url ?? ""), ...(f.grants ? { grants: f.grants } : {}) })
        : scheduleActionOf(kind, f.body ?? String(old.body ?? old.prompt ?? ""), f);
      if ("problem" in action) return action.problem;
      patch.action = page ? action : { kind: action.kind, settings: { ...old, ...action.settings } };
    }
    if (f.run_cap_usd !== undefined || f.daily_cap_usd !== undefined) {
      const problem = page ? capProblem(f) : ONLY_PAGE;
      if (problem) return problem;
      Object.assign(patch, f.run_cap_usd === undefined ? {} : { run_cap_usd: f.run_cap_usd }, f.daily_cap_usd === undefined ? {} : { daily_cap_usd: f.daily_cap_usd });
    }
    if (f.missed !== undefined) patch.missed_rule = f.missed;
    if (f.token_cap !== undefined) patch.token_cap = f.token_cap;
    return actionProblem(null, f.token_cap) ?? patch;
  });
}

/** One write, as the CLI and the HTTP routes run it; `fields` only for add and edit. */
export function writeSchedule(store: ScheduleAdminStore, w: ScheduleWrite, id: string, fields: ScheduleFields, user: UserId, now: Date): Promise<ScheduleResult> {
  if (w === "add") return createSchedule(store, id, fields, user, now);
  if (w === "edit") return editSchedule(store, id, fields, now);
  return { pause: pauseSchedule, resume: resumeSchedule, run: runSchedule, delete: deleteSchedule }[w](store, id, now);
}

// `factory schedule …` (src/core/local-cli-parse.ts hands the word here, as it stays within its size budget).
export type ScheduleCommand = { verb: "list" } | { verb: "runs"; id: string } | { verb: ScheduleWrite; id: string; fields: ScheduleFields };

const FLAGS: Readonly<Record<string, keyof ScheduleFields>> = {
  "--grant": "grants", "--title": "title", "--cadence": "cadence", "--spec": "spec", "--zone": "zone", "--action": "action", "--body": "body", "--missed": "missed", "--run-now": "run_now", "--token-cap": "token_cap",
  "--instruction": "instruction", "--url": "url", "--run-cap": "run_cap_usd", "--daily-cap": "daily_cap_usd",
};
/** `--missed` words and the rule each stores. */
const MISSED: Readonly<Record<string, MissedRule>> = { "catch-up": "catch_up", skip: "skip" };

/** The words after `factory schedule`, or why they are no command (nothing is read or written). */
export function parseScheduleArgs(args: readonly string[]): ScheduleCommand | string {
  const [verb = "", ...rest] = args;
  if (verb === "list") return rest.length === 0 ? { verb } : "schedule list takes no arguments";
  if (verb === "runs" || verb === "pause" || verb === "resume" || verb === "run" || verb === "delete") {
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
    const unexpected = flag === "--id" ? verb === "edit" || id !== undefined : key === undefined || (key in fields && key !== "grants") || (key === "run_now" && verb === "edit");
    if (v === undefined || unexpected) return `schedule ${verb}: unexpected ${JSON.stringify(flag)}`;
    if (flag === "--id") id = v;
    else if (key === "missed") {
      const rule = Object.hasOwn(MISSED, v) ? MISSED[v] : undefined;
      if (rule === undefined) return "--missed takes catch-up or skip";
      fields.missed = rule;
    } else if (key === "run_now") {
      if (v !== "on" && v !== "off") return "--run-now takes on or off";
      fields.run_now = v === "on";
    } else if (key === "token_cap") {
      if (!/^\d+$/.test(v)) return "--token-cap takes a whole number of tokens";
      fields.token_cap = Number(v);
    } else if (key === "run_cap_usd" || key === "daily_cap_usd") {
      if (v !== "none" && !/^-?\d+(\.\d+)?$/.test(v)) return `${flag} takes a dollar amount or none`;
      fields[key] = v === "none" ? null : Number(v);
    } else Object.assign(fields, { [key!]: key === "grants" ? [...(fields.grants ?? []), v] : v }); // --grant repeats: one grant each
  }
  if (id === undefined || (verb === "add" && scheduleIdProblem(id))) return id === undefined ? "schedule add needs --id <id>" : `schedule add: ${scheduleIdProblem(id)}`;
  return { verb, id, fields };
}

/** One schedule as `schedule list` prints it: its next run is `paused`, `on each merge` (an on-merge one) or a time; a feedback schedule's grants last. */
export const scheduleLine = (s: Schedule): string => [
  s.id, s.title, s.paused ? "paused" : s.trigger === "merge" ? "on each merge" : s.next_due_at ?? "paused", s.running_since === null ? "idle" : "running", s.action?.kind ?? "no action",
  `missed ${s.missed_rule === "skip" ? "skip" : "catch-up"}`, `token cap ${tokenCap(s)}`, ...grantsLine(s.action, s.id),
].join("\t");

const runLine = (r: ScheduleRun): string =>
  [r.occurrence_at, r.outcome, r.recorded_at, `${r.tokens ?? 0} tokens`, r.cost_usd === undefined ? "no cost" : `$${r.cost_usd}`].join("\t");

/** Runs one `factory schedule` command as `user`; a write first asks `isOwner` (which may make `user` the owner). */
export async function runScheduleCommand(store: ScheduleAdminStore, c: ScheduleCommand, user: UserId, isOwner: () => Promise<boolean>): Promise<{ code: number; lines: string[] }> {
  const fail = (line: string) => ({ code: 1, lines: [line] });
  if (c.verb === "list") {
    const all = await store.listSchedules({ check_pages: true });
    return { code: 0, lines: all.length === 0 ? ["no schedules"] : all.map(scheduleLine) };
  }
  if (c.verb === "runs") {
    if ((await findSchedule(store, c.id)) === null) return fail(noSchedule(c.id));
    const runs = await store.listScheduleRuns(c.id);
    return { code: 0, lines: runs.length === 0 ? [`no runs of ${c.id}`] : runs.map(runLine) };
  }
  if (!(await isOwner())) return fail(`schedule ${c.verb} refused: only the owner manages schedules; you are ${user}`);
  const r = await writeSchedule(store, c.verb, c.id, c.fields, user, new Date(store.scheduleNow()));
  if (!r.ok) return fail(`schedule ${c.verb} ${c.id} refused: ${r.problem}`);
  const done = { add: "added", edit: "edited", pause: "paused", resume: "resumed", run: "set to run on the next tick:", delete: "deleted (its past runs stay)" }[c.verb];
  return { code: 0, lines: [`${done} ${scheduleLine(r.schedule)}`] };
}
