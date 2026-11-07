// Golden set for the reviewer (design §6 Measurement): known-bad and known-good factory PRs, replayed
// through the same runner, prompt, schema and tools as the worker's review run, scored as catch rate and
// false-alarm rate. Cases live in the repo (`golden/cases/<pr>/`); results live under the state dir, never
// in the store. Nothing here writes to GitHub, builds a ToolBroker, or pushes. `compareCases` replays the
// same cases twice through `runCases` (base prompt, head prompt) and applies GOLDEN_MARGIN; it runs locally
// only (design §6, owner decision 2026-11-07: no model credential in GitHub Actions).

import { randomBytes } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { LoadedConfig, Prompts } from "./core/config.js";
import { DEFAULT_MODEL_TABLE, type ModelTable, modelClassFor } from "./core/model-choice.js";
import type { ProjectRef } from "./core/project.js";
import { REVIEW_SCHEMA, findingLine, parseReview } from "./core/outputs.js";
import type { RunId, StateChange, WorkItem, WorkItemId } from "./core/types.js";
import { toolsNamed } from "./core/worker.js";
import type { AgentRunner } from "./interfaces/agent-runner.js";
import type { Clock } from "./interfaces/clock.js";
import type { EgressChannel, EgressScanner } from "./interfaces/egress-scanner.js";
import type { FactoryStore } from "./interfaces/factory-store.js";
import type { Sandbox, SandboxHandle } from "./interfaces/sandbox.js";
import type { SecretStore } from "./interfaces/secret-store.js";

export const EXPECTS = ["should_flag", "should_pass"] as const;
export type Expect = (typeof EXPECTS)[number];

/**
 * The tool names of the worker's review run (`WRITE_TOOLS` in src/core/worker.ts), resolved to the shared
 * tool specs with `toolsNamed`.
 * tests/golden.test.ts checks this against a real Worker review run, so a drift fails the tests.
 */
export const REVIEW_HARNESS_TOOLS: readonly string[] = ["Bash", "Read", "Edit", "Write", "Glob", "Grep"];

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

  const sources = [human, outcome === "reverted" || outcome === "fixed_forward" ? revert : null].filter(
    (c): c is StateChange => c !== null,
  );
  return {
    item,
    record: {
      pr_number: pr,
      work_item_id: item.id,
      outcome,
      human_verdict: human ? { reason: human.reason, actor_id: human.actor.id, record_id: human.id } : null,
      revert_reason:
        revert && (outcome === "reverted" || outcome === "fixed_forward")
          ? { reason: revert.reason, record_id: revert.id, detail: revert.detail }
          : null,
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
    throw new GoldenError(
      requested === "should_flag"
        ? "a should_flag case cannot come from a clean merge"
        : "a clean merge can only be a should_pass case, and only with an explicit --expect should_pass",
    );
  }
  if (requested === "should_pass") throw new GoldenError(`a should_pass case cannot come from a ${outcome} PR`);
  if (requested === undefined && outcome === "held") {
    throw new GoldenError("a held PR has no outcome yet; pass --expect should_flag to add it anyway");
  }
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
  expect?: string;
  force?: boolean;
}

export function parseAddArgs(args: readonly string[]): AddOptions {
  const usage = "usage: factory golden add <pr> [--expect should_flag|should_pass] [--force]";
  const out: AddOptions = { pr: "", force: false };
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--force") out.force = true;
    else if (a === "--expect") {
      const v = args[++i];
      if (v === undefined) throw new GoldenError(usage);
      out.expect = checkExpect(v)!;
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
  /** `<repo>/golden/cases`. */
  casesDir: string;
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
 * Writes `golden/cases/<pr>/` (diff.patch, spec.md, case.json). Every file is G5-scanned with channel
 * `commit` first (the files are meant to be committed); any finding writes nothing. The files are written
 * to a temp sibling and renamed into place, so a failure never leaves a partial case.
 */
export async function addCase(deps: AddDeps, opts: AddOptions): Promise<{ dir: string; case: GoldenCase }> {
  const pr = checkPr(opts.pr);
  const requested = checkExpect(opts.expect);
  const id = String(pr);
  const dir = join(deps.casesDir, id);
  if ((await exists(dir)) && !opts.force) throw new GoldenError(`golden/cases/${id} already exists; pass --force to replace it`);

  const found = await readPrRecord(deps.store, deps.project.key, pr);
  if (!found) throw new GoldenError(`PR #${pr} has no factory work item in ${deps.project.label}`);
  const { item, record } = found;
  const expect = decideExpect(record.outcome, requested);

  const diff = await deps.github.pullDiff(pr);
  const golden: GoldenCase = {
    id,
    pr_number: pr,
    work_item_id: item.id,
    expect,
    outcome: record.outcome,
    human_verdict: record.human_verdict,
    revert_reason: record.revert_reason,
    source_record_ids: record.source_record_ids,
  };
  const files: Record<string, string> = {
    "diff.patch": diff,
    "spec.md": renderSpec(item),
    "case.json": `${JSON.stringify(golden, null, 2)}\n`,
  };
  await scanAll(deps.scanner, "commit", Object.values(files), `golden/cases/${id}`);

  await mkdir(deps.casesDir, { recursive: true });
  const tmp = join(deps.casesDir, `.${id}.tmp-${randomBytes(4).toString("hex")}`);
  try {
    await mkdir(tmp);
    for (const [name, content] of Object.entries(files)) await writeFile(join(tmp, name), content);
    if (opts.force) await rm(dir, { recursive: true, force: true });
    await rename(tmp, dir);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
  return { dir, case: golden };
}

/** The work item spec, in the same form the worker gives the reviewer (`renderWorkItem` with the spec). */
export function renderSpec(item: WorkItem): string {
  return [
    `# Work item ${item.id}`,
    "",
    `Source: ${item.source.link}`,
    "",
    "## Problem",
    "",
    item.problem,
    "",
    "## Done criteria",
    ...(item.done_criteria ?? []).map((c) => `- ${c}`),
    "",
    `## Desired output\n\n${item.desired_output ?? ""}`,
    "",
    `## Scope\n\n${item.scope ?? ""}`,
    "",
    "## Allowed paths (do not change files outside these)",
    ...item.allowed_paths.map((p) => `- ${p}`),
  ].join("\n");
}

// ---------------------------------------------------------------------------------------------------------
// golden run

export const GOLDEN_AGENTS = ["reviewer"] as const;
export type GoldenAgent = (typeof GOLDEN_AGENTS)[number];

/** The prompt file (under `prompts/`) each agent's replay uses: a case without a `prompts` tag gets its agent's. */
export const AGENT_PROMPT: Record<GoldenAgent, string> = { reviewer: "review.md" };

function checkAgent(agent: string | undefined): GoldenAgent {
  if (agent !== "reviewer") throw new GoldenError(`only --agent reviewer is supported (got ${agent === undefined ? "none" : JSON.stringify(agent)})`);
  return agent;
}

export function parseRunArgs(args: readonly string[]): { agent: GoldenAgent } {
  const i = args.indexOf("--agent");
  const extra = args.filter((a, j) => a !== "--agent" && j !== i + 1);
  if (extra.length > 0) throw new GoldenError(`unknown argument ${extra[0]}; usage: factory golden run --agent reviewer`);
  return { agent: checkAgent(i >= 0 ? args[i + 1] : undefined) };
}

export interface GoldenRunDeps {
  casesDir: string;
  /** `<state_dir>/golden/results`. */
  resultsDir: string;
  sandbox: Sandbox;
  runner: AgentRunner;
  scanner: EgressScanner;
  clock: Clock;
  config: Pick<LoadedConfig, "repo" | "deny_paths" | "run_timeout_ms" | "agent_git_identity">;
  /** prompts/review.md: the worker's review system prompt. */
  reviewPrompt: string;
  /** `model_by` from config: the replay uses the review run's class. Absent: the default table. */
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
  const sandbox = await p.sandbox();
  const runner = await p.runner(sandbox, secrets);
  return {
    casesDir: join(loaded.root, "golden", "cases"),
    resultsDir: join(loaded.stateDir, "golden", "results"),
    sandbox,
    runner,
    scanner,
    clock,
    config: loaded.config,
    reviewPrompt: loaded.prompts.review,
    ...(loaded.model_by ? { model_by: loaded.model_by } : {}),
  };
}

export type Verdict = "bug" | "pass" | "errored";

export interface CaseResult {
  id: string;
  expect: Expect;
  verdict: Verdict;
  /** One line per finding: a code finding's text, a spec finding's text marked `(spec)` (issue #222). */
  findings: string[];
}

export interface Rate {
  numerator: number;
  denominator: number;
  /** null when the denominator is 0. */
  value: number | null;
}

export interface ClassCounts {
  total: number;
  completed: number;
  flagged: number;
  errored: number;
}

export interface Rates {
  counts: Record<Expect, ClassCounts>;
  rates: { catch_rate: Rate; false_alarm_rate: Rate };
}

export interface GoldenReport extends Rates {
  cases: CaseResult[];
  results_file: string;
}

/**
 * catch_rate = flagged / completed should_flag runs; false_alarm_rate = flagged / completed should_pass
 * runs. Flagged means verdict `bug`. Errored runs (failed, or invalid output) count in neither rate.
 */
export function computeRates(results: readonly CaseResult[]): Rates {
  const counts = (e: Expect): ClassCounts => {
    const mine = results.filter((r) => r.expect === e);
    const completed = mine.filter((r) => r.verdict !== "errored");
    return {
      total: mine.length,
      completed: completed.length,
      flagged: completed.filter((r) => r.verdict === "bug").length,
      errored: mine.length - completed.length,
    };
  };
  const rate = (c: ClassCounts): Rate => ({
    numerator: c.flagged,
    denominator: c.completed,
    value: c.completed === 0 ? null : c.flagged / c.completed,
  });
  const flag = counts("should_flag");
  const pass = counts("should_pass");
  return {
    counts: { should_flag: flag, should_pass: pass },
    rates: { catch_rate: rate(flag), false_alarm_rate: rate(pass) },
  };
}

function formatRate(name: string, r: Rate): string {
  return r.value === null ? `${name}: n/a (${r.numerator}/${r.denominator})` : `${name}: ${r.numerator}/${r.denominator} = ${r.value.toFixed(3)}`;
}

export function formatReport(report: GoldenReport): string {
  const { should_flag: f, should_pass: p } = report.counts;
  return [
    ...report.cases.map((c) => `  case ${c.id} (${c.expect}): ${c.verdict}`),
    formatRate("catch_rate", report.rates.catch_rate),
    formatRate("false_alarm_rate", report.rates.false_alarm_rate),
    `errored: ${f.errored + p.errored} (should_flag ${f.errored}, should_pass ${p.errored}), excluded from both rates`,
    `results: ${report.results_file}`,
  ].join("\n");
}

interface LoadedCase {
  id: string;
  expect: Expect;
  /** The prompt files the case replays (`case.json` `prompts`, else the agent's prompt). */
  prompts: string[];
  work_item_id: string;
  diff: string;
  spec: string;
}

/**
 * Every case under `casesDir`, sorted by id; with `only`, just the cases tagged with one of those prompts.
 * A malformed case fails the whole run before any agent runs.
 */
async function loadCases(casesDir: string, agent: GoldenAgent, only?: readonly string[]): Promise<LoadedCase[]> {
  if (!(await exists(casesDir))) return [];
  const ids = (await readdir(casesDir, { withFileTypes: true }))
    .filter((e) => e.isDirectory() && !e.name.startsWith("."))
    .map((e) => e.name)
    .sort((a, b) => Number(a) - Number(b) || a.localeCompare(b));
  const out: LoadedCase[] = [];
  for (const id of ids) {
    const dir = join(casesDir, id);
    const meta = JSON.parse(await readFile(join(dir, "case.json"), "utf8")) as { expect?: string; work_item_id?: string; prompts?: unknown };
    const expect = checkExpect(typeof meta.expect === "string" ? meta.expect : "", `case ${id}: expect`)!;
    const prompts = casePrompts(meta.prompts, id) ?? [AGENT_PROMPT[agent]];
    if (only && !prompts.some((p) => only.includes(p))) continue;
    out.push({
      id,
      expect,
      prompts,
      work_item_id: typeof meta.work_item_id === "string" ? meta.work_item_id : `golden_${id}`,
      diff: await readFile(join(dir, "diff.patch"), "utf8"),
      spec: await readFile(join(dir, "spec.md"), "utf8"),
    });
  }
  return out;
}

/**
 * Replays every case through the reviewer, once each, then writes the results file. Each case gets its
 * own detached sandbox (`branch: null`), destroyed after. The prompt is the stored spec plus the stored
 * diff, in the worker's review layout; no doc index, so a replay does not depend on the docs at run time.
 */
export async function runCases(deps: GoldenRunDeps, opts: { agent: string; prompts?: readonly string[] }): Promise<GoldenReport> {
  const agent = checkAgent(opts.agent);
  const cases = await loadCases(deps.casesDir, agent, opts.prompts);
  const stamp = deps.clock.now().toISOString();
  const signal = deps.signal ?? new AbortController().signal;
  const results: CaseResult[] = [];
  for (const c of cases) results.push(await runOne(deps, c, stamp, signal));

  const rates = computeRates(results);
  const body = `${JSON.stringify({ at: stamp, agent: opts.agent, cases: results, ...rates }, null, 2)}\n`;
  await scanAll(deps.scanner, "run_outcome", [body], "the results file");
  await mkdir(deps.resultsDir, { recursive: true });
  const file = join(deps.resultsDir, `${stamp.replace(/[:.]/g, "-")}.json`);
  await writeFile(file, body, { flag: "wx" });
  return { ...rates, cases: results, results_file: file };
}

function casePrompts(v: unknown, id: string): string[] | null {
  if (v === undefined) return null;
  if (!Array.isArray(v) || v.length === 0 || !v.every((p) => typeof p === "string" && /^[\w.-]+\.md$/.test(p))) {
    throw new GoldenError(`case ${id}: prompts must be a non-empty list of prompt file names (e.g. "review.md")`);
  }
  return v as string[];
}

async function runOne(deps: GoldenRunDeps, c: LoadedCase, stamp: string, signal: AbortSignal): Promise<CaseResult> {
  const { repo } = deps.config;
  const errored: CaseResult = { id: c.id, expect: c.expect, verdict: "errored", findings: [] };
  let handle: SandboxHandle | null = null;
  try {
    handle = await deps.sandbox.create({ repo: repo.path, branch: null, base_ref: repo.base_branch });
    const result = await deps.runner.run({
      run_id: `golden_${stamp}_${c.id}` as RunId,
      work_item_id: c.work_item_id as WorkItemId,
      role: "review",
      sandbox: handle,
      system_prompt: deps.reviewPrompt,
      prompt: `${c.spec}\n\n## Diff\n\n\`\`\`diff\n${c.diff}\n\`\`\``,
      tools: toolsNamed(REVIEW_HARNESS_TOOLS),
      tool_grants: [],
      lease_token: 0,
      env_allowlist: gitIdentity(deps.config.agent_git_identity),
      deny_paths: deps.config.deny_paths,
      writable_paths: [],
      // The review run's class (cases carry no tier or loop: tier 5's entry, no retry bump), so golden
      // results match production review.
      model_class: modelClassFor(deps.model_by ?? DEFAULT_MODEL_TABLE, "review", null, 0),
      timeout_ms: deps.config.run_timeout_ms,
      output_schema: REVIEW_SCHEMA,
      signal,
    });
    if (result.status !== "completed") return errored;
    const review = parseReview(result.output);
    if (!review.ok) return errored;
    // Scored on the verdict alone: unverified checks never make a case flagged (issue #222).
    return { id: c.id, expect: c.expect, verdict: review.value.verdict, findings: review.value.findings.map(findingLine) };
  } catch {
    return errored;
  } finally {
    if (handle) await deps.sandbox.destroy(handle);
  }
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
  "src/core/worker.ts",
  "src/impl/runner/",
  "src/impl/claude/",
  "src/impl/openai/",
  "src/impl/llm/",
];

/** The prompt files a change to `changed` (repo-relative paths) can affect; `null` (no change list) means all. */
export function affectedPrompts(changed: readonly string[] | null, all: readonly string[]): string[] {
  if (changed === null) return [...all];
  const code = changed.some((f) => PROMPT_CODE_PATHS.some((p) => (p.endsWith("/") ? f.startsWith(p) : f === p)));
  if (code) return [...all];
  return all.filter((name) => changed.includes(`prompts/${name}`));
}

export interface CompareOptions {
  agent: GoldenAgent;
  /** Path of the base prompt file (the head prompt is the repo's current one). */
  base: string;
  /** `--since <ref>`: the changed paths are read from git against this ref; absent: the repo's base branch. */
  since?: string;
  /** `--all`: replay without looking at what changed. */
  all: boolean;
}

export function parseCompareArgs(args: readonly string[]): CompareOptions {
  const usage = "usage: factory golden compare --base <file> [--agent reviewer] [--since <ref> | --all]";
  let agent: string | undefined = "reviewer";
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
  return { agent: checkAgent(agent), base, ...(since !== undefined ? { since } : {}), all };
}

export type CompareOutcome = "pass" | "fail" | "skipped";

export interface CompareReport {
  agent: GoldenAgent;
  outcome: CompareOutcome;
  /** Why it skipped or failed; null on a pass. */
  reason: string | null;
  margin: number;
  /** The prompt files whose cases were replayed. */
  prompts: string[];
  base: Rates["rates"] | null;
  head: Rates["rates"] | null;
  /** `<resultsDir>/compare-<timestamp>/compare.json`. */
  record_file: string;
}

/** Fails when the catch rate drops, or the false-alarm rate rises, by more than `margin`. Null rates skip. */
export function compareRates(base: Rates["rates"], head: Rates["rates"], margin = GOLDEN_MARGIN): { outcome: CompareOutcome; reason: string | null } {
  const na = (
    [
      ["base catch_rate", base.catch_rate],
      ["base false_alarm_rate", base.false_alarm_rate],
      ["head catch_rate", head.catch_rate],
      ["head false_alarm_rate", head.false_alarm_rate],
    ] as const
  ).filter(([, r]) => r.value === null);
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
 * Replays the cases of the prompts `changed` affects through `runCases`, once with `basePrompt` and once
 * with the head prompt (`deps.reviewPrompt`), and compares the rates. Skips (no replay) when the change
 * touches no prompt or prompt code, when no case is tagged with an affected prompt, or (after the replay)
 * when a rate is n/a. Every outcome is recorded in `compare.json` (G5-scanned, channel `run_outcome`).
 */
export async function compareCases(
  deps: GoldenRunDeps,
  opts: { agent: GoldenAgent; basePrompt: string; changed: readonly string[] | null },
): Promise<CompareReport> {
  const agent = checkAgent(opts.agent);
  const prompt = AGENT_PROMPT[agent];
  const dir = join(deps.resultsDir, `compare-${deps.clock.now().toISOString().replace(/[:.]/g, "-")}`);
  const prompts = affectedPrompts(opts.changed, [prompt]);
  let base: Rates["rates"] | null = null;
  let head: Rates["rates"] | null = null;
  let verdict: { outcome: CompareOutcome; reason: string | null };
  if (prompts.length === 0) {
    verdict = { outcome: "skipped", reason: `the change touches neither prompts/${prompt} nor the code that fills or sends prompts` };
  } else if ((await loadCases(deps.casesDir, agent, prompts)).length === 0) {
    verdict = { outcome: "skipped", reason: `no golden cases tagged ${prompts.join(", ")} in golden/cases` };
  } else {
    // The same replay path for both sides; each side keeps its own results file.
    const run = (reviewPrompt: string, side: string) =>
      runCases({ ...deps, reviewPrompt, resultsDir: join(dir, side) }, { agent, prompts });
    base = (await run(opts.basePrompt, "base")).rates;
    head = (await run(deps.reviewPrompt, "head")).rates;
    verdict = compareRates(base, head);
  }
  const record_file = join(dir, "compare.json");
  const report: CompareReport = { agent, ...verdict, margin: GOLDEN_MARGIN, prompts, base, head, record_file };
  const body = `${JSON.stringify({ ...report, record_file: undefined }, null, 2)}\n`;
  await scanAll(deps.scanner, "run_outcome", [body], "the compare record");
  await mkdir(dir, { recursive: true });
  await writeFile(record_file, body, { flag: "wx" });
  return report;
}

/** The compare report as Markdown, for a terminal or a job summary. */
export function formatCompare(r: CompareReport): string {
  const side = (name: string, rates: Rates["rates"] | null) =>
    rates ? [`- ${name}: ${formatRate("catch_rate", rates.catch_rate)}; ${formatRate("false_alarm_rate", rates.false_alarm_rate)}`] : [];
  return [
    `## golden compare (${r.agent}): ${r.outcome}`,
    "",
    ...(r.outcome === "skipped" ? [`Comparison skipped: ${r.reason}.`] : []),
    ...(r.outcome === "fail" ? [`Failed: ${r.reason}.`] : []),
    ...side("base", r.base),
    ...side("head", r.head),
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

async function exists(p: string): Promise<boolean> {
  return stat(p).then(
    () => true,
    () => false,
  );
}
