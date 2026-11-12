// Why an item waits (design §9, issue #310): one sentence for the Floor, Items, Queue and item page, from the
// item's state, its active run, the run's latest claim decision, the claim pauses, the run's not_before and its
// phases. Pure: no store, no clock, no I/O. The caller reads the inputs (list.ts) and passes the sentence
// through the Withholder before it leaves (api.ts); `refs` are the same-repo issue numbers the sentence names.
//
// Precedence, first match wins: closed, blocked on a person or the budget, running, a claim
// pause that stops this run's kind, a dependency, a phase hold, a coordination hold, a retry's not_before, the
// queue position, and last nothing (no run moves it). An open alarm that affects the item is named after the
// sentence (withAlarms), whichever rule gave it.

import { IMPLEMENT_KINDS } from "../core/policy.js";
import { PHASE_HOLD, PHASES_OPEN } from "../core/split.js";
import type { BlockedOn, ClaimDecision, CloseReason, RunKind, Stage } from "../core/types.js";

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

export interface Why {
  code: WhyCode;
  text: string;
  next_actor: NextActor;
  /** Issue numbers of the item's own repository that `text` names as `#N`, in order. */
  refs: number[];
}

/**
 * The claim pauses in effect, each its end (or, for `model_stall`, the next probe time) as `getClaimPause`
 * returns it: null or absent when not in effect.
 */
export interface ClaimPauses {
  rate_limit?: string | null;
  model_stall?: string | null;
  forge_auth?: string | null;
  preflight_access?: string | null;
}

export interface WhyInput {
  item: { stage: Stage; blocked_on: BlockedOn; blocked_reason: string | null; close_reason: CloseReason | null };
  /** The item's queued or running run (running wins), with its 1-based place in the queue when queued. */
  run: { id: string; kind: RunKind; status: "queued" | "running"; position: number | null } | null;
  /** The latest claim decision of the item's runs, if any. */
  decision: (Pick<ClaimDecision, "decision" | "holder_ref" | "holder_kind"> & { run_id: string; approved_by: string | null }) | null;
  pauses: ClaimPauses;
  /** The run's not_before when it is still ahead (the caller compares it with its now), else null. */
  not_before: string | null;
  /** What a split item waits on (list.ts `waitingOn`). */
  phases: { waiting_on: number; waiting_on_number: number | null };
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

const FAILED = /^run_failed:|^max_attempts$|^max_restart$|^repeated_failure$/;

/** `2026-11-07 12:30 UTC` from an ISO time; the text as is when it is not one. */
function when(iso: string): string {
  return /^\d{4}-\d\d-\d\dT\d\d:\d\d/.test(iso) ? `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC` : iso;
}

function why(code: WhyCode, text: string, next_actor: NextActor): Why {
  return { code, text, next_actor, refs: refsOf(text) };
}

/** Each stage in words, for a block with no stored reason. */
const STAGE_WORDS: Record<Stage, string> = {
  NEW: "new, not triaged yet",
  READY: "specced, not started",
  RUNNING: "being built",
  REVIEW: "in review",
  CLOSED: "closed",
};

function human(i: WhyInput["item"]): Why {
  if (i.blocked_on === "budget") return why("human", "Waiting for a person to answer the budget check", "human");
  const r = i.blocked_reason ?? "";
  if (r === "merge_pending") return why("human", "Ready to merge: waiting for a person to merge the PR", "human");
  if (r === "spec_pending") return why("human", "Waiting for a person to approve the spec", "human");
  if (r.startsWith("dependency_closed:")) {
    return why("human", `${r.slice("dependency_closed:".length)} was closed without a merge: a person decides how this item goes on`, "human");
  }
  if (r.startsWith("dependency_cycle:")) {
    return why("human", `Its dependencies form a cycle (${r.slice("dependency_cycle:".length).trim()}): a person removes one link`, "human");
  }
  if (r === "max_loops") return why("human", "Too many review loops: a person decides what happens next", "human");
  if (r === "merge_conflict_pending") return why("human", "A merge conflict needs a person", "human");
  if (FAILED.test(r)) return why("human", `The run failed (${r}): a person decides what happens next`, "human");
  // No stored reason: the item's state and what moves it next, never an empty or "no reason" text.
  if (!r) return why("human", `Waiting for a person: the item is ${STAGE_WORDS[i.stage]}; next, a person retries, resolves or rejects it`, "human");
  return why("human", `Waiting for a person: ${r}`, "human");
}

/** The claim pause that stops this run's kind, by the store's claim rule (sql-factory-store claimRun). */
function pause(p: ClaimPauses, kind: RunKind): Why | null {
  if (p.rate_limit) return why("paused", `Paused by a usage or rate limit until ${when(p.rate_limit)}`, "factory");
  if (p.model_stall) return why("paused", "Paused: the model is not answering; runs start again once a probe answers", "factory");
  if (!IMPLEMENT_KINDS.includes(kind)) return null;
  if (p.forge_auth) return why("paused", `Paused: the forge refused the factory's credentials, until ${when(p.forge_auth)}`, "human");
  if (p.preflight_access) return why("paused", `Paused: a push or PR access check failed, until ${when(p.preflight_access)}`, "human");
  return null;
}

/** "Waiting for #A and #B to merge" from the stored dependency hold reason (`dependencyReason`). */
function dependency(reason: string | null): Why {
  const m = /^waiting for (.+) to merge$/.exec(reason ?? "");
  return why("dependency", m ? `Waiting for ${m[1]} to merge` : "Waiting for another issue to merge", "other_item");
}

function phase(i: WhyInput["item"], p: WhyInput["phases"]): Why {
  if (i.blocked_reason === PHASES_OPEN || (i.blocked_reason !== PHASE_HOLD && p.waiting_on > 1)) {
    if (p.waiting_on_number) return why("phase", `Waiting for its phase #${p.waiting_on_number} to merge`, "other_item");
    return why("phase", p.waiting_on > 0 ? `Waiting for its ${p.waiting_on} open phases to merge` : "Waiting for its phases to merge", "other_item");
  }
  if (i.blocked_reason === PHASE_HOLD || p.waiting_on > 0) {
    return why("phase", p.waiting_on_number ? `Waiting for the previous phase #${p.waiting_on_number} to merge` : "Waiting for the previous phase to merge", "other_item");
  }
  return why("phase", i.blocked_on === "ci" ? "Waiting for CI" : "Waiting on another issue", "other_item");
}

const HOLDER: Record<ClaimDecision["holder_kind"], string> = {
  running: "which is running",
  pr: "which has an open PR",
  waiting: "which is queued ahead of it",
};

/** The one sentence that says why the item waits (or what it is doing), who moves it next and the issues it names. */
export function whyWaiting(x: WhyInput): Why {
  const { item: i, run } = x;
  if (i.stage === "CLOSED") return why("closed", i.close_reason ? `Closed: ${i.close_reason.replace(/_/g, " ")}` : "Closed", "none");
  if (i.blocked_on === "human" || i.blocked_on === "budget") return human(i);
  if (deadlocked(x.decision, run)) {
    return why("deadlock", `Started past a deadlock with ${x.decision!.holder_ref}: a person checks the overlap`, "factory");
  }
  if (run?.status === "running") return why("running", `Running ${run.kind}`, "factory");
  const paused = run ? pause(x.pauses, run.kind) : null;
  if (paused) return paused;
  if (i.blocked_on === "dependency") return dependency(i.blocked_reason);
  if (i.blocked_on === "upstream" || i.blocked_on === "ci" || x.phases.waiting_on > 0) return phase(i, x.phases);
  const d = x.decision;
  if (heldBy(d, run)) return why("held", `Held behind ${d!.holder_ref}, ${HOLDER[d!.holder_kind]}`, "other_item");
  if (run && x.not_before) return why("not_before", `Retry waits until ${when(x.not_before)}`, "factory");
  if (run) return why("queued", run.position ? `Queued at position ${run.position}` : `Queued ${run.kind}`, "factory");
  return why("idle", "Nothing moves it: no run is queued", "human");
}

/** The sentence with each open alarm that affects the item named after it (design 09-status-page); as is with none. */
export function withAlarms(w: Why, alarms: readonly string[]): Why {
  return alarms.length === 0 ? w : why(w.code, [w.text, ...alarms].join(". "), w.next_actor);
}
