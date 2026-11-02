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
  scope: string;
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

export interface ImplementOutput {
  summary: string;
  next_steps: string;
}

export interface ReviewOutput {
  verdict: "pass" | "bug";
  tier: Tier;
  findings: string[];
  summary: string;
}

const tierSchema = { type: "integer", minimum: 1, maximum: 5 };
const strings = { type: "array", items: { type: "string" } };
const count = { type: "integer", minimum: 0 };

export const TRIAGE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: [
    "in_short", "problem", "done_criteria", "desired_output", "scope", "allowed_paths", "files_to_change", "tier", "tier_reason",
    "estimated_lines", "estimated_files",
  ],
  properties: {
    in_short: { type: "string" },
    problem: { type: "string" },
    done_criteria: { ...strings, minItems: 1 },
    desired_output: { type: "string" },
    scope: { type: "string" },
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

export const IMPLEMENT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["summary", "next_steps"],
  properties: { summary: { type: "string" }, next_steps: { type: "string" } },
};

export const REVIEW_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["verdict", "tier", "findings", "summary"],
  properties: {
    verdict: { enum: ["pass", "bug"] },
    tier: tierSchema,
    findings: strings,
    summary: { type: "string" },
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
  if (!isStr(in_short) || !isStr(problem) || !isStr(desired_output) || !isStr(scope) || !isStr(tier_reason)) {
    return { ok: false, error: "missing text field" };
  }
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
      in_short, problem, done_criteria, desired_output, scope, allowed_paths, files_to_change, tier, tier_reason, estimated_lines,
      estimated_files, ...(phases.value ? { phases: phases.value } : {}),
    },
  };
}

export function parseImplement(v: unknown): Validation<ImplementOutput> {
  if (!isObj(v) || !isStr(v.summary) || !isStr(v.next_steps)) return { ok: false, error: "summary/next_steps" };
  return { ok: true, value: { summary: v.summary, next_steps: v.next_steps } };
}

export function parseReview(v: unknown): Validation<ReviewOutput> {
  if (!isObj(v)) return { ok: false, error: "not an object" };
  const { verdict, tier, findings, summary } = v;
  if (verdict !== "pass" && verdict !== "bug") return { ok: false, error: "verdict" };
  if (!isTier(tier) || !isStrs(findings) || !isStr(summary)) return { ok: false, error: "tier/findings/summary" };
  return { ok: true, value: { verdict, tier, findings, summary } };
}
