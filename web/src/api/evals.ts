// The evals page's reads (design 06-measurement, 09-dashboard-evals): GET /api/v1/evals/<skill>/runs, /grid,
// /versions and /diff?a=&b=, the same fields as the CLI's --json, and Run now's POST /api/v1/evals/<skill>/runs. <skill> is the
// skill_ref, URL-encoded. A null figure means none was recorded, never 0. The Plugins page's Evals card (design
// 09-dashboard-settings) also reads /suite and writes through POST /api/v1/evals/write (postEvalWrite), with
// GET /api/v1/pauses's csrf_token, and reads GET /api/v1/evals's `starter` for Draft starter cases. The evals page's Judge checks card reads /calibration and labels a check with
// postEvalWrite's label.set; its Cases card adds a case that failed in the newest finished run with case.from_run.

import { useQuery } from "@tanstack/react-query";
import { t } from "../i18n/index.js";
import { getJson, postJson, useApi } from "./client.js";
import { API } from "./routes.js";
import type { PausesView } from "./supervisor.js";

/** A skill's stored run (FactoryStore.listSkillEvalRuns), newest first in the list. */
export interface EvalRun {
  id: string;
  /** The suite the run replayed; absent from an older server. */
  suite_id?: string;
  status: string;
  started_at: string;
  skill_version: string | null;
  model_class: string | null;
  judge_model_class: string | null;
  replays: number | null;
  pass_rate: number | null;
  errored: number | null;
}

/** One version of the skill (GET /api/v1/evals/<skill>/versions), newest first: its latest linked run's pass rate and the change since the previous version. */
export interface SkillVersionRow {
  version: number;
  /** The folder hash, as eval runs store it: a version's key in the diff read. */
  folder_hash: string;
  created_at: string;
  /** The newest version is the current one. */
  current: boolean;
  run_id: string | null;
  pass_rate: number | null;
  /** pass_rate − the previous version's, as a fraction; null when either has none. */
  change: number | null;
  /** The 95% interval of the newest linked run's pass rate, from its replays' verdicts; null with no replay. Absent from an older server. */
  band?: { low: number; high: number } | null;
  /** The sum of that run's replays' recorded cost in dollars; null when none was recorded. Absent from an older server. */
  cost_usd?: number | null;
  /** Each case's verdict in that run (its first replay's), by case ID; absent from an older server. */
  cases?: { case_id: string; verdict: string }[];
}

/** One line of the unified diff. */
export interface DiffLine {
  op: "same" | "removed" | "added";
  text: string;
}

/** One case's verdict in each of the two versions' latest runs; null where a version has none. */
export interface VersionCaseResult {
  case_id: string;
  a: string | null;
  b: string | null;
}

/** GET /api/v1/evals/<skill>/diff?a=<hash>&b=<hash>: both versions' rows, the line diff of their SKILL.md texts and the case results. */
export interface SkillVersionDiff {
  a: SkillVersionRow;
  b: SkillVersionRow;
  lines: DiffLine[];
  cases: VersionCaseResult[];
}

const base = (skill: string, read: "runs" | "grid" | "suite" | "versions" | "diff" | "calibration"): string => `/api/v1/evals/${encodeURIComponent(skill)}/${read}`;

/** Read again every 30 seconds while the page is open. */
const POLL_MS = 30_000;

/** The skill's runs, newest first. */
export const useEvalRuns = (skill: string) => useApi<{ runs: EvalRun[] }>(base(skill, "runs"), POLL_MS);

/** The skill's versions, newest first; `unlinked` holds the IDs of runs that match no version. */
export const useSkillVersions = (skill: string) => useApi<{ versions: SkillVersionRow[]; unlinked: string[] }>(base(skill, "versions"), POLL_MS);

/** Two versions' diff by folder hash; reads nothing until both are picked. */
export function useSkillDiff(skill: string, a: string | null, b: string | null) {
  const url = a && b ? `${base(skill, "diff")}?a=${encodeURIComponent(a)}&b=${encodeURIComponent(b)}` : null;
  return useQuery({ queryKey: [url], queryFn: () => getJson<SkillVersionDiff>(url!), enabled: url !== null });
}

/** One check the judge answered in a replay of the newest finished run, with the owner's label on it (null: none yet). */
export interface JudgedCheck {
  case_id: string;
  replay: number;
  check: string;
  answer: string;
  /** The judge's reason for its answer; "" when none was stored. Absent from an older server. */
  reason?: string;
  label: "right" | "wrong" | null;
}

/** GET /api/v1/evals/<skill>/calibration: the owner's labels on the judge and the newest finished run's judged checks. */
export interface EvalCalibration {
  labels: number;
  /** Right labels ÷ all labels; null with no labels. */
  agreement: number | null;
  calibrated: boolean;
  run: string | null;
  checks: JudgedCheck[];
}

/** The skill's judge agreement and judged checks; read with the page and again after each label. */
export const useEvalCalibration = (skill: string) => useApi<EvalCalibration>(base(skill, "calibration"), POLL_MS);

/**
 * The skill_refs that have a suite (GET /api/v1/evals) and why Draft starter cases is off (null: on; absent from an
 * older server); read once when the page opens, never polled.
 */
export const useEvalSuites = () => useApi<{ skills: string[]; starter?: string | null }>("/api/v1/evals", false);

/** Run now's options, as `factory eval run`'s flags: the model class as stored (never a model ID), its judge class, replays. */
export interface EvalRunOptions {
  model_class: string;
  judge_model_class: string;
  replays: number;
}

/**
 * Run now: POST /api/v1/evals/<skill>/runs, which runs the suite once and answers when the run is stored. The run's ID
 * and status, or the server's reason (403 for the owner check, 409 for a refused run), null when it gave none.
 */
export async function postEvalRun(token: string, skill: string, o: EvalRunOptions): Promise<{ ok: true; run_id: string; status: string } | { ok: false; error: string | null }> {
  const r = await postJson<{ run_id?: string; status?: string; error?: string }>(base(skill, "runs"), token, o);
  if (r.ok && r.value.run_id !== undefined && r.value.status !== undefined) return { ok: true, run_id: r.value.run_id, status: r.value.status };
  return { ok: false, error: r.value.error ?? null };
}

/** A skill's eval suite: one per skill. */
export interface EvalSuite {
  id: string;
  skill_ref: string;
  title: string;
}

/** One test case: what the skill is given, and the rubric checks its answer must meet (a list, or `{ checks }`). */
export interface EvalCase {
  id: string;
  suite_id: string;
  input: unknown;
  expected: unknown;
}

/** GET /api/v1/evals/<skill>/suite: the skill's suite, null when it has none, and its cases. */
export interface EvalSuiteView {
  suite: EvalSuite | null;
  cases: EvalCase[];
}

/** The skill's suite and cases; read when the card opens and after each write, never polled. */
export const useEvalSuite = (skill: string) => useApi<EvalSuiteView>(base(skill, "suite"), false);

/** The write token: GET /api/v1/pauses's csrf_token, null when the server has no write route. */
export const useEvalsToken = () => useApi<PausesView>(API.pauses, false);

/** One case tried once: its verdict and each check's answer; nothing is stored. */
export interface TriedCase {
  verdict: "pass" | "fail" | "errored";
  checks: { check: string; answer: "yes" | "no"; reason: string }[];
  error: string | null;
}

/** One op of POST /api/v1/evals/write (src/ui/evals-api.ts). */
export type EvalWrite =
  | { op: "suite.add"; skill: string; title?: string }
  | { op: "suite.rename"; skill: string; title: string }
  | { op: "suite.delete"; skill: string }
  | { op: "case.add"; skill: string; input: unknown; expected: unknown }
  | { op: "case.edit"; case: string; input?: unknown; expected?: unknown }
  | { op: "case.delete"; case: string }
  | { op: "case.try"; case: string }
  | { op: "import"; skill: string }
  | { op: "label.set"; run: string; case: string; replay: number; check: string; label: "right" | "wrong" }
  | { op: "case.from_run"; run: string; case: string }
  | { op: "starter.draft"; skill: string }
  | { op: "starter.accept"; skill: string; cases: StarterCase[] };

/** One drafted starter case (src/core/skill-eval-starter.ts): its kind and title are shown; accept stores its input and expected. */
export interface StarterCase {
  kind: "typical" | "edge" | "refuse";
  title: string;
  input: string;
  expected: unknown;
}

/** The answer's fields: `runs` after a suite delete, `tried` after a try, `added` and `kept` after an import, `cases` after a starter draft. */
export interface EvalWritten {
  op: EvalWrite["op"];
  runs?: number;
  tried?: TriedCase;
  cases?: StarterCase[];
  added?: string[];
  kept?: string[];
}

/** POST /api/v1/evals/write: the answer, or the server's reason (a 409 is a rule's refusal; nothing was written). */
export async function postEvalWrite(token: string, body: EvalWrite): Promise<{ ok: true; value: EvalWritten } | { ok: false; error: string }> {
  const r = await postJson<EvalWritten & { error?: string }>("/api/v1/evals/write", token, body);
  if (r.ok) return { ok: true, value: r.value };
  return { ok: false, error: r.value.error ?? t("api.http", { status: r.status }) };
}
