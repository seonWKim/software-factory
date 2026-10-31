import { isCovered } from "./policy.js";
import type { Tier } from "./types.js";

// Structured outputs of each agent role: JSON Schema for the harness + a validator for the control plane.
// Agents can be wrong; nothing they return is trusted until it passes these.

export interface TriageOutput {
  problem: string;
  done_criteria: string[];
  desired_output: string;
  scope: string;
  allowed_paths: string[];
  /** Every file or directory the done criteria create or edit; each must be covered by `allowed_paths`. */
  files_to_change: string[];
  tier: Tier;
  tier_reason: string;
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

export const TRIAGE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["problem", "done_criteria", "desired_output", "scope", "allowed_paths", "files_to_change", "tier", "tier_reason"],
  properties: {
    problem: { type: "string" },
    done_criteria: { ...strings, minItems: 1 },
    desired_output: { type: "string" },
    scope: { type: "string" },
    allowed_paths: { ...strings, minItems: 1 },
    files_to_change: strings,
    tier: tierSchema,
    tier_reason: { type: "string" },
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

/** Repo-relative, no traversal, no absolute paths. */
function isSafePath(p: string): boolean {
  return p.length > 0 && !p.startsWith("/") && !p.split("/").includes("..");
}

export function parseTriage(v: unknown): Validation<TriageOutput> {
  if (!isObj(v)) return { ok: false, error: "not an object" };
  const { problem, done_criteria, desired_output, scope, allowed_paths, files_to_change, tier, tier_reason } = v;
  if (!isStr(problem) || !isStr(desired_output) || !isStr(scope) || !isStr(tier_reason)) {
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
  return {
    ok: true,
    value: { problem, done_criteria, desired_output, scope, allowed_paths, files_to_change, tier, tier_reason },
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
