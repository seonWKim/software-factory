// Golden sets per role (design §6 Measurement): known-bad and known-good factory PRs, replayed through the
// runner with the role descriptor's prompt and tools and the role's output schema, scored as pass rate, catch rate and
// false-alarm rate. Cases live in the role's folder (`src/worker/roles/<name>/golden/<case-id>/`, found by
// goldenCasesByRole); results live under the state dir, never in the store. Nothing here writes to GitHub, builds a ToolBroker, or pushes. `compareCases` replays the
// same cases twice through `runCases` (base prompt, head prompt) and applies GOLDEN_MARGIN; it runs locally
// only (design §6, owner decision 2026-11-07: no model credential in GitHub Actions).

import { randomBytes } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { LoadedConfig, Prompts } from "./core/config.js";
import { DEFAULT_MODEL_TABLE, type ModelTable, isModelRunKind, modelClassFor } from "./core/model-choice.js";
import type { ProjectRef } from "./core/project.js";
import { REVIEW_CONFIRM_SCHEMA, REVIEW_SCHEMA, TRIAGE_SCHEMA, findingLine, parseJudge, parseReview, parseReviewConfirm, parseTriage } from "./core/outputs.js";
import { isCovered } from "./core/policy.js";
import type { RunKind, StateChange, WorkItem, WorkItemId } from "./core/types.js";
import { ROLES_DIR, goldenCasesByRole, loadRoles, replayInSandbox } from "./runtime/index.js";
import { implementReplayRunner } from "./controller/golden-gate/implement-replay.js";
import { loadTriageCases, triageReplayRunner } from "./controller/golden-gate/triage-replay.js";
export { genTriageDrafts, parseGenArgs } from "./controller/golden-gate/triage-gen.js"; // golden gen (drafts triage cases from a closed item)
import { ROLE_NAME, type RoleDescriptor } from "./shared/role.js";
import { toolsNamed } from "./worker/index.js"; import { JUDGE_SCHEMA } from "./worker/runs/judge/judge.run.js";
import type { AgentRunner } from "./interfaces/agent-runner.js";
import type { Clock } from "./interfaces/clock.js";
import type { EgressChannel, EgressScanner } from "./interfaces/egress-scanner.js";
import type { FactoryStore } from "./interfaces/factory-store.js";
import type { Sandbox } from "./interfaces/sandbox.js";
import type { SecretStore } from "./interfaces/secret-store.js";

export const EXPECTS = ["should_flag", "should_pass"] as const;
export type Expect = (typeof EXPECTS)[number];

/** Thrown for every refusal. Messages carry rule names and codes, never matched text. */
export class GoldenError extends Error {}

// ---------------------------------------------------------------------------------------------------------
// PR records

/**
 * What happened to a factory PR, from the store's records:
 * - `rejected`: the item closed with `close_reason: rejected` (a human closed the PR unmerged).
 * - `reverted`: merged, then a `reverted` row (design §6 revert tracking).
 * - `fixed_forward`: merged, then a `fixed_forward` row.
 * - `clean_merge`: merged, with neither row.
 * - `held`: anything else: the PR is open, or waits on a human.
 */
export type PrOutcome = "clean_merge" | "rejected" | "reverted" | "fixed_forward" | "held";

export interface PrRecord {
  pr_number: number;
  work_item_id: WorkItemId;
  outcome: PrOutcome;
  /** The human's merge or close row (actor ID only), or null when no human acted yet. */
  human_verdict: { reason: string; actor_id: string; record_id: string } | null;
  /** The latest `reverted` or `fixed_forward` row, or null. */
  revert_reason: { reason: string; record_id: string; detail: StateChange["detail"] } | null;
  /** IDs of the state_changes rows the outcome was read from, oldest first. */
  source_record_ids: string[];
}

const HUMAN_VERDICT_REASONS = new Set(["pr_merged", "pr_closed_unmerged"]);
const REVERT_REASONS = new Set(["reverted", "fixed_forward"]);

/**
 * The PR's record, through the store APIs: `getWorkItemByPr` and `listStateChanges` (the merge/close rows
 * and the revert/fix-forward rows). Null when PR `pr` in `project` (a project key) is not a factory PR. Read-only.
 */
export async function readPrRecord(
  store: Pick<FactoryStore, "getWorkItemByPr" | "listStateChanges">,
  project: string,
  pr: number,
): Promise<{ item: WorkItem; record: PrRecord } | null> {
  const item = await store.getWorkItemByPr(project, String(pr));
  if (!item) return null;
  const changes = await store.listStateChanges(item.id);
  const human = changes.filter((c) => HUMAN_VERDICT_REASONS.has(c.reason)).at(-1) ?? null;
  const revert = changes.filter((c) => REVERT_REASONS.has(c.reason)).at(-1) ?? null;

  let outcome: PrOutcome;
  if (item.stage === "CLOSED" && item.close_reason === "rejected") outcome = "rejected";
  else if (item.stage === "CLOSED" && item.close_reason === "completed") {
    outcome = revert ? (revert.reason as "reverted" | "fixed_forward") : "clean_merge";
  } else outcome = "held";

  const rev = revert && (outcome === "reverted" || outcome === "fixed_forward") ? revert : null;
  const sources = [human, rev].filter((c): c is StateChange => c !== null);
  return {
    item,
    record: {
      pr_number: pr,
      work_item_id: item.id,
      outcome,
      human_verdict: human ? { reason: human.reason, actor_id: human.actor.id, record_id: human.id } : null,
      revert_reason: rev ? { reason: rev.reason, record_id: rev.id, detail: rev.detail } : null,
      source_record_ids: sources.map((c) => c.id),
    },
  };
}

/**
 * The case's `expect`, or a refusal. `should_pass` only from a clean merge, and only when asked for
 * explicitly; `should_flag` never from a clean merge. Without `--expect`, a rejected, reverted or
 * fixed-forward PR defaults to `should_flag`; a held PR or a clean merge must say which.
 */
export function decideExpect(outcome: PrOutcome, requested: Expect | undefined): Expect {
  if (outcome === "clean_merge") {
    if (requested === "should_pass") return "should_pass";
    throw new GoldenError(requested === "should_flag" ? "a should_flag case cannot come from a clean merge" : "a clean merge can only be a should_pass case, and only with an explicit --expect should_pass");
  }
  if (requested === "should_pass") throw new GoldenError(`a should_pass case cannot come from a ${outcome} PR`);
  if (requested === undefined && outcome === "held") throw new GoldenError("a held PR has no outcome yet; pass --expect should_flag to add it anyway");
  return "should_flag";
}

function checkExpect(v: string | undefined, what = "expect"): Expect | undefined {
  if (v === undefined) return undefined;
  if (!(EXPECTS as readonly string[]).includes(v)) throw new GoldenError(`${what} must be should_flag or should_pass`);
  return v as Expect;
}

function checkPr(pr: string): number {
  const n = Number(pr);
  if (!/^[1-9][0-9]*$/.test(pr) || !Number.isSafeInteger(n)) throw new GoldenError("the PR number must be a positive integer");
  return n;
}

// ---------------------------------------------------------------------------------------------------------
// golden add

export interface AddOptions {
  pr: string;
  /** The role whose folder gets the case; `--role`, else review. */
  role: string;
  expect?: string;
  force?: boolean;
}

export function parseAddArgs(args: readonly string[]): AddOptions {
  const usage = "usage: factory golden add <pr> [--role <name>] [--expect should_flag|should_pass] [--force]";
  const out: AddOptions = { pr: "", role: "review", force: false };
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--force") out.force = true;
    else if (a === "--expect" || a === "--role") {
      const v = args[++i];
      if (v === undefined) throw new GoldenError(usage);
      if (a === "--role") out.role = checkRole(v);
      else out.expect = checkExpect(v)!;
    } else if (a.startsWith("--")) throw new GoldenError(`unknown option ${a}; ${usage}`);
    else if (out.pr === "") out.pr = a;
    else throw new GoldenError(usage);
  }
  if (out.pr === "") throw new GoldenError(usage);
  return out;
}

export interface AddDeps {
  store: Pick<FactoryStore, "getWorkItemByPr" | "listStateChanges">;
  /** The configured repo, resolved at startup: lookups use its key, messages its label (design 2026-11-01). */
  project: ProjectRef;
  /** Read-only. GitHubClient.pullDiff bound to the configured repo. */
  github: { pullDiff(pr: number): Promise<string> };
  scanner: EgressScanner;
  /** `<repo>/src/worker/roles`. */
  rolesDir: string;
}

export interface GoldenCase {
  id: string;
  pr_number: number;
  work_item_id: WorkItemId;
  expect: Expect;
  outcome: PrOutcome;
  human_verdict: PrRecord["human_verdict"];
  revert_reason: PrRecord["revert_reason"];
  source_record_ids: string[];
}

/**
 * Writes `src/worker/roles/<role>/golden/<pr>/` (instruction.md, environment/diff.patch, case.json). Every file is G5-scanned with channel
 * `commit` first (the files are meant to be committed); any finding writes nothing. The files are written
 * to a temp sibling and renamed into place, so a failure never leaves a partial case.
 */
export async function addCase(deps: AddDeps, opts: AddOptions): Promise<{ dir: string; case: GoldenCase }> {
  const pr = checkPr(opts.pr);
  const requested = checkExpect(opts.expect);
  const id = String(pr);
  const golden = join(deps.rolesDir, checkRole(opts.role), "golden");
  const dir = join(golden, id);
  const rel = `${ROLES_DIR}/${opts.role}/golden/${id}`;
  if ((await stat(dir).then(() => true, () => false)) && !opts.force) throw new GoldenError(`${rel} already exists; pass --force to replace it`);

  const found = await readPrRecord(deps.store, deps.project.key, pr);
  if (!found) throw new GoldenError(`PR #${pr} has no factory work item in ${deps.project.label}`);
  const { item, record } = found;
  const expect = decideExpect(record.outcome, requested);

  const diff = await deps.github.pullDiff(pr);
  const kase: GoldenCase = { id, pr_number: pr, work_item_id: item.id, expect, outcome: record.outcome, human_verdict: record.human_verdict, revert_reason: record.revert_reason, source_record_ids: record.source_record_ids };
  const files: Record<string, string> = { [CASE_DIFF]: diff, [CASE_INSTRUCTION]: renderSpec(item), "case.json": `${JSON.stringify(kase, null, 2)}\n` };
  await scanAll(deps.scanner, "commit", Object.values(files), rel);

  await mkdir(golden, { recursive: true });
  const tmp = join(golden, `.${id}.tmp-${randomBytes(4).toString("hex")}`);
  try {
    for (const [name, content] of Object.entries(files)) {
      await mkdir(dirname(join(tmp, name)), { recursive: true });
      await writeFile(join(tmp, name), content);
    }
    if (opts.force) await rm(dir, { recursive: true, force: true });
    await rename(tmp, dir);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
  return { dir, case: kase };
}

/** A case's files besides case.json: the work item spec, and the diff under review. */
const CASE_INSTRUCTION = "instruction.md";
const CASE_DIFF = join("environment", "diff.patch");

function checkRole(name: string): string {
  if (!ROLE_NAME.test(name)) throw new GoldenError(`role "${name}" must be a kebab-case role name`);
  return name;
}

/** The work item spec, in the same form the worker gives the reviewer (`renderWorkItem` with the spec). */
export function renderSpec(item: WorkItem): string {
  return [
    `# Work item ${item.id}`, "", `Source: ${item.source.link}`, "", "## Problem", "", item.problem, "", "## Done criteria", ...(item.done_criteria ?? []).map((c) => `- ${c}`), "",
    `## Desired output\n\n${item.desired_output ?? ""}`, "", `## Scope\n\n${item.scope ?? ""}`, "",
    "## Allowed paths (do not change files outside these)", ...item.allowed_paths.map((p) => `- ${p}`),
  ].join("\n");
}

// ---------------------------------------------------------------------------------------------------------
// golden run

export function parseRunArgs(args: readonly string[]): { role: string } {
  const m = args.length === 1 ? /^role\/(.*)$/.exec(args[0]!) : null;
  if (!m) throw new GoldenError(`usage: factory golden run role/<name> (got ${args.map((a) => JSON.stringify(a)).join(" ") || "none"})`);
  return { role: checkRole(m[1]!) };
}

export interface GoldenRunDeps {
  /** `<repo>/src/worker/roles`: each role's cases are under `<name>/golden/`. */
  rolesDir: string;
  /** The discovered role descriptors: a replay takes its prompt and tools from the role's. */
  roles: { get(name: string): RoleDescriptor | null };
  /** A prompt file's text (a name under prompts/, e.g. "review.md"), as the worker gives it. */
  prompt(file: string): Promise<string>;
  /** `<state_dir>/golden/results`. */
  resultsDir: string;
  sandbox: Sandbox;
  runner: AgentRunner;
  scanner: EgressScanner;
  clock: Clock;
  config: Pick<LoadedConfig, "repo" | "deny_paths" | "run_timeout_ms" | "agent_git_identity">;
  /** `model_by` from config: the replay uses the role's run class. Absent: the default table. */
  model_by?: ModelTable;
  signal?: AbortSignal;
}

/** The plugin factories golden run needs. It never asks for the store or a broker. */
export interface GoldenPlugins {
  clock(): Promise<Clock>;
  secrets(): Promise<SecretStore>;
  scanner(secrets: SecretStore): Promise<EgressScanner>;
  sandbox(): Promise<Sandbox>;
  runner(sandbox: Sandbox, secrets: SecretStore): Promise<AgentRunner>;
}

/** Builds golden run's parts through the configured plugins: no store, no broker, no GitHub client. */
export async function buildGoldenRunDeps(
  p: GoldenPlugins,
  loaded: { root: string; stateDir: string; config: LoadedConfig; prompts: Prompts; model_by?: ModelTable },
): Promise<GoldenRunDeps> {
  const clock = await p.clock();
  const secrets = await p.secrets();
  const scanner = await p.scanner(secrets);
  const rolesDir = join(loaded.root, ROLES_DIR), sandbox = await p.sandbox(), runner = triageReplayRunner(implementReplayRunner(await p.runner(sandbox, secrets), sandbox, rolesDir), rolesDir, TRIAGE_PARTS);
  // The loaded prompts carry their placeholders filled; a prompt file outside them is read as it is.
  const loadedPrompts: Record<string, string | undefined> = { ...loaded.prompts };
  const prompt = async (file: string) => loadedPrompts[file.replace(/\.md$/, "")] ?? readFile(join(loaded.root, "prompts", file), "utf8");
  const resultsDir = join(loaded.stateDir, "golden", "results");
  return { rolesDir, roles: await loadRoles(), prompt, resultsDir, sandbox, runner, scanner, clock, config: loaded.config, ...(loaded.model_by ? { model_by: loaded.model_by } : {}) };
}

export const TRIAGE_PARTS = { schema: TRIAGE_SCHEMA, parse: (v: unknown) => parseTriage(v), covered: isCovered }; // a triage replay's schema, parser, path check

export type Verdict = "bug" | "pass" | "errored";

export interface CaseResult {
  id: string;
  expect: Expect;
  verdict: Verdict;
  /** One line per finding: a code finding's text, a spec finding's text marked `(spec)` (issue #222). */
  findings: string[];
  /** The runner's usage (0 when the run never started), and the time from sandbox create to destroy. */
  input_tokens: number; output_tokens: number; wall_ms: number;
}

export interface Rate {
  numerator: number;
  denominator: number;
  /** null when the denominator is 0. */
  value: number | null;
}

export interface ClassCounts { total: number; completed: number; flagged: number; errored: number }

export interface Rates {
  counts: Record<Expect, ClassCounts>;
  rates: { pass_rate: Rate; catch_rate: Rate; false_alarm_rate: Rate };
}

/** pass^k over a role's cases (design 06-measurement): `pass_k` is null with fewer than 2 replays; `unstable` lists `<role>/<case id>: m/k` for each case with mixed replays. */
export interface Stability { replays: number; pass_k: Rate | null; unstable: string[] }

export interface GoldenReport extends Rates, Stability {
  role: string;
  cases: CaseResult[];
  totals: Pick<CaseResult, "input_tokens" | "output_tokens" | "wall_ms">;
  results_file: string;
}

/** Whether a completed case's verdict is what it expects: `bug` for should_flag, `pass` for should_pass. */
const matches = (r: Pick<CaseResult, "expect" | "verdict">) => r.verdict === (r.expect === "should_flag" ? "bug" : "pass");

/**
 * pass_rate = completed runs whose verdict matches expect / completed runs; catch_rate = flagged / completed
 * should_flag runs; false_alarm_rate = flagged / completed should_pass runs. Flagged means verdict `bug`.
 * Errored runs (failed, or invalid output) count in no rate.
 */
export function computeRates(results: readonly Pick<CaseResult, "expect" | "verdict">[]): Rates {
  const counts = (e: Expect): ClassCounts => {
    const mine = results.filter((r) => r.expect === e);
    const completed = mine.filter((r) => r.verdict !== "errored");
    return { total: mine.length, completed: completed.length, flagged: completed.filter((r) => r.verdict === "bug").length, errored: mine.length - completed.length };
  };
  const rate = (numerator: number, denominator: number): Rate => ({ numerator, denominator, value: denominator === 0 ? null : numerator / denominator });
  const flag = counts("should_flag");
  const pass = counts("should_pass");
  const completed = results.filter((r) => r.verdict !== "errored");
  const rates = { pass_rate: rate(completed.filter(matches).length, completed.length), catch_rate: rate(flag.flagged, flag.completed), false_alarm_rate: rate(pass.flagged, pass.completed) };
  return { counts: { should_flag: flag, should_pass: pass }, rates };
}

/**
 * pass_k = cases whose `replays` replays all match expect / cases (an errored replay does not match, so its case fails).
 * A case with some replays matching and some not is unstable, listed as `<role>/<id>: m/k`. With fewer than 2 replays: no pass_k, no list.
 */
export function computeStability(role: string, results: readonly Pick<CaseResult, "id" | "expect" | "verdict">[], replays: number): Stability {
  if (replays < 2) return { replays, pass_k: null, unstable: [] };
  const matched = new Map<string, number>();
  for (const r of results) matched.set(r.id, (matched.get(r.id) ?? 0) + (r.verdict !== "errored" && matches(r) ? 1 : 0));
  const stable = [...matched.values()].filter((m) => m === replays).length;
  const unstable = [...matched].filter(([, m]) => m > 0 && m < replays).map(([id, m]) => `${role}/${id}: ${m}/${replays}`);
  return { replays, pass_k: { numerator: stable, denominator: matched.size, value: matched.size === 0 ? null : stable / matched.size }, unstable };
}

/** `pass_k: n/d = value` lines (and the unstable cases) for a report with 2 or more replays; nothing otherwise. */
const stabilityLines = (s: Stability): string[] => (s.pass_k ? [formatRate("pass_k", s.pass_k), ...s.unstable.map((u) => `unstable ${u}`)] : []);

function formatRate(name: string, r: Rate): string {
  return r.value === null ? `${name}: n/a (${r.numerator}/${r.denominator})` : `${name}: ${r.numerator}/${r.denominator} = ${r.value.toFixed(3)}`;
}

const usageText = (u: GoldenReport["totals"]) => `input_tokens ${u.input_tokens}, output_tokens ${u.output_tokens}, wall_ms ${u.wall_ms}`;

export function formatReport(report: GoldenReport): string {
  const { should_flag: f, should_pass: p } = report.counts;
  return [
    ...report.cases.map((c) => `  case ${c.id} (${c.expect}): ${c.verdict}, ${c.verdict === "errored" ? "n/a" : matches(c) ? "match" : "miss"}; ${usageText(c)}`),
    `total (${report.role}, ${report.cases.length} cases): ${usageText(report.totals)}`,
    formatRate("pass_rate", report.rates.pass_rate),
    ...(report.pass_k ? [formatRate("pass_k", report.pass_k)] : []),
    formatRate("catch_rate", report.rates.catch_rate),
    formatRate("false_alarm_rate", report.rates.false_alarm_rate),
    `errored: ${f.errored + p.errored} (should_flag ${f.errored}, should_pass ${p.errored}), excluded from every rate`,
    ...report.unstable.map((u) => `unstable ${u}`),
    `results: ${report.results_file}`,
  ].join("\n");
}

interface LoadedCase {
  id: string; expect: Expect;
  /** The prompt files the case replays (`case.json` `prompts`, else the role's prompt). */
  prompts: string[];
  work_item_id: string; spec: string;
  diff: string | null; // null for a triage case: it replays its instruction.md alone
}

/** The role's descriptor, refusing a role with none or with no prompt (it calls no model, so nothing to replay). */
function roleFor(deps: Pick<GoldenRunDeps, "roles">, name: string): RoleDescriptor & { prompt: string } {
  const role = deps.roles.get(name);
  if (!role) throw new GoldenError(`role ${name} has no descriptor (src/worker/roles/${name}.role.ts)`);
  if (role.prompt === null) throw new GoldenError(`role ${name} calls no model (prompt: null); it has no golden replay`);
  return role as RoleDescriptor & { prompt: string };
}

/** The role's cases (goldenCasesByRole), sorted by id; with `only`, just the cases tagged with one of those prompts. A malformed case fails the whole run before any agent runs. */
async function loadCases(rolesDir: string, role: RoleDescriptor & { prompt: string }, only?: readonly string[], ids?: readonly string[]): Promise<LoadedCase[]> {
  const out: LoadedCase[] = [];
  if (role.name === "triage") loadTriageCases(rolesDir); // a triage case with bad `checks` is malformed too
  for (const id of (goldenCasesByRole(rolesDir).get(role.name) ?? []).filter((i) => !ids || ids.includes(i))) {
    const dir = join(rolesDir, role.name, "golden", id);
    const meta = JSON.parse(await readFile(join(dir, "case.json"), "utf8")) as { expect?: string; work_item_id?: string; prompts?: unknown };
    const expect = checkExpect(typeof meta.expect === "string" ? meta.expect : "", `case ${id}: expect`)!;
    const prompts = casePrompts(meta.prompts, id) ?? [role.prompt];
    if (only && !prompts.some((p) => only.includes(p))) continue;
    const work_item_id = typeof meta.work_item_id === "string" ? meta.work_item_id : `golden_${id}`;
    out.push({ id, expect, prompts, work_item_id, diff: role.name === "triage" ? null : await readFile(join(dir, CASE_DIFF), "utf8"), spec: await readFile(join(dir, CASE_INSTRUCTION), "utf8") });
  }
  return out;
}

/** The replay prompt: the stored spec plus the stored diff, in the worker's review layout; the spec alone with no diff. */
export const replayPrompt = (c: Pick<LoadedCase, "spec" | "diff">) => (c.diff === null ? c.spec : `${c.spec}\n\n## Diff\n\n\`\`\`diff\n${c.diff}\n\`\`\``);

/** Replays every case of `role` (with `ids`, only those) `replays` times each (default once), then writes the results file. Each replay goes through replayInSandbox: its own detached sandbox, destroyed after, and no doc index (a replay does not depend on the docs). */
export async function runCases(deps: GoldenRunDeps, opts: { role: string; prompts?: readonly string[]; ids?: readonly string[]; replays?: number }): Promise<GoldenReport> {
  const role = roleFor(deps, opts.role);
  const cases = await loadCases(deps.rolesDir, role, opts.prompts, opts.ids);
  const system = await deps.prompt(role.prompt);
  const stamp = deps.clock.now().toISOString();
  const signal = deps.signal ?? new AbortController().signal;
  const results: CaseResult[] = [];
  const replays = opts.replays ?? 1;
  for (const c of cases) for (let n = 0; n < replays; n++) results.push(await runOne(deps, role, system, c, `${stamp}_${c.id}${n > 0 ? `_${n}` : ""}`, signal));

  const rates = computeRates(results);
  const stability = computeStability(role.name, results, replays);
  const sum = (k: keyof GoldenReport["totals"]) => results.reduce((n, r) => n + r[k], 0);
  const totals = { input_tokens: sum("input_tokens"), output_tokens: sum("output_tokens"), wall_ms: sum("wall_ms") };
  const body = `${JSON.stringify({ at: stamp, role: role.name, cases: results, totals, ...rates, ...stability }, null, 2)}\n`;
  await scanAll(deps.scanner, "run_outcome", [body], "the results file");
  await mkdir(deps.resultsDir, { recursive: true });
  const file = join(deps.resultsDir, `${stamp.replace(/[:.]/g, "-")}.json`);
  await writeFile(file, body, { flag: "wx" });
  return { ...rates, ...stability, role: role.name, cases: results, totals, results_file: file };
}

function casePrompts(v: unknown, id: string): string[] | null {
  if (v === undefined) return null;
  if (!Array.isArray(v) || v.length === 0 || !v.every((p) => typeof p === "string" && /^[\w.-]+\.md$/.test(p))) {
    throw new GoldenError(`case ${id}: prompts must be a non-empty list of prompt file names (e.g. "review.md")`);
  }
  return v as string[];
}

/** One replay through the shared replay primitive (replayInSandbox): a fresh detached sandbox, destroyed after. */
async function runOne(deps: GoldenRunDeps, role: RoleDescriptor, system: string, c: LoadedCase, key: string, signal: AbortSignal): Promise<CaseResult> {
  const { repo } = deps.config;
  const started = deps.clock.now().getTime();
  const out: CaseResult = { id: c.id, expect: c.expect, verdict: "errored", findings: [], input_tokens: 0, output_tokens: 0, wall_ms: 0 };
  try {
    const confirm = role.name === "review-confirm", judge = role.name === "judge", kind = (confirm ? "review" : role.name) as RunKind; // review-confirm replays on the review's class (design 04-agents), the judge on strong as the runner pins it
    const result = await replayInSandbox(deps, {
      repo,
      run_id: `golden_${key}`,
      work_item_id: c.work_item_id,
      role: role.name,
      system_prompt: system,
      prompt: replayPrompt(c),
      tools: toolsNamed(role.tools),
      env_allowlist: gitIdentity(deps.config.agent_git_identity),
      deny_paths: deps.config.deny_paths,
      // The role's run class (cases carry no tier or loop: tier 5's entry, no retry bump), so golden results
      // match production; a role with no model_by entry replays on the standard class.
      model_class: judge ? "strong" : isModelRunKind(kind) ? modelClassFor(deps.model_by ?? DEFAULT_MODEL_TABLE, kind, null, 0) : "standard",
      timeout_ms: deps.config.run_timeout_ms,
      output_schema: confirm ? REVIEW_CONFIRM_SCHEMA : judge ? JUDGE_SCHEMA : REVIEW_SCHEMA,
      signal,
    });
    Object.assign(out, { input_tokens: result.usage.input_tokens, output_tokens: result.usage.output_tokens });
    const answer = result.status !== "completed" ? null : confirm ? parseReviewConfirm(result.output) : judge ? parseJudge(result.output) : parseReview(result.output);
    // Scored on the verdict alone: unverified checks never make a case flagged (issue #222); a confirmed finding flags a review-confirm case, a fix or ask verdict a judge case.
    if (answer?.ok) Object.assign(out, "confirmed" in answer.value ? { verdict: answer.value.confirmed ? "bug" : "pass" } : "findings" in answer.value ? { verdict: answer.value.verdict, findings: answer.value.findings.map(findingLine) } : { verdict: answer.value.verdict === "fix" || answer.value.verdict === "ask" ? "bug" : "pass" });
  } catch {
    // errored, with whatever usage was read
  } finally {
    out.wall_ms = deps.clock.now().getTime() - started;
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------
// golden compare

/**
 * The most the catch rate may drop, or the false-alarm rate may rise, from the base prompt to the head
 * prompt before the comparison fails. A proposed default (design §6); one replay per case, so it is coarse.
 */
export const GOLDEN_MARGIN = 0.05;

/**
 * Code that fills or sends every prompt: a change to one of these replays the cases of every prompt.
 * An entry ending in `/` is a directory. A change under `prompts/` replays only that prompt's cases.
 */
export const PROMPT_CODE_PATHS: readonly string[] = [
  "src/golden.ts",
  "src/core/outputs.ts",
  "src/core/model-choice.ts",
  "src/worker/",
  "src/impl/runner/",
  "src/impl/claude/",
  "src/impl/openai/",
  "src/impl/llm/",
];

/**
 * The prompt files a change to `changed` (repo-relative paths) can affect; `null` (no change list) means all.
 * A path under a role's golden folder (`src/worker/roles/<name>/golden/`) is a case, not prompt code.
 */
export function affectedPrompts(changed: readonly string[] | null, all: readonly string[]): string[] {
  if (changed === null) return [...all];
  const code = changed.filter((f) => !/^src\/worker\/roles\/[^/]+\/golden\//.test(f)).some((f) => PROMPT_CODE_PATHS.some((p) => (p.endsWith("/") ? f.startsWith(p) : f === p)));
  if (code) return [...all];
  return all.filter((name) => changed.includes(`prompts/${name}`));
}

export interface CompareOptions {
  /** The role whose cases replay: `--agent reviewer` (the only agent, until compare takes `role/<name>`) is review. */
  role: string;
  /** Path of the base prompt file (the head prompt is the repo's current one). */
  base: string;
  /** `--since <ref>`: the changed paths are read from git against this ref; absent: the repo's base branch. */
  since?: string;
  /** `--all`: replay without looking at what changed. */
  all: boolean;
}

export function parseCompareArgs(args: readonly string[]): CompareOptions {
  const usage = "usage: factory golden compare --base <file> [--agent reviewer] [--since <ref> | --all]";
  let agent = "reviewer";
  let base: string | undefined;
  let since: string | undefined;
  let all = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    const value = () => {
      const v = args[++i];
      if (v === undefined || v.startsWith("--")) throw new GoldenError(usage);
      return v;
    };
    if (a === "--agent") agent = value();
    else if (a === "--base") base = value();
    else if (a === "--since") since = value();
    else if (a === "--all") all = true;
    else throw new GoldenError(`unknown argument ${a}; ${usage}`);
  }
  if (base === undefined || (all && since !== undefined)) throw new GoldenError(usage);
  if (agent !== "reviewer") throw new GoldenError(`only --agent reviewer is supported (got ${JSON.stringify(agent)})`);
  return { role: "review", base, ...(since !== undefined ? { since } : {}), all };
}

export type CompareOutcome = "pass" | "fail" | "skipped";

export interface CompareReport {
  role: string;
  outcome: CompareOutcome;
  /** Why it skipped or failed; null on a pass. */
  reason: string | null;
  margin: number;
  /** The prompt files whose cases were replayed. */
  prompts: string[];
  base: Rates["rates"] | null;
  head: Rates["rates"] | null;
  /** Each side's replays, pass_k and unstable cases; null when skipped. */
  base_stability: Stability | null;
  head_stability: Stability | null;
  /** `<resultsDir>/compare-<timestamp>/compare.json`. */
  record_file: string;
}

/** Fails when the catch rate drops, or the false-alarm rate rises, by more than `margin`. Null rates skip. */
export function compareRates(base: Rates["rates"], head: Rates["rates"], margin = GOLDEN_MARGIN): { outcome: CompareOutcome; reason: string | null } {
  const sides = [["base", base], ["head", head]] as const;
  const na = sides.flatMap(([n, r]) => [[`${n} catch_rate`, r.catch_rate], [`${n} false_alarm_rate`, r.false_alarm_rate]] as const).filter(([, r]) => r.value === null);
  if (na.length > 0) return { outcome: "skipped", reason: `n/a rate (no completed case): ${na.map(([n]) => n).join(", ")}` };
  // A tiny epsilon so a change of exactly the margin passes despite floating point.
  const over = (d: number) => d > margin + 1e-9;
  const reasons: string[] = [];
  const drop = base.catch_rate.value! - head.catch_rate.value!;
  const rise = head.false_alarm_rate.value! - base.false_alarm_rate.value!;
  if (over(drop)) reasons.push(`catch_rate dropped by ${drop.toFixed(3)} (more than ${margin})`);
  if (over(rise)) reasons.push(`false_alarm_rate rose by ${rise.toFixed(3)} (more than ${margin})`);
  return reasons.length > 0 ? { outcome: "fail", reason: reasons.join("; ") } : { outcome: "pass", reason: null };
}

/**
 * Replays the role's cases of the prompts `changed` affects through `runCases`, once with `basePrompt` and once
 * with the head prompt (`deps.prompt`), and compares the rates. Skips (no replay) when the change
 * touches no prompt or prompt code, when no case is tagged with an affected prompt, or (after the replay)
 * when a rate is n/a. Every outcome is recorded in `compare.json` (G5-scanned, channel `run_outcome`).
 */
export async function compareCases(
  deps: GoldenRunDeps,
  opts: { role: string; basePrompt: string; changed: readonly string[] | null; replays?: number },
): Promise<CompareReport> {
  const { name: role, prompt } = roleFor(deps, opts.role);
  const dir = join(deps.resultsDir, `compare-${deps.clock.now().toISOString().replace(/[:.]/g, "-")}`);
  const prompts = affectedPrompts(opts.changed, [prompt]);
  let base: Rates["rates"] | null = null;
  let head: Rates["rates"] | null = null;
  let base_stability: Stability | null = null;
  let head_stability: Stability | null = null;
  let verdict: { outcome: CompareOutcome; reason: string | null };
  if (prompts.length === 0) {
    verdict = { outcome: "skipped", reason: `the change touches neither prompts/${prompt} nor the code that fills or sends prompts` };
  } else if ((await loadCases(deps.rolesDir, roleFor(deps, role), prompts)).length === 0) {
    verdict = { outcome: "skipped", reason: `no golden cases tagged ${prompts.join(", ")} in ${ROLES_DIR}/${role}/golden` };
  } else {
    // The same replay path for both sides; each side keeps its own results file.
    const run = (p: GoldenRunDeps["prompt"], side: string) => runCases({ ...deps, prompt: p, resultsDir: join(dir, side) }, { role, prompts, replays: opts.replays ?? 1 });
    const [b, h] = [await run(async () => opts.basePrompt, "base"), await run(deps.prompt, "head")];
    base = b.rates;
    head = h.rates;
    base_stability = { replays: b.replays, pass_k: b.pass_k, unstable: b.unstable };
    head_stability = { replays: h.replays, pass_k: h.pass_k, unstable: h.unstable };
    verdict = compareRates(base, head);
  }
  const record_file = join(dir, "compare.json");
  const report: CompareReport = { role, ...verdict, margin: GOLDEN_MARGIN, prompts, base, head, base_stability, head_stability, record_file };
  const body = `${JSON.stringify({ ...report, record_file: undefined }, null, 2)}\n`;
  await scanAll(deps.scanner, "run_outcome", [body], "the compare record");
  await mkdir(dir, { recursive: true });
  await writeFile(record_file, body, { flag: "wx" });
  return report;
}

/** The compare report as Markdown, for a terminal or a job summary. */
export function formatCompare(r: CompareReport): string {
  const side = (name: string, rates: Rates["rates"] | null, st: Stability | null) =>
    rates ? [`- ${name}: ${formatRate("catch_rate", rates.catch_rate)}; ${formatRate("false_alarm_rate", rates.false_alarm_rate)}`, ...(st ? stabilityLines(st).map((l) => `  - ${l}`) : [])] : [];
  return [
    `## golden compare (${r.role}): ${r.outcome}`,
    "",
    ...(r.outcome === "skipped" ? [`Comparison skipped: ${r.reason}.`] : []),
    ...(r.outcome === "fail" ? [`Failed: ${r.reason}.`] : []),
    ...side("base", r.base, r.base_stability),
    ...side("head", r.head, r.head_stability),
    `- margin: ${r.margin}`,
    ...(r.prompts.length > 0 ? [`- prompts: ${r.prompts.join(", ")}`] : []),
    `- record: ${r.record_file}`,
  ].join("\n");
}

// ---------------------------------------------------------------------------------------------------------

/** G5 over every piece of content; any finding throws with the rule names only. */
async function scanAll(scanner: EgressScanner, channel: EgressChannel, contents: readonly string[], what: string) {
  const rules = new Set<string>();
  for (const content of contents) {
    const r = await scanner.scan(channel, content);
    if (!r.clean) for (const f of r.findings) rules.add(f.rule);
  }
  if (rules.size > 0) throw new GoldenError(`egress scan blocked ${what} (nothing written): ${[...rules].join(", ")}`);
}

function gitIdentity(id: { name: string; email: string }): Record<string, string> {
  return { GIT_AUTHOR_NAME: id.name, GIT_AUTHOR_EMAIL: id.email, GIT_COMMITTER_NAME: id.name, GIT_COMMITTER_EMAIL: id.email };
}

