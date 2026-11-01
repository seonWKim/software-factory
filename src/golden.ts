// Golden set for the reviewer (design §6 Measurement): known-bad and known-good factory PRs, replayed
// through the same runner, prompt, schema and tools as the worker's review run, scored as catch rate and
// false-alarm rate. Cases live in the repo (`golden/cases/<pr>/`); results live under the state dir, never
// in the store. Nothing here writes to GitHub, builds a ToolBroker, or pushes.

import { randomBytes } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { LoadedConfig, Prompts } from "./core/config.js";
import type { ProjectRef } from "./core/project.js";
import { REVIEW_SCHEMA, parseReview } from "./core/outputs.js";
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
  const item = await store.getWorkItemByPr(project, pr);
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
  loaded: { root: string; stateDir: string; config: LoadedConfig; prompts: Prompts },
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
  };
}

export type Verdict = "bug" | "pass" | "errored";

export interface CaseResult {
  id: string;
  expect: Expect;
  verdict: Verdict;
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
  work_item_id: string;
  diff: string;
  spec: string;
}

/** Every case under `casesDir`, sorted by id. A malformed case fails the whole run before any agent runs. */
async function loadCases(casesDir: string): Promise<LoadedCase[]> {
  if (!(await exists(casesDir))) return [];
  const ids = (await readdir(casesDir, { withFileTypes: true }))
    .filter((e) => e.isDirectory() && !e.name.startsWith("."))
    .map((e) => e.name)
    .sort((a, b) => Number(a) - Number(b) || a.localeCompare(b));
  const out: LoadedCase[] = [];
  for (const id of ids) {
    const dir = join(casesDir, id);
    const meta = JSON.parse(await readFile(join(dir, "case.json"), "utf8")) as { expect?: string; work_item_id?: string };
    const expect = checkExpect(typeof meta.expect === "string" ? meta.expect : "", `case ${id}: expect`)!;
    out.push({
      id,
      expect,
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
export async function runCases(deps: GoldenRunDeps, opts: { agent: string }): Promise<GoldenReport> {
  checkAgent(opts.agent);
  const cases = await loadCases(deps.casesDir);
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
      model_class: "strong",
      timeout_ms: deps.config.run_timeout_ms,
      output_schema: REVIEW_SCHEMA,
      signal,
    });
    if (result.status !== "completed") return errored;
    const review = parseReview(result.output);
    if (!review.ok) return errored;
    return { id: c.id, expect: c.expect, verdict: review.value.verdict, findings: review.value.findings };
  } catch {
    return errored;
  } finally {
    if (handle) await deps.sandbox.destroy(handle);
  }
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
