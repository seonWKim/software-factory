// Why an item waits (design §9, issue #310): one reason for the Floor, Items, Queue and item page, from the
// item's phase (core/phase.ts), its active run, the run's latest claim decision, the claim pauses, the run's
// not_before and its phases. Pure: no store, no clock, no I/O. The reason is a code with its values; the web app
// words it (web/src/i18n/en.ts, one text per reason code), so no reason text is written here. The caller passes
// each value through the Withholder before it leaves (api.ts); `refs` are the same-repo issue numbers it names.
//
// Precedence, first match wins: closed, blocked on a person or the budget, running, a claim
// pause that stops this run's kind, a dependency, a phase hold, a coordination hold, a run kind no worker claims
// (`worker_kinds`: it waits for a session), a retry's not_before, the queue position, and last nothing (no run moves it). An open alarm that affects the item is named after the
// reason (withAlarms), whichever rule gave it.

import { DEPENDENCY_CLOSED, DEPENDENCY_CYCLE, FAILED_PHASES, type ItemPhase, PERSON_PHASES, isClosedPhase, phaseOf } from "../core/phase.js";
import { isModelRunKind } from "../core/model-choice.js";
import { failureClass, IMPLEMENT_KINDS, REPEATED_FAILURE, retryClears } from "../core/policy.js";
import type { BlockedOn, ClaimDecision, CloseReason, RunKind, RunOutcome, Stage } from "../core/types.js";
import { FAILURE_DESCRIPTIONS } from "./failures.js";

/** Which rule gave the sentence. */
export type WhyCode =
  | "closed"
  | "human"
  | "deadlock"
  | "running"
  | "paused"
  | "dependency"
  | "phase"
  | "held"
  | "not_before"
  | "queued"
  | "idle";

/** Who moves the item next: a person, the factory on its own, another item (its merge), or nobody (closed). */
export type NextActor = "human" | "factory" | "other_item" | "none";

/** The reason in words: one web/src/i18n/en.ts text per code (`why.reason.<code>`). */
export type ReasonCode =
  | "closed" | "closed_as"
  | "budget" | "merge_pending" | "spec_pending" | "max_revisions" | "dependency_closed" | "dependency_cycle" | "max_loops" | "merge_conflict"
  | "recurring_none" | "recurring_stalled" | "recurring_rate_limited" | "recurring_infra" | "recurring_own"
  | "failed_triage" | "failed_implement" | "failed_review" | "failed_update" | "failed_step"
  | "repeated_triage" | "repeated_implement" | "repeated_step"
  | "agent_needs_human" | "floor_tier" | "rule_of_two" | "session_released" | "changes_requested" | "empty_diff"
  | "delivery_failed" | "checks_failed" | "checks_failed_update" | "eval_regression"
  | "person_idle" | "person_code" | "person"
  | "deadlock" | "deadlock_unknown" | "running"
  | "paused_rate_limit" | "paused_model_stall" | "paused_model_credential" | "paused_forge_auth" | "paused_preflight"
  | "dependency" | "dependency_unknown"
  | "phase_parent_one" | "phase_parent_many" | "phase_parent" | "phase_prev_ref" | "phase_prev" | "ci" | "other_issue"
  | "held_running" | "held_pr" | "held_waiting"
  | "not_before" | "queued_at" | "queued" | "waits_session" | "idle";

export interface Why {
  code: WhyCode;
  reason_code: ReasonCode;
  /** The values the reason's text names (`{name}` in en.ts); free text from the store is withheld by the caller. */
  params: Record<string, string | number>;
  next_actor: NextActor;
  /** Issue numbers of the item's own repository that the params and alarms name as `#N`, in order. */
  refs: number[];
  /** The open alarms that affect the item (alarms.ts alarmText), said after the reason. */
  alarms: string[];
  /** The work item that holds a held or deadlocked run, for the link to its page; null when none. */
  holder_id: string | null;
}

/**
 * The claim pauses in effect, each its end (or, for `model_stall`, the next probe time) as `getClaimPause`
 * returns it: null or absent when not in effect.
 */
export interface ClaimPauses {
  rate_limit?: string | null;
  model_stall?: string | null;
  /** The missing model credential's pause (design §5 Restarts): it stops agent runs only. */
  model_credential?: string | null;
  forge_auth?: string | null;
  preflight_access?: string | null;
  /** The run kinds workers claim now (`worker_kinds`); a queued run of another kind waits for a session. Absent or null: every kind. */
  worker_kinds?: readonly RunKind[] | null;
}

export interface WhyInput {
  item: { stage: Stage; blocked_on: BlockedOn; blocked_reason: string | null; close_reason: CloseReason | null };
  /** The item's queued or running run (running wins), with its 1-based place in the queue when queued. */
  run: { id: string; kind: RunKind; status: "queued" | "running"; position: number | null } | null;
  /** The latest claim decision of the item's runs, if any. */
  decision: (Pick<ClaimDecision, "decision" | "holder_ref" | "holder_kind"> & {
    run_id: string;
    approved_by: string | null;
    /** The holder's work item (claim decision `holder_work_item_id`); absent or null when it has none. */
    holder_work_item_id?: string | null;
    /** The title of the holder's work item (list.ts `holderTitle`); absent or null when it has none. */
    holder_title?: string | null;
  }) | null;
  pauses: ClaimPauses;
  /** The run's not_before when it is still ahead (the caller compares it with its now), else null. */
  not_before: string | null;
  /** What a split item waits on (list.ts `waitingOn`). */
  phases: { waiting_on: number; waiting_on_number: number | null };
  /** The last failed run of an item held as `recurring_failure` (need.ts heldFailureOf); null or absent: none. */
  failure?: HeldFailure | null;
}

/**
 * The last failed run of a held item: its outcome, read only to classify it and find its plain words, and its
 * code and detail as shown, already through the Withholder (run-outcome channel).
 */
export interface HeldFailure {
  outcome: Extract<RunOutcome, { status: "failed" }>;
  code: string;
  detail: string;
}

/** `#N` not part of `owner/name#N`: the issue numbers of the item's own repository. */
const REF = /(?<![\w./-])#(\d+)\b/g;

/** The same-repo issue numbers a text names, in order, without duplicates. Numbers only, never text. */
export function refsOf(text: string): number[] {
  const out: number[] = [];
  for (const m of text.matchAll(REF)) {
    const n = Number(m[1]);
    if (n > 0 && !out.includes(n)) out.push(n);
  }
  return out;
}

/** True when the decision is a deadlock claim of the item's current run: it waits on the holder (Blocked by another task); the run goes on. */
export function deadlocked(decision: WhyInput["decision"], run: { id: string } | null): boolean {
  return decision?.decision === "deadlock" && run !== null && decision.run_id === run.id;
}

/** True when the decision is an unapproved `held` claim of the item's current run: a coordination hold. */
export function heldBy(decision: WhyInput["decision"], run: { id: string } | null): boolean {
  return decision?.decision === "held" && !decision.approved_by && run !== null && decision.run_id === run.id;
}

function why(code: WhyCode, reason_code: ReasonCode, next_actor: NextActor, params: Why["params"] = {}, holder_id: string | null = null): Why {
  return { code, reason_code, params, next_actor, refs: refsOf(Object.values(params).join(" ")), alarms: [], holder_id };
}

/** The recurring-failure reason by why a plain retry is likely enough (policy retryClears), or the task's own failure. */
const RECURRING: Partial<Record<ReturnType<typeof failureClass>, ReasonCode>> = {
  stalled: "recurring_stalled",
  rate_limited: "recurring_rate_limited",
  infra: "recurring_infra",
};

/** What an owner reads for an error code the factory has no plain words for: never the code itself. */
export const UNKNOWN_FAILURE = "It failed with an error the factory has no plain words for yet.";

/** An error code in plain words, one sentence (FAILURE_DESCRIPTIONS); any other code gets UNKNOWN_FAILURE, never the code. */
export function failureWords(code: string): string {
  return FAILURE_DESCRIPTIONS[code] ?? UNKNOWN_FAILURE;
}

/**
 * A recurring-failure hold (design 05-alarms): the last failed run's failure in plain words (failureWords) and
 * whether a plain retry is likely enough. With no failed run it names no failure.
 */
function recurring(f: HeldFailure | null): Why {
  if (f === null) return why("human", "recurring_none", "human");
  const said = failureWords(f.outcome.error_code).replace(/\.$/, "");
  const code = retryClears(f.outcome) ? (RECURRING[failureClass(f.outcome)] ?? "recurring_own") : "recurring_own";
  return why("human", code, "human", { failure: f.detail ? `${said} (${f.detail})` : said });
}

/** The reason of each person's phase with nothing more to name than the phase. */
const PERSON: Partial<Record<ItemPhase, ReasonCode>> = {
  budget_checkpoint: "budget",
  budget_wait: "budget",
  merge_pending: "merge_pending",
  spec_pending: "spec_pending",
  max_revisions: "max_revisions",
  max_loops: "max_loops",
  merge_conflict: "merge_conflict",
};

/** The step a failed run's reason names (`run_failed:<kind>:<code>`), by its kind; any other kind is "a step". */
const FAILED_STEP: Partial<Record<RunKind, ReasonCode>> = {
  triage: "failed_triage",
  implement: "failed_implement",
  review: "failed_review",
  update: "failed_update",
};
/** A repeated failure's step: the stage says it only in NEW and RUNNING (in REVIEW it may be a review, update or resolve run). */
const REPEATED_STEP: Partial<Record<Stage, ReasonCode>> = { NEW: "repeated_triage", RUNNING: "repeated_implement" };
/** The run that failed when the reason names no kind (`max_attempts`, `max_restart`): the stage says (phase.ts STAGE_FAILURES). */
const STAGE_KIND: Partial<Record<Stage, RunKind>> = { NEW: "triage", RUNNING: "implement", REVIEW: "review" };
/** A failed run's stored reason that names no error code, in plain words. */
const STAGE_FAILURE: Readonly<Record<string, string>> = {
  max_attempts: "It failed on every try it was allowed.",
  max_restart: "The factory restarted it too many times.",
};
/** A failed run's stored reason: `run_failed:<kind>:<code>`. */
const RUN_FAILED = /^run_failed:([^:]+):(.*)$/;

/**
 * A failed run's hold in words: which step failed, from its reason's kind or the item's stage, and its failure in
 * plain words (failureWords), never the code. A repeated failure says the step failed twice the same way.
 */
function failedRun(i: WhyInput["item"]): Why {
  const r = i.blocked_reason ?? "";
  if (r === REPEATED_FAILURE) return why("human", REPEATED_STEP[i.stage] ?? "repeated_step", "human");
  const m = RUN_FAILED.exec(r);
  const kind = m ? (m[1] as RunKind) : STAGE_KIND[i.stage];
  const failure = m ? failureWords(m[2]!) : (STAGE_FAILURE[r] ?? UNKNOWN_FAILURE);
  return why("human", (kind && FAILED_STEP[kind]) ?? "failed_step", "human", { failure });
}

/** The stored hold reasons of a person's wait with a sentence of their own (`why.reason.<code>`). */
const PERSON_REASONS: ReadonlySet<string> = new Set<ReasonCode>([
  "agent_needs_human", "floor_tier", "rule_of_two", "session_released", "changes_requested", "empty_diff", "delivery_failed",
  "checks_failed", "checks_failed_update", "eval_regression",
]);

/** A stored reason that is a code (no spaces), not a sentence a person or the factory wrote. */
const CODE = /^[a-z0-9_:.-]+$/;

function human(i: WhyInput["item"], p: ItemPhase, failure: HeldFailure | null): Why {
  const r = i.blocked_reason ?? "";
  if (p === "dependency_closed") return why("human", "dependency_closed", "human", { ref: r.slice(DEPENDENCY_CLOSED.length + 1) });
  if (p === "dependency_cycle") return why("human", "dependency_cycle", "human", { cycle: r.slice(DEPENDENCY_CYCLE.length + 1).trim() });
  if (p === "recurring_failure") return recurring(failure);
  // A failed run of a kind with no phase of its own (resolve, merge-check) waits as person_wait: the same words.
  if (FAILED_PHASES.has(p) || RUN_FAILED.test(r)) return failedRun(i);
  const code = PERSON[p];
  if (code) return why("human", code, "human");
  // No stored reason: the item's state and what moves it next, never an empty or "no reason" text.
  if (!r) return why("human", "person_idle", "human", { stage: i.stage });
  if (PERSON_REASONS.has(r)) return why("human", r as ReasonCode, "human");
  // Any other code reads as a generic wait, never as the code; a written sentence is said as it is.
  if (CODE.test(r)) return why("human", "person_code", "human");
  return why("human", "person", "human", { reason: r });
}

/** The claim pause that stops this run's kind, by the store's claim rule (sql-factory-store claimRun). */
function pause(p: ClaimPauses, kind: RunKind): Why | null {
  if (p.rate_limit) return why("paused", "paused_rate_limit", "factory", { until: p.rate_limit });
  if (p.model_stall) return why("paused", "paused_model_stall", "factory");
  if (p.model_credential && isModelRunKind(kind)) return why("paused", "paused_model_credential", "human");
  if (!IMPLEMENT_KINDS.includes(kind)) return null;
  if (p.forge_auth) return why("paused", "paused_forge_auth", "human", { until: p.forge_auth });
  if (p.preflight_access) return why("paused", "paused_preflight", "human", { until: p.preflight_access });
  return null;
}

/** "#A and #B" from the stored dependency hold reason (`dependencyReason`: "waiting for #A and #B to merge"). */
function dependency(reason: string | null): Why {
  const m = /^waiting for (.+) to merge$/.exec(reason ?? "");
  return m ? why("dependency", "dependency", "other_item", { refs: m[1]! }) : why("dependency", "dependency_unknown", "other_item");
}

function splitWait(p: ItemPhase, ph: WhyInput["phases"]): Why {
  const ref = ph.waiting_on_number ? `#${ph.waiting_on_number}` : null;
  if (p === "phases_open" || (p !== "phase_hold" && ph.waiting_on > 1)) {
    if (ref) return why("phase", "phase_parent_one", "other_item", { ref });
    return ph.waiting_on > 0 ? why("phase", "phase_parent_many", "other_item", { count: ph.waiting_on }) : why("phase", "phase_parent", "other_item");
  }
  if (p === "phase_hold" || ph.waiting_on > 0) return ref ? why("phase", "phase_prev_ref", "other_item", { ref }) : why("phase", "phase_prev", "other_item");
  return why("phase", p === "ci_wait" ? "ci" : "other_issue", "other_item");
}

const HOLDER: Record<ClaimDecision["holder_kind"], ReasonCode> = {
  running: "held_running",
  pr: "held_pr",
  waiting: "held_waiting",
};

/**
 * How a held or deadlocked run names its holder: the holder item's title, else a same-repo `#N` ref, else nothing
 * (the text says "another item"). Never a raw local id.
 */
function holderName(d: NonNullable<WhyInput["decision"]>): string {
  return d.holder_title || (/^#\d+$/.test(d.holder_ref) ? d.holder_ref : "");
}

/** The reason the item waits (or what it is doing), who moves it next and the issues it names. */
export function whyWaiting(x: WhyInput): Why {
  const { item: i, run } = x;
  const p = phaseOf(i);
  if (isClosedPhase(p)) return i.close_reason ? why("closed", "closed_as", "none", { reason: i.close_reason.replace(/_/g, " ") }) : why("closed", "closed", "none");
  if (PERSON_PHASES.has(p)) return human(i, p, x.failure ?? null);
  const d = x.decision;
  const holder = d?.holder_work_item_id ?? null;
  if (deadlocked(d, run)) {
    return d!.holder_title ? why("deadlock", "deadlock", "factory", { holder: d!.holder_title }, holder) : why("deadlock", "deadlock_unknown", "factory", {}, holder);
  }
  if (run?.status === "running") return why("running", "running", "factory", { kind: run.kind });
  const paused = run ? pause(x.pauses, run.kind) : null;
  if (paused) return paused;
  if (p === "dependency_hold") return dependency(i.blocked_reason);
  if (p === "phase_hold" || p === "phases_open" || p === "upstream_wait" || p === "ci_wait" || x.phases.waiting_on > 0) return splitWait(p, x.phases);
  if (heldBy(d, run)) return why("held", HOLDER[d!.holder_kind], "other_item", { holder: holderName(d!) }, holder);
  if (run && x.pauses.worker_kinds && !x.pauses.worker_kinds.includes(run.kind)) return why("queued", "waits_session", "human", { kind: run.kind });
  if (run && x.not_before) return why("not_before", "not_before", "factory", { until: x.not_before });
  if (run) return run.position ? why("queued", "queued_at", "factory", { position: run.position }) : why("queued", "queued", "factory", { kind: run.kind });
  return why("idle", "idle", "human");
}

/** The reason with each open alarm that affects the item named after it (design 09-status-page); as is with none. */
export function withAlarms(w: Why, alarms: readonly string[]): Why {
  return alarms.length === 0 ? w : { ...w, alarms: [...alarms], refs: refsOf([...Object.values(w.params), ...alarms].join(" ")) };
}
