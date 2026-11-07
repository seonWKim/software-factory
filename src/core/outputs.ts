import { isCovered } from "./policy.js";
import { MAX_PHASES, MIN_PHASES, type SplitLimits, splitError } from "./split.js";
import type { Tier } from "./types.js";

// Structured outputs of each agent role: JSON Schema for the harness + a validator for the control plane.
// Agents can be wrong; nothing they return is trusted until it passes these.

export interface TriageOutput {
  /** Plain AS-IS → TO-BE statement that opens the spec comment; no file-level detail. Not stored. */
  in_short: string;
  problem: string;
  done_criteria: string[];
  desired_output: string;
  /**
   * What is in and out of scope as one text: the stored `scope`. From `in_scope` and `out_of_scope` when triage
   * returned them (issue #229), else an older output's own `scope` field.
   */
  scope: string;
  /** In-scope items, one per entry. Absent on an older output, which has only `scope`. */
  in_scope?: string[];
  /** Out-of-scope items, one per entry. Absent on an older output. */
  out_of_scope?: string[];
  /**
   * Decisions the human must make before approving: risky choices, open questions (at most 5 shown). Optional in
   * the schema (a cheap model often leaves it out when there are none); the validator defaults it to [].
   */
  decisions?: string[];
  allowed_paths: string[];
  /** Every file or directory the done criteria create or edit; each must be covered by `allowed_paths`. */
  files_to_change: string[];
  tier: Tier;
  tier_reason: string;
  /** Triage's estimate of the diff, before any code change (design 2026-11-01): added plus deleted lines. */
  estimated_lines: number;
  /** Triage's estimate of the number of changed files. */
  estimated_files: number;
  /**
   * A split into ordered phases (2 to 4), each mergeable on its own. Required when the estimate is over the
   * split threshold (src/core/split.ts); absent for an ordinary spec.
   */
  phases?: TriagePhase[];
}

/** One phase of a split spec. On /approve it becomes a sub-issue and then an ordinary work item. */
export interface TriagePhase {
  title: string;
  problem: string;
  done_criteria: string[];
  allowed_paths: string[];
}

/**
 * An agent's "I cannot go on without a human" answer (implement, resolve and review): why, and the one question
 * the owner should answer. Short plain text, each at most NEEDS_HUMAN_MAX_CHARS. Not a failure: the controller
 * blocks the item with `agent_needs_human` and starts no retry.
 */
export interface NeedsHuman {
  reason: string;
  question: string;
  /**
   * Implement only (issue #280): paths the agent needs outside the allowed paths. Shown to the owner as the exact
   * `/retry +paths ...` reply, never applied: only the owner's reply widens allowed_paths. Absent when none.
   */
  paths?: string[];
}

/** The longest `needs_human.reason` or `needs_human.question` the validators accept. */
export const NEEDS_HUMAN_MAX_CHARS = 500;
/** The most `needs_human.paths` the validators accept: one `/retry +paths` reply's worth. */
export const NEEDS_HUMAN_MAX_PATHS = 10;

export interface ImplementOutput {
  /** "" when the agent returned needs_human without it. */
  summary: string;
  /** "" when the agent returned needs_human without it. */
  next_steps: string;
  /**
   * Work the spec asks for that this change does not do, one entry each (issue #229): a needed file outside
   * the allowed paths, a step left for a follow-up. Non-empty marks the PR incomplete. [] when absent.
   */
  missing: string[];
  /** Where the change differs from the spec on purpose, one entry each. [] when absent. */
  deviations: string[];
  needs_human?: NeedsHuman;
  /**
   * A done criterion that cannot be met inside the spec (issue #222): a file outside the allowed paths, a
   * criterion against a repo rule. Non-empty: the run fails with this reason, nothing is pushed, and the
   * controller starts a spec revision. Absent when the agent left it out or returned "".
   */
  spec_conflict?: string;
}

/** Entries kept per `missing` / `deviations` list, and characters per entry. */
export const PR_NOTE_MAX_ITEMS = 10;
export const PR_NOTE_MAX_CHARS = 300;

/** The error code of an implement run whose agent returned a `spec_conflict`; its detail is the reason. */
export const SPEC_CONFLICT = "spec_conflict";

/** The longest `spec_conflict` reason the validator accepts: what a failed run's detail keeps. */
export const SPEC_CONFLICT_MAX_CHARS = 500;

/**
 * One reviewer finding (issue #222): `code` is a defect the implementer can fix inside the spec; `spec` is one
 * that needs the spec changed (a needed file outside the allowed paths, a criterion against a repo rule).
 */
export interface ReviewFinding {
  kind: "code" | "spec";
  text: string;
}

export interface ReviewOutput {
  verdict: "pass" | "bug";
  tier: Tier;
  findings: ReviewFinding[];
  /**
   * Checks the reviewer could not run (e.g. the tests in its sandbox). Never a finding. Left out when empty, so
   * an older review parses to the same value; read it with `unverifiedOf`.
   */
  unverified?: string[];
  summary: string;
  needs_human?: NeedsHuman;
}

/** The review's unverified checks; [] when it has none. */
export function unverifiedOf(r: Pick<ReviewOutput, "unverified">): string[] {
  return r.unverified ?? [];
}

/** The findings that need the spec changed. */
export function specFindings(r: Pick<ReviewOutput, "findings">): ReviewFinding[] {
  return r.findings.filter((f) => f.kind === "spec");
}

/** A finding as one line of text: a spec finding says so. */
export function findingLine(f: ReviewFinding): string {
  return f.kind === "spec" ? `(spec) ${f.text}` : f.text;
}

const tierSchema = { type: "integer", minimum: 1, maximum: 5 };
const strings = { type: "array", items: { type: "string" } };
const count = { type: "integer", minimum: 0 };

/** The most "Decisions for you" lines a spec shows (issue #229). */
export const MAX_DECISIONS = 5;

/** The stored `scope` text for separate in-scope and out-of-scope lists. */
export function scopeText(inScope: readonly string[], outOfScope: readonly string[]): string {
  const list = (xs: readonly string[]) => (xs.length > 0 ? xs.map((x) => `- ${x}`) : ["- (none)"]);
  return ["In scope:", ...list(inScope), "", "Out of scope:", ...list(outOfScope)].join("\n");
}

export const TRIAGE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: [
    "in_short", "problem", "done_criteria", "desired_output", "in_scope", "out_of_scope", "allowed_paths",
    "files_to_change", "tier", "tier_reason", "estimated_lines", "estimated_files",
  ],
  properties: {
    in_short: { type: "string" },
    problem: { type: "string" },
    done_criteria: { ...strings, minItems: 1 },
    decisions: { ...strings, maxItems: MAX_DECISIONS },
    desired_output: { type: "string" },
    in_scope: strings,
    out_of_scope: strings,
    allowed_paths: { ...strings, minItems: 1 },
    files_to_change: strings,
    tier: tierSchema,
    tier_reason: { type: "string" },
    estimated_lines: count,
    estimated_files: count,
    phases: {
      type: "array",
      maxItems: MAX_PHASES,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["title", "problem", "done_criteria", "allowed_paths"],
        properties: {
          title: { type: "string" },
          problem: { type: "string" },
          done_criteria: { ...strings, minItems: 1 },
          allowed_paths: { ...strings, minItems: 1 },
        },
      },
    },
  },
};

const NEEDS_HUMAN_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["reason", "question"],
  description:
    "Only when you cannot go on without a human (missing credentials or permissions, a tool that fails the same way twice, " +
    "a spec that contradicts the code, a decision only the owner can make). Never for a bug you can fix.",
  properties: {
    reason: { type: "string", maxLength: NEEDS_HUMAN_MAX_CHARS, description: "Why you stopped, in one or two plain sentences." },
    question: { type: "string", maxLength: NEEDS_HUMAN_MAX_CHARS, description: "The one question the owner should answer." },
  },
};

/** The implementer's needs_human: also the paths outside the allowed paths it needs, for the owner to allow (issue #280). */
const IMPLEMENT_NEEDS_HUMAN_SCHEMA = {
  ...NEEDS_HUMAN_SCHEMA,
  properties: {
    ...NEEDS_HUMAN_SCHEMA.properties,
    paths: {
      type: "array",
      maxItems: NEEDS_HUMAN_MAX_PATHS,
      items: { type: "string", maxLength: NEEDS_HUMAN_MAX_CHARS },
      description: "Only when the work needs files outside the allowed paths: those repo-relative paths, so the owner can allow them. They change nothing by themselves.",
    },
  },
};

// summary and next_steps are not schema-required: they may be left out when needs_human is set. parseImplement
// still requires both on every other answer.
export const IMPLEMENT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: [],
  properties: {
    summary: { type: "string", description: "Required unless needs_human is set." },
    next_steps: { type: "string", description: "Required unless needs_human is set." },
    missing: {
      type: "array",
      maxItems: PR_NOTE_MAX_ITEMS,
      items: { type: "string", maxLength: PR_NOTE_MAX_CHARS },
      description: "Work the spec asks for that this change does not do (for example a needed file outside the allowed paths). Empty or absent when the work is complete.",
    },
    deviations: {
      type: "array",
      maxItems: PR_NOTE_MAX_ITEMS,
      items: { type: "string", maxLength: PR_NOTE_MAX_CHARS },
      description: "Where the change differs from the spec on purpose. Empty or absent when it does not.",
    },
    needs_human: IMPLEMENT_NEEDS_HUMAN_SCHEMA,
    spec_conflict: {
      type: "string",
      maxLength: SPEC_CONFLICT_MAX_CHARS,
      description:
        "Only when a done criterion cannot be met inside the spec (it needs a file outside the allowed paths, or it conflicts with a repo rule): " +
        "the criterion and why, in plain text. Nothing is pushed and the spec is revised. Empty or absent otherwise.",
    },
  },
};

export const REVIEW_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["verdict", "tier", "findings", "summary"],
  properties: {
    verdict: { enum: ["pass", "bug"] },
    tier: tierSchema,
    findings: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["kind", "text"],
        properties: {
          kind: { enum: ["code", "spec"], description: "code: fixable inside the spec. spec: needs the spec changed." },
          text: { type: "string" },
        },
      },
    },
    unverified: { ...strings, description: "Checks you could not run or confirm. Never makes the verdict bug." },
    summary: { type: "string" },
    needs_human: NEEDS_HUMAN_SCHEMA,
  },
};

type Validation<T> = { ok: true; value: T } | { ok: false; error: string };

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
const isStr = (v: unknown): v is string => typeof v === "string";
const isStrs = (v: unknown): v is string[] => Array.isArray(v) && v.every(isStr);
const isTier = (v: unknown): v is Tier => Number.isInteger(v) && (v as number) >= 1 && (v as number) <= 5;
const isCount = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0;

/** Repo-relative, no traversal, no absolute paths. */
function isSafePath(p: string): boolean {
  return p.length > 0 && !p.startsWith("/") && !p.split("/").includes("..");
}

/** A phase list: absent or empty is no split; otherwise 2 to 4 phases, each with every field filled in. */
function parsePhases(v: unknown): Validation<TriagePhase[] | undefined> {
  if (v === undefined || (Array.isArray(v) && v.length === 0)) return { ok: true, value: undefined };
  if (!Array.isArray(v)) return { ok: false, error: "phases" };
  if (v.length < MIN_PHASES || v.length > MAX_PHASES) {
    return { ok: false, error: `phases: a split has ${MIN_PHASES} to ${MAX_PHASES} phases, not ${v.length}` };
  }
  const phases: TriagePhase[] = [];
  for (const [i, p] of v.entries()) {
    const bad = (what: string): Validation<never> => ({ ok: false, error: `phases[${i}].${what}` });
    if (!isObj(p)) return { ok: false, error: `phases[${i}]` };
    if (!isStr(p.title) || p.title.trim() === "") return bad("title");
    if (!isStr(p.problem) || p.problem.trim() === "") return bad("problem");
    if (!isStrs(p.done_criteria) || p.done_criteria.length === 0) return bad("done_criteria");
    if (!isStrs(p.allowed_paths) || p.allowed_paths.length === 0 || !p.allowed_paths.every(isSafePath)) return bad("allowed_paths");
    phases.push({ title: p.title, problem: p.problem, done_criteria: p.done_criteria, allowed_paths: p.allowed_paths });
  }
  return { ok: true, value: phases };
}

/**
 * Validates a triage answer. With `limits` (the item's configured size caps), it also applies the split rule:
 * an estimate over the threshold (src/core/split.ts) is rejected unless it has 2 to 4 phases.
 */
export function parseTriage(v: unknown, limits?: SplitLimits): Validation<TriageOutput> {
  if (!isObj(v)) return { ok: false, error: "not an object" };
  const {
    in_short, problem, done_criteria, desired_output, scope, allowed_paths, files_to_change, tier, tier_reason, estimated_lines,
    estimated_files,
  } = v;
  if (!isStr(in_short) || !isStr(problem) || !isStr(desired_output) || !isStr(tier_reason)) {
    return { ok: false, error: "missing text field" };
  }
  // Separate lists (issue #229) when both are given; an older output's `scope` text otherwise.
  const lists = v.in_scope !== undefined || v.out_of_scope !== undefined;
  if (lists && (!isStrs(v.in_scope) || !isStrs(v.out_of_scope))) return { ok: false, error: "in_scope/out_of_scope" };
  if (!lists && !isStr(scope)) return { ok: false, error: "missing text field" };
  const scoped = lists
    ? { scope: scopeText(v.in_scope as string[], v.out_of_scope as string[]), in_scope: v.in_scope as string[], out_of_scope: v.out_of_scope as string[] }
    : { scope: scope as string };
  // Optional: a triage output without `decisions` means none (the schema does not require it).
  const decisions = v.decisions ?? [];
  if (!isStrs(decisions)) return { ok: false, error: "decisions" };
  if (!isStrs(done_criteria) || done_criteria.length === 0) return { ok: false, error: "done_criteria" };
  if (!isStrs(allowed_paths) || allowed_paths.length === 0 || !allowed_paths.every(isSafePath)) {
    return { ok: false, error: "allowed_paths" };
  }
  if (!isStrs(files_to_change) || !files_to_change.every(isSafePath)) return { ok: false, error: "files_to_change" };
  const uncovered = files_to_change.filter((p) => !isCovered(p, allowed_paths));
  if (uncovered.length > 0) {
    return { ok: false, error: `files_to_change not covered by allowed_paths: ${uncovered.join(", ")}` };
  }
  if (!isTier(tier)) return { ok: false, error: "tier" };
  if (!isCount(estimated_lines) || !isCount(estimated_files)) return { ok: false, error: "estimated_lines/estimated_files" };
  const phases = parsePhases(v.phases);
  if (!phases.ok) return phases;
  if (limits) {
    const err = splitError({ estimated_lines, estimated_files }, phases.value?.length ?? 0, limits);
    if (err) return { ok: false, error: err };
  }
  return {
    ok: true,
    value: {
      in_short, problem, done_criteria, desired_output, ...scoped, allowed_paths, files_to_change, tier, tier_reason, estimated_lines,
      estimated_files, decisions, ...(phases.value ? { phases: phases.value } : {}),
    },
  };
}

/** A short, non-empty plain-text field of needs_human. */
const isShort = (v: unknown): v is string => isStr(v) && v.trim() !== "" && v.length <= NEEDS_HUMAN_MAX_CHARS;

/**
 * The optional needs_human field: absent (or null) is none; otherwise both reason and question must be
 * non-empty and at most NEEDS_HUMAN_MAX_CHARS. Anything else is invalid output, retried like any other.
 */
export function parseNeedsHuman(v: unknown): Validation<NeedsHuman | undefined> {
  if (v === undefined || v === null) return { ok: true, value: undefined };
  if (!isObj(v) || !isShort(v.reason) || !isShort(v.question)) {
    return { ok: false, error: `needs_human: reason and question must be non-empty and at most ${NEEDS_HUMAN_MAX_CHARS} characters` };
  }
  const paths = v.paths ?? [];
  if (!isStrs(paths) || paths.length > NEEDS_HUMAN_MAX_PATHS || paths.some((p) => p.length > NEEDS_HUMAN_MAX_CHARS)) {
    return { ok: false, error: `needs_human: paths must be at most ${NEEDS_HUMAN_MAX_PATHS} strings` };
  }
  const kept = paths.map((p) => p.trim()).filter(Boolean);
  return { ok: true, value: { reason: v.reason.trim(), question: v.question.trim(), ...(kept.length ? { paths: kept } : {}) } };
}

/**
 * An implement or resolve answer. With needs_human, summary and next_steps may be left out (they become "").
 * `missing` and `deviations` are optional lists; absent is [].
 */
export function parseImplement(v: unknown): Validation<ImplementOutput> {
  if (!isObj(v)) return { ok: false, error: "summary/next_steps" };
  const ask = parseNeedsHuman(v.needs_human);
  if (!ask.ok) return ask;
  const notes = (x: unknown) => x === undefined || (isStrs(x) && x.length <= PR_NOTE_MAX_ITEMS && x.every((e) => e.length <= PR_NOTE_MAX_CHARS));
  if (!notes(v.missing) || !notes(v.deviations)) return { ok: false, error: "missing/deviations" };
  const conflict = v.spec_conflict ?? "";
  if (!isStr(conflict) || conflict.length > SPEC_CONFLICT_MAX_CHARS) return { ok: false, error: "spec_conflict" };
  const lists = {
    missing: ((v.missing as string[] | undefined) ?? []).map((e) => e.trim()).filter(Boolean),
    deviations: ((v.deviations as string[] | undefined) ?? []).map((e) => e.trim()).filter(Boolean),
    ...(conflict.trim() ? { spec_conflict: conflict.trim() } : {}),
  };
  if (ask.value) {
    const optional = (x: unknown) => x === undefined || isStr(x);
    if (!optional(v.summary) || !optional(v.next_steps)) return { ok: false, error: "summary/next_steps" };
    return {
      ok: true,
      value: { summary: (v.summary as string | undefined) ?? "", next_steps: (v.next_steps as string | undefined) ?? "", ...lists, needs_human: ask.value },
    };
  }
  if (!isStr(v.summary) || !isStr(v.next_steps)) return { ok: false, error: "summary/next_steps" };
  return { ok: true, value: { summary: v.summary, next_steps: v.next_steps, ...lists } };
}

export function parseReview(v: unknown): Validation<ReviewOutput> {
  if (!isObj(v)) return { ok: false, error: "not an object" };
  const { verdict, tier, findings, summary } = v;
  if (verdict !== "pass" && verdict !== "bug") return { ok: false, error: "verdict" };
  if (!isTier(tier) || !Array.isArray(findings) || !isStr(summary)) return { ok: false, error: "tier/findings/summary" };
  const parsed: ReviewFinding[] = [];
  for (const [i, f] of findings.entries()) {
    // An older review's finding is a plain string: a code finding (issue #222).
    if (isStr(f)) parsed.push({ kind: "code", text: f });
    else if (isObj(f) && (f.kind === "code" || f.kind === "spec") && isStr(f.text)) parsed.push({ kind: f.kind, text: f.text });
    else return { ok: false, error: `findings[${i}]: an object with kind "code" or "spec" and a text` };
  }
  const unverified = v.unverified ?? [];
  if (!isStrs(unverified)) return { ok: false, error: "unverified" };
  const ask = parseNeedsHuman(v.needs_human);
  if (!ask.ok) return ask;
  return {
    ok: true,
    value: {
      verdict, tier, findings: parsed, summary, ...(unverified.length > 0 ? { unverified } : {}), ...(ask.value ? { needs_human: ask.value } : {}),
    },
  };
}
