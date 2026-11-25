// Skill evals on the local API (design 06-measurement), each with the same fields as its CLI --json:
// - GET /api/v1/evals/<skill>/runs: the skill's stored runs, newest first (`factory eval results <skill> --json`,
//   FactoryStore.listSkillEvalRuns), null where a figure was not recorded.
// - GET /api/v1/evals/<skill>/grid: one row per skill version and model class from its newest run
//   (`factory eval results <skill> --by version,model --json`, skillEvalGrid).
// - GET /api/v1/evals/<skill>/compare?a=<run-a>&b=<run-b>: the two runs paired case by case from their stored replays:
//   paired, wins, losses, ties, p_value, mean_difference, interval and verdict (`factory eval compare <run-a> <run-b>
//   --json`, compareSkillEvalRuns); 404 when a run is unknown or of another skill.
// - GET /api/v1/evals/<skill>/suite: { suite, cases }, the skill's suite (its first, by creation: the one `eval run` runs,
//   null when it has none) and its cases (`factory eval case list <skill>`).
// - GET /api/v1/evals: { skills, held }, the distinct skill_ref of every suite, sorted (the Skills tab links the rows it
//   names), and every held skill version (newest first): its ref and version, the suite's skill_ref (null when its gate
//   run names none), the pass rates compared, the cases that fell and its open alarm's alert_id (null: none open).
// <skill> is the suite's skill_ref, URL-encoded (it holds a slash). The reads start no run and write nothing.
// - POST /api/v1/evals/write: one op, through the CLI's rules for `eval suite`, `eval case` and `eval import`
//   (src/runtime/skill-evals/authoring.ts and import.ts), after the request guards (write-routes.ts) and the owner
//   check (approve_spec, 403). A rule's refusal is a 409 and writes nothing. Import and try use the eval source the
//   `integrations` entry names, else plugins.eval_source, built for each call (src/runtime/live-eval-source.ts), and
//   refuse with none. The body is one of:
//     { "op": "suite.add", "skill", "title"? }  { "op": "suite.rename", "skill", "title" }  { "op": "suite.delete", "skill" }
//     { "op": "case.add", "skill", "input", "expected" }  { "op": "case.edit", "case", "input"?, "expected"? }
//     { "op": "case.delete", "case" }  { "op": "case.try", "case", "model"? }  { "op": "import", "skill" }
//     { "op": "version.settle", "ref", "version", "decision": "approve" | "reject" }: one held skill version settled by
//     the store method of a bare `factory approve` / `factory reject` (settleSkillVersionGate, as settleHeldSkillVersion
//     in src/core/skill-eval-gate.ts), its alarm dismissed; a version that is not held is a 409 in plain words.
// - POST /api/v1/evals/<skill>/runs: Run now, one run through UiEvals.run (evals-run-api.ts).
// Every string in an answer leaves through the Withholder. The grid, compare and eval source functions come from the
// route tables (read-routes.ts and write-routes.ts, the root), as main.ts passes the CLI its, so this feature has no
// runtime import of core or runtime.

import type { compareSkillEvalRuns, skillEvalGrid } from "../core/skill-eval-compare.js";
import type { UserId } from "../core/types.js";
import type { EgressScanner } from "../interfaces/egress-scanner.js";
import type { FactoryStore } from "../interfaces/factory-store.js";
import type { SkillVersionGate } from "../interfaces/skill-eval-store.js";
import type { EvalSourceSwitch, liveEvalSource } from "../runtime/live-eval-source.js";
import type { Authored, SkillEvalAuthoring, TriedCase } from "../runtime/skill-evals/authoring.js";
import { type ApiResult, apiError } from "./api.js";
import type { PauseDeps, UiPauses } from "./pause-api.js";
import { Withholder } from "./withhold.js";

/** The suite list: GET /api/v1/evals. */
export const EVALS_LIST_PATH = "/api/v1/evals";

/** /api/v1/evals/<skill>/<read>, with the URL-encoded skill_ref and the read as its groups. */
export const EVALS_PATH = /^\/api\/v1\/evals\/([^/]+)\/(runs|grid|compare|suite)$/;

type EvalsDeps = {
  store: Pick<FactoryStore, "listSkillEvalRuns" | "getSkillEvalRun" | "listSkillEvalReplays" | "listSkillEvalSuites" | "listSkillEvalCases" | "listHeldSkillVersionGates" | "listAlerts">;
  scanner: EgressScanner;
};
/** src/core/skill-eval-compare.ts's grid and compare, the same functions the CLI is given. */
export interface SkillEvalReads {
  grid: typeof skillEvalGrid;
  compare: typeof compareSkillEvalRuns;
}

/** `value` with every string in it (nested too) through the Withholder. */
async function withheld(w: Withholder, value: unknown): Promise<unknown> {
  if (typeof value === "string") return (await w.plain(value)).text;
  if (Array.isArray(value)) return Promise.all(value.map((v) => withheld(w, v)));
  if (value === null || typeof value !== "object") return value;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) out[k] = await withheld(w, v);
  return out;
}

/** Answers one GET under /api/v1/evals/<skill>/ (EVALS_PATH). */
export async function readSkillEvals(d: EvalsDeps, reads: SkillEvalReads, url: URL): Promise<ApiResult> {
  const [, encoded, read] = EVALS_PATH.exec(url.pathname) ?? [];
  const skill = skillOf(encoded);
  if (typeof skill !== "string") return skill;
  const w = new Withholder(d.scanner);
  if (read === "runs") return { status: 200, value: { runs: await withheld(w, await d.store.listSkillEvalRuns(skill)) } };
  if (read === "suite") return { status: 200, value: await withheld(w, await suiteOf(d, skill)) };
  if (read === "grid") return { status: 200, value: { rows: await withheld(w, reads.grid(await d.store.listSkillEvalRuns(skill))) } };
  const a = url.searchParams.get("a"), b = url.searchParams.get("b");
  if (!a || !b) return apiError(400, "Name both runs: ?a=<run-a>&b=<run-b>.");
  const [ra, rb, suites] = await Promise.all([d.store.getSkillEvalRun(a), d.store.getSkillEvalRun(b), d.store.listSkillEvalSuites()]);
  const ofSkill = new Set(suites.filter((s) => s.skill_ref === skill).map((s) => s.id));
  if (!ra || !rb || !ofSkill.has(ra.suite_id) || !ofSkill.has(rb.suite_id)) return apiError(404, "No such eval run for this skill.");
  const [va, vb] = await Promise.all([d.store.listSkillEvalReplays(a), d.store.listSkillEvalReplays(b)]);
  return { status: 200, value: await withheld(w, reads.compare(ra, rb, { a: va, b: vb })) };
}

/** The skill_ref of a path's URL-encoded part, or the 400 (not URL-encoded) or 404 (empty) answer. */
export function skillOf(encoded: string | undefined): string | ApiResult {
  let skill: string;
  try {
    skill = decodeURIComponent(encoded ?? "");
  } catch {
    return apiError(400, "The skill is not a URL-encoded skill_ref.");
  }
  return skill === "" ? apiError(404, "Not found.") : skill;
}

/** Answers GET /api/v1/evals: the distinct skill_ref of every suite, sorted, and the held versions, each string through the Withholder. */
export async function readEvalSuites(d: EvalsDeps): Promise<ApiResult> {
  const w = new Withholder(d.scanner);
  const refs = [...new Set((await d.store.listSkillEvalSuites()).map((s) => s.skill_ref))].sort();
  return { status: 200, value: { skills: await withheld(w, refs), held: await withheld(w, await heldVersions(d)) } };
}

/** Most held versions listed: far more than wait on the owner at once. */
const HELD_READ = 50;
/** Most alerts read to name a held version's open alarm (as the alarms view reads). */
const ALERTS_READ = 100;

/** A held version's alarm key: the gate's heldAlertKey (src/core/skill-eval-gate.ts), kept here so this feature imports no core. */
const heldAlertKey = (ref_id: string, version: number): string => `skill_version_gate:${ref_id}:${version}`;

/**
 * The dashboard's settle of one named held version (op `version.settle`): the store's conditional update the bare
 * `/approve` and `/reject` use (settleSkillVersionGate), on that ref and version. A version that is not held is refused
 * in plain words and nothing is written. Once settled, its owner question (the alarm) is dismissed by `by`, so it leaves
 * Needs you; the gate never asks again about a settled version.
 */
async function settleSkillVersion(
  store: Pick<FactoryStore, "getSkillVersionGate" | "settleSkillVersionGate" | "listAlerts" | "dismissAlert">,
  s: { ref_id: string; version: number; command: "approve" | "reject"; by: UserId },
): Promise<{ gate: SkillVersionGate } | { refused: string }> {
  const notHeld = `Version ${s.version} of this skill is not waiting for a decision, so nothing was changed.`;
  const gate = await store.getSkillVersionGate(s.ref_id, s.version);
  if (gate?.state !== "held") return { refused: notHeld };
  if (!(await store.settleSkillVersionGate(s.ref_id, s.version, s.command === "approve" ? "passed" : "rejected", s.by))) return { refused: notHeld };
  const key = heldAlertKey(s.ref_id, s.version);
  const alert = (await store.listAlerts({ limit: ALERTS_READ })).find((a) => a.pattern_key === key);
  if (alert) await store.dismissAlert(alert.id, s.by);
  return { gate: (await store.getSkillVersionGate(s.ref_id, s.version)) ?? gate };
}

/** One case whose pass rate fell in a held version's gate run: its id and its input when that is text (null otherwise). */
interface FellCase {
  case_id: string;
  input: string | null;
}

/** A held skill version as the alarm and the Evals page show it. */
export interface HeldVersion {
  ref_id: string;
  version: number;
  /** The suite's skill_ref of its gate run; null when the run or its suite is gone. */
  skill: string | null;
  pass_rate: number | null;
  /** The current version's pass rate it was compared with, and that version. */
  before: number | null;
  current_version: number | null;
  fell: FellCase[];
  /** The open alarm of this version, as Needs you lists it; null when none. */
  alert_id: string | null;
}

/** The gate detail's fields a held version shows (src/core/skill-eval-gate.ts writes them). */
type HeldDetail = { pass_rate?: number; fell?: string[]; current?: { version?: number; pass_rate?: number | null } };

/** Every held skill version, newest first, with its suite, the cases that fell and its alarm. */
async function heldVersions(d: EvalsDeps): Promise<HeldVersion[]> {
  const gates = await d.store.listHeldSkillVersionGates(HELD_READ);
  if (gates.length === 0) return [];
  const [suites, alerts] = await Promise.all([d.store.listSkillEvalSuites(), d.store.listAlerts({ limit: ALERTS_READ })]);
  return Promise.all(gates.map(async (g): Promise<HeldVersion> => {
    const detail = (g.detail ?? {}) as HeldDetail;
    const run = g.run_id === null ? null : await d.store.getSkillEvalRun(g.run_id);
    const suite = run ? suites.find((s) => s.id === run.suite_id) : undefined;
    const cases = suite ? await d.store.listSkillEvalCases(suite.id) : [];
    const fell = (detail.fell ?? []).map((case_id) => {
      const input = cases.find((c) => c.id === case_id)?.input;
      return { case_id, input: typeof input === "string" ? input : null };
    });
    const key = heldAlertKey(g.ref_id, g.version);
    return {
      ref_id: g.ref_id, version: g.version, skill: suite?.skill_ref ?? null, pass_rate: detail.pass_rate ?? null,
      before: detail.current?.pass_rate ?? null, current_version: detail.current?.version ?? null, fell,
      alert_id: alerts.find((a) => a.pattern_key === key)?.id ?? null,
    };
  }));
}

/** The skill's suite (its first, by creation) and its cases; a null suite and no cases when it has none. */
async function suiteOf(d: EvalsDeps, skill: string): Promise<{ suite: unknown; cases: unknown[] }> {
  const suite = (await d.store.listSkillEvalSuites()).find((s) => s.skill_ref === skill) ?? null;
  return { suite, cases: suite ? await d.store.listSkillEvalCases(suite.id) : [] };
}

export const EVALS_WRITE_PATH = "/api/v1/evals/write";

/** What the write route needs beside the store and the owner check (wired by `factory ui`). */
export interface UiEvals {
  /** The CLI's authoring rules with ids bound, and its import (src/skill-evals.ts skillEvalAuthoring, main.ts importCases). */
  authoring: Pick<SkillEvalAuthoring, "addSuite" | "renameSuite" | "deleteSuite" | "addCase" | "editCase"> & { importCases: NonNullable<SkillEvalAuthoring["importCases"]> };
  /** `eval case try` over the configured plugins (src/skill-evals.ts skillEvalTry); stores no run and no replay. */
  tryCase(store: FactoryStore, r: { case_id: string; model_class: string; signal: AbortSignal }): Promise<Authored<TriedCase>>;
  /** The eval source switch: the `integrations` entry, else `plugins.eval_source`. */
  source: EvalSourceSwitch<{ readonly enabled: boolean }>;
  /**
   * `eval run <skill>` over the configured plugins (src/skill-evals.ts skillEvalRun): the stored run, or why nothing was
   * run and no run written (no suite, a model class not stored, a judge class not the model's, replays other than 1).
   * Absent: POST /api/v1/evals/<skill>/runs is a 405.
   */
  run?(store: FactoryStore, r: { skill: string; created_by: UserId; signal: AbortSignal; model_class?: string; judge_model_class?: string; replays?: number }): Promise<{ run: { id: string; status: string } } | { refused: string }>;
}

/** The UI's dependencies with the evals write route. Absent `evals`: a POST to it is a 405. */
export type EvalsWriteDeps = PauseDeps & { evals?: UiEvals };

const OPS = ["suite.add", "suite.rename", "suite.delete", "case.add", "case.edit", "case.delete", "case.try", "import", "version.settle"] as const;
type Op = (typeof OPS)[number];
type Body = Record<string, unknown>;

const text = (b: Body, key: string): string | null => (typeof b[key] === "string" && (b[key] as string).trim() !== "" ? (b[key] as string) : null);

/** What the op needs and the body lacks, or null: `skill` for suite ops, add and import; `ref`, `version` and `decision` for a settle; `case` for the others. */
function missing(op: Op, b: Body): string | null {
  if (op === "version.settle") {
    if (text(b, "ref") === null) return "ref must be a non-empty string (a skill ref id)";
    if (typeof b.version !== "number" || !Number.isInteger(b.version) || b.version < 1) return "version must be a whole number from 1";
    return b.decision === "approve" || b.decision === "reject" ? null : "decision must be approve or reject";
  }
  if (op.startsWith("suite.") || op === "case.add" || op === "import") {
    if (text(b, "skill") === null) return "skill must be a non-empty string";
  } else if (text(b, "case") === null) return "case must be a non-empty string (a case id)";
  if ((op === "suite.rename" || (op === "suite.add" && b.title !== undefined)) && text(b, "title") === null) return "title must be a non-empty string";
  if (op === "case.try" && b.model !== undefined && text(b, "model") === null) return "model must be cheap, standard or strong";
  return null;
}

/** The page's factory user when they are allowed approve_spec, else the 403. */
async function approver(p: UiPauses): Promise<{ user: string } | ApiResult> {
  const user = await p.principal();
  if (user === null) return apiError(403, "No factory user acts from this page: link your local account or set cli_user.");
  const decision = await p.authorize(user);
  return decision.allow ? { user } : apiError(403, `Changing skill evals needs write permission (approve_spec): ${decision.reason}.`);
}

/** POST /api/v1/evals/write, after the request guards; `live` is src/runtime/live-eval-source.ts's, from the route table. */
export async function writeEvals(d: EvalsWriteDeps, e: UiEvals, p: UiPauses, body: unknown, live: typeof liveEvalSource): Promise<ApiResult> {
  if (body === null || typeof body !== "object" || Array.isArray(body)) return apiError(400, "The body must be a JSON object with an op.");
  const b = body as Body;
  const op = OPS.find((o) => o === b.op);
  if (op === undefined) return apiError(400, `op must be one of ${OPS.join(", ")}.`);
  const bad = missing(op, b);
  if (bad !== null) return apiError(400, `${op}: ${bad}.`);
  const who = await approver(p);
  if (!("user" in who)) return who;
  const done = await runOp(d.store, e, op, b, who.user, live);
  const w = new Withholder(d.scanner);
  if ("refused" in done) return apiError(409, (await w.plain(done.refused)).text);
  return { status: 200, value: { op, ...((await withheld(w, done.value)) as Body) } };
}

/** The op through the CLI's rules: the answer's fields, or why nothing was written. */
async function runOp(store: FactoryStore, e: UiEvals, op: Op, b: Body, user: string, live: typeof liveEvalSource): Promise<Authored<Body>> {
  const skill = text(b, "skill")!, id = text(b, "case")!, title = text(b, "title");
  const as = (key: string) => <T>(r: Authored<T>): Authored<Body> => ("refused" in r ? r : { value: { [key]: r.value } });
  switch (op) {
    case "suite.add":
      return as("suite")(await e.authoring.addSuite(store, { skill, ...(title !== null && { title }), created_by: user }));
    case "suite.rename":
      return as("suite")(await e.authoring.renameSuite(store, skill, title!));
    case "suite.delete": {
      // The runs stay in the store, unlisted; `runs` is how many keep their history.
      const r = await e.authoring.deleteSuite(store, skill, () => {});
      return "refused" in r ? r : { value: { skill, runs: r.value.runs } };
    }
    case "case.add":
      return as("case")(await e.authoring.addCase(store, skill, { input: b.input, expected: b.expected }));
    case "case.edit":
      return as("case")(await e.authoring.editCase(store, id, { input: b.input, expected: b.expected }));
    case "case.delete":
      return (await store.deleteSkillEvalCase(id)) ? { value: { case: id } } : { refused: `no skill eval case ${id}: nothing deleted` };
    case "case.try": {
      const on = await live(e.source);
      if ("refused" in on) return on;
      const r = await e.tryCase(store, { case_id: id, model_class: text(b, "model") ?? "standard", signal: new AbortController().signal });
      return "refused" in r ? r : { value: { case: id, source: on.name, tried: r.value } };
    }
    case "import": {
      const on = await live(e.source);
      if ("refused" in on) return on;
      const r = await e.authoring.importCases(store, { skill, source: on.name });
      return "refused" in r ? r : { value: { skill, ...r.value } };
    }
    case "version.settle": {
      const decision = b.decision as "approve" | "reject";
      const r = await settleSkillVersion(store, { ref_id: text(b, "ref")!, version: b.version as number, command: decision, by: user as UserId });
      return "refused" in r ? r : { value: { ref: r.gate.ref_id, version: r.gate.version, decision, state: r.gate.state } };
    }
  }
}
