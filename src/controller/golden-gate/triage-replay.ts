// The triage role's golden replay (design 06-measurement, eval on change, issue #776). Golden replays a case as a review:
// the case's spec and diff, with the review schema. This wraps the runner so that a triage run replays its case instead: it
// runs the triage agent on the case's instruction.md alone (no diff) with TRIAGE_SCHEMA, parses the answer with parseTriage,
// and decides each of the case's checks (case.json `checks`) from the parsed answer in code. It then answers as a review
// would: `pass` when every check holds, else `bug` with each failed check. An answer parseTriage refuses throws, so the
// replay is errored. Any other run passes through unchanged. Built in buildGoldenRunDeps (src/golden.ts), which passes in
// TRIAGE_SCHEMA, parseTriage and isCovered; types are structural so the controller imports no legacy module.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { goldenCasesByRole } from "../../runtime/index.js";

/**
 * What a triage case can check, each decided from the parsed answer:
 * - `asks_question`: the spec asks the owner at least one decision.
 * - `no_question`: the spec asks no decision.
 * - `splits`: the spec splits the work into phases.
 * - `refuses_scope` (`paths`): no listed path is inside the spec's allowed paths.
 * - `names_paths` (`paths`): every listed path is inside the spec's allowed paths.
 */
export const TRIAGE_CHECK_KINDS = ["asks_question", "no_question", "splits", "refuses_scope", "names_paths"] as const;
export type TriageCheckKind = (typeof TRIAGE_CHECK_KINDS)[number];
export type TriageCheck = { kind: "asks_question" | "no_question" | "splits" } | { kind: "refuses_scope" | "names_paths"; paths: string[] };

const PATH_KINDS: readonly string[] = ["refuses_scope", "names_paths"];

export interface TriageCase { id: string; spec: string; checks: TriageCheck[] }

/** What the checks read of a parsed triage answer (TriageOutput). */
export interface TriageAnswer { decision_items?: readonly unknown[]; phases?: readonly unknown[]; allowed_paths: readonly string[] }

/** The triage parts the replay uses: TRIAGE_SCHEMA, parseTriage and isCovered (src/core/outputs.ts, src/core/policy.ts). */
export interface TriageParts {
  schema: Record<string, unknown>;
  parse(v: unknown): { ok: true; value: TriageAnswer } | { ok: false; error: string };
  covered(path: string, allowed: readonly string[]): boolean;
}

/** A case's `checks`, or a refusal naming the case: a non-empty list of known kinds, a path kind with a non-empty `paths` list. */
export function parseTriageChecks(v: unknown, id: string): TriageCheck[] {
  if (!Array.isArray(v) || v.length === 0) throw new Error(`triage case ${id}: checks must be a non-empty list`);
  return v.map((c, i) => {
    const kind = (c as { kind?: unknown } | null)?.kind;
    if (typeof kind !== "string" || !(TRIAGE_CHECK_KINDS as readonly string[]).includes(kind)) {
      throw new Error(`triage case ${id}: checks[${i}] has unknown kind ${JSON.stringify(kind)} (one of ${TRIAGE_CHECK_KINDS.join(", ")})`);
    }
    if (!PATH_KINDS.includes(kind)) return { kind } as TriageCheck;
    const paths = (c as { paths?: unknown }).paths;
    if (!Array.isArray(paths) || paths.length === 0 || !paths.every((p) => typeof p === "string" && p !== "")) {
      throw new Error(`triage case ${id}: checks[${i}] (${kind}) needs a non-empty paths list`);
    }
    return { kind, paths } as TriageCheck;
  });
}

/** The triage role's cases, by the work item id a replay runs them under (case.json `work_item_id`, else `golden_<id>`). A bad case throws, naming it. */
export function loadTriageCases(rolesDir: string): Map<string, TriageCase> {
  const out = new Map<string, TriageCase>();
  for (const id of goldenCasesByRole(rolesDir).get("triage") ?? []) {
    const dir = join(rolesDir, "triage", "golden", id);
    const meta = JSON.parse(readFileSync(join(dir, "case.json"), "utf8")) as { work_item_id?: unknown; checks?: unknown };
    const checks = parseTriageChecks(meta.checks, id);
    out.set(typeof meta.work_item_id === "string" ? meta.work_item_id : `golden_${id}`, { id, spec: readFileSync(join(dir, "instruction.md"), "utf8"), checks });
  }
  return out;
}

/** Why `check` fails on `answer`, or null when it holds. */
export function failedCheck(check: TriageCheck, answer: TriageAnswer, covered: TriageParts["covered"]): string | null {
  const asked = (answer.decision_items ?? []).length;
  switch (check.kind) {
    case "asks_question": return asked > 0 ? null : "asks_question: the spec asks no question";
    case "no_question": return asked === 0 ? null : `no_question: the spec asks ${asked} question(s)`;
    case "splits": return (answer.phases ?? []).length > 0 ? null : "splits: the spec has no phases";
    case "refuses_scope": {
      const taken = check.paths.filter((p) => covered(p, answer.allowed_paths));
      return taken.length === 0 ? null : `refuses_scope: allowed: ${taken.join(", ")}`;
    }
    case "names_paths": {
      const missed = check.paths.filter((p) => !covered(p, answer.allowed_paths));
      return missed.length === 0 ? null : `names_paths: not allowed: ${missed.join(", ")}`;
    }
  }
}

/** What this wrapper reads of a run spec (AgentRunSpec). */
interface TriageReplaySpec { role: string; work_item_id: string; prompt: string; output_schema?: Record<string, unknown> }

/** `runner`, with each triage golden replay run on its case's instruction.md with TRIAGE_SCHEMA and scored on its checks. */
export function triageReplayRunner<S extends TriageReplaySpec, R extends { status: string; output: unknown }>(
  runner: { run(spec: S): Promise<R> },
  rolesDir: string,
  triage: TriageParts,
): { run(spec: S): Promise<R> } {
  return {
    run: async (spec) => {
      const c = spec.role === "triage" ? loadTriageCases(rolesDir).get(spec.work_item_id) : undefined;
      if (!c) return runner.run(spec);
      const result = await runner.run({ ...spec, prompt: c.spec, output_schema: triage.schema });
      if (result.status !== "completed") return result;
      const answer = triage.parse(result.output);
      if (!answer.ok) throw new Error(`triage replay of case ${c.id}: invalid answer (${answer.error})`);
      const findings = c.checks.map((k) => failedCheck(k, answer.value, triage.covered)).filter((f): f is string => f !== null);
      return { ...result, output: { verdict: findings.length === 0 ? "pass" : "bug", tier: 5, findings, summary: `triage replay of case ${c.id}` } };
    },
  };
}
