// Improve reports and standing approvals (split from src/core/types.ts). No vendor types here.
// Field names follow docs/design.md §2. IDs only, never display names.

import type { Brand, RunId, Timestamp, UserId, WorkItemId } from "./ids.js";
import type { SourceRef, Tier } from "./work-item.js";

/** The finished runs an improve report covers: finished_at in [window_start, window_end). */
export interface ImproveWindow {
  window_start: Timestamp;
  window_end: Timestamp;
}

/** Failed runs that share an error code and a normalized detail (design §7). `detail` is the normalized text, never the raw
 * detail. Run IDs in finish order; item IDs distinct, in the order their first run finished. */
export interface FailureGroup {
  error_code: string;
  detail: string;
  run_ids: RunId[];
  work_item_ids: WorkItemId[];
  /** The transcript tails read for the group's model call (groups only), each scanned before the call. */
  tails?: ImproveTail[];
  /** The model's draft of cause and fix (groups only, design §7). Absent: the worker had no model to ask. */
  draft?: ImproveDraft;
  /** What the controller filed or posted for the group (groups and `hotspot` rows, design §7). Absent: not filed yet. */
  filing?: ImproveFiling;
  /** A `hotspot` row only (detail: the file): the items a coordination hold kept back on the file, each once. */
  held_item_ids?: WorkItemId[];
  /** A `hotspot` row only: each counted run's finish time and each held item's claim decision time, by ID. Absent on older rows. */
  counted_at?: Record<string, Timestamp>;
}

/**
 * A group's filing (design §7). `filed`: a new item with the group's runs. `commented`: it matched an open filed item; one comment named `run_ids`, its runs not linked there
 * before. `linked`: it matched one, all runs linked, nothing posted. `skipped`: past a cap, the matched item closed in the last 30 days, no source can file, `needs_person`,
 * `host_sleep` (a stall after a host sleep), `pause` (every run failed in a model-stall or network pause), `in_flight` (another caller is filing it) or `open_item` (a hot
 * file with an open item of its title), all not filed; `count`: an `issue_cap` row's evidence. `withheld`: the egress scan flagged the body. `failed`: the call threw.
 */
export type ImproveFiling =
  | { status: "filed" | "linked"; ref: SourceRef }
  | { status: "commented"; ref: SourceRef; run_ids: RunId[] }
  | { status: "skipped"; reason: "issue_cap" | "comment_cap" | "recently_closed" | "no_source" | "needs_person" | "host_sleep" | "pause" | "in_flight" | "open_item"; count?: number }
  | { status: "withheld"; rules: string[] }
  | { status: "failed"; reason: "error" };

export type FiledPatternId = Brand<string, "FiledPatternId">;

/**
 * One pattern filed from an improve report (design §7), unique per (project, pattern_key). `report_id`: the report that claimed it, whose ID is in the
 * item's marker. `filed_ref`: the item, null while the filing is claimed but not yet done (a retry looks the marker up first). `outcome`: whether its fix
 * held, set (`outcome_at`) 7 days after the item closed as completed; else null. `evidence`: its count at filing (runs, plus held items); null before.
 */
export interface FiledPattern {
  id: FiledPatternId;
  project: string;
  pattern_key: string;
  error_code: string;
  detail: string;
  report_id: ImproveReportId;
  filed_ref: SourceRef | null;
  created_at: Timestamp;
  outcome: "holds" | "regressed" | null; outcome_at: Timestamp | null;
  evidence: number | null;
}

/**
 * One run's transcript tail for an improve draft. `included`: in the prompt. `withheld`: the egress scan flagged
 * it, so it was left out; `rules` name the rules, never the text. `missing`: no stored transcript (none, or one
 * the scan kept out of storage).
 */
export type ImproveTail =
  | { run_id: RunId; status: "included" | "missing" }
  | { run_id: RunId; status: "withheld"; rules: string[] };

/**
 * A group's draft (design §7). `drafted`: the model's cause, fix and the paths the fix touches, scanned clean.
 * `withheld`: the draft's scan flagged it, so only the rules are kept. `touches_prompts_or_gate`: set by the
 * factory from the gate list, never by the model; `needs_person` by the model (absent on older drafts).
 * `failed`: invalid output, a refusal, an error or a max-tokens stop. `skipped`: past the per-run call cap, no call made.
 */
export type ImproveDraft =
  | { status: "drafted"; cause: string; fix: string; touches: string[]; touches_prompts_or_gate: boolean; needs_person?: boolean }
  | { status: "withheld"; rules: string[]; touches_prompts_or_gate: boolean; needs_person?: boolean }
  | { status: "failed"; reason: "invalid_output" | "refused" | "error" | "max_tokens" }
  | { status: "skipped"; reason: "call_cap" };

export type ImproveReportId = Brand<string, "ImproveReportId">;

/**
 * One improve run's report (design §7): `groups` hold two or more runs, `patterns` exactly one. Both sorted the
 * same way every time, so the same failed runs give the same report. One row per run.
 */
export interface ImproveReport extends ImproveWindow {
  id: ImproveReportId;
  run_id: RunId;
  project: string;
  groups: FailureGroup[];
  patterns: FailureGroup[];
  created_at: Timestamp;
}

/** Standing approvals (design 05-standing-approvals): the gate a human decision is made at. Only the spec gate so far. */
export type StandingGate = "spec";
/** What the spec at the gate is: a phase of a split, a split into phases, or a single spec. */
export type SpecKind = "phase" | "split" | "single";
/** A human's decision at a gate. */
export type GateOutcome = "approved" | "rejected" | "revised";

/** A standing-approval rule, one per (gate, tier). Stored only: nothing acts on it yet. `set_by`: a user ID. */
export interface StandingRule {
  gate: StandingGate;
  tier: Tier;
  enabled: boolean;
  set_by: UserId;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export type StandingProposalId = Brand<string, "StandingProposalId">;

/** A proposal to turn a rule on, one per (gate, tier, run_length): the run that reached `threshold`. */
export interface StandingProposal {
  id: StandingProposalId;
  gate: StandingGate;
  tier: Tier;
  run_length: number;
  threshold: number;
  created_at: Timestamp;
}
