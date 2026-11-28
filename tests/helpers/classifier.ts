import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect } from "vitest";
import type { FactoryConfig } from "../../src/core/config.js";
import { LiveSettings, baseFromConfig } from "../../src/core/settings.js";
import type { Logger } from "../../src/core/log.js";
import type { SourceRef, Tier, UserId, WorkerId, WorkItemId } from "../../src/core/types.js";
import type { ExternalIdentity } from "../../src/interfaces/auth-provider.js";
import type { ForgeEvent } from "../../src/interfaces/forge.js";
import type { SourceEvent } from "../../src/interfaces/source-adapter.js";
import type { EgressScanner } from "../../src/interfaces/egress-scanner.js";
import type { FactoryStore } from "../../src/interfaces/factory-store.js";
import { skillVersion } from "../../src/runtime/capabilities/capabilities.js";
import { type SkillEvalWiring, runSkillEvalFor } from "../../src/skill-evals.js";
import { readApi } from "../../src/ui/read-routes.js";
import type { ServerDeps, UiRequest } from "../../src/ui/server.js";
import type { Sandbox } from "../../src/interfaces/sandbox.js";
import { NoKeepAwake } from "../../src/impl/awake/no-keep-awake.js";
import { FakeClock } from "../../src/impl/clock/fake-clock.js";
import { ControllerRole } from "../../src/runtime/roles/controller-role.js";
import { Worker } from "../../src/worker/index.js";
import { FakeBroker } from "./fakes/broker.js";
import { alice, cleanScanner, config, issueRef, prompts, silent, triageSpec } from "./fakes/config.js";
import { FakeAuth, FakeRunner, FakeSandbox, MemoryStorage } from "./fakes/runner.js";
import { FakeForge } from "./fakes/forge.js";
import { FakeSource } from "./fakes/source.js";
import { newStore } from "./store.js";
import { CLASSIFY_SYSTEM } from "../../src/core/classify-message.js";
import type { LLMProvider, LLMRequest, LLMResponse } from "../../src/interfaces/llm-provider.js";
import { localProject } from "../../src/load-config.js";
import { type CliAction, runLocalCli } from "../../src/core/local-cli.js";
import { IMPROVER } from "../../src/core/improver.js";
import { AUTO_ACTOR } from "../../src/core/policy.js";
import type { ChildRestart } from "../../src/interfaces/updater.js";
import { OwnerAuth } from "../../src/core/authorize.js";
import { LocalToolBroker } from "../../src/impl/broker/local-tool-broker.js";
import { NoOpSandbox } from "../../src/impl/sandbox/noop-sandbox.js";
import { LocalForge } from "../../src/impl/forge/local-forge.js";
import { LocalSource } from "../../src/impl/source/local-source.js";
import { parseModeArgs, runSettings } from "../../src/settings-cmd.js";
import { answersDetail, splitAnswers } from "../../src/shared/command-notes.js";
import { seedMergeRecord } from "./merge-record.js";

// Fake LLMs written for the interpreter answer the classifier in front of it (design 04-gate-commands) with this,
// so their scripted interpreter answers stay as they were.

/** `label` as the classifier's answer when `req` is the classifier's request; else null (the request is the interpreter's). */
export function classifierAnswer(req: LLMRequest, label = "command"): LLMResponse | null {
  return req.system === CLASSIFY_SYSTEM ? { text: label, stop_reason: "end", usage: { input_tokens: 1, output_tokens: 1, cost_usd: null } } : null;
}

// The triage outcome with the mode on auto: the setup the triage test files share.
export async function autoTriage(spec: Record<string, unknown>, sandbox?: Sandbox) {
  const cfg: FactoryConfig = { ...config, dials: { spec_gate_min_tier: 1, auto_merge_max_tier: 0 } };
  const clock = new FakeClock();
  const { store } = await newStore(clock);
  const source = new FakeSource();
  const settings = new LiveSettings({ config: cfg, base: baseFromConfig(cfg), source: store });
  await store.setSettingOverride({ key: "mode", project: "", value: JSON.stringify("auto"), actor: "local:me@example.com" as UserId });
  const controller = new ControllerRole({ store, source, auth: new FakeAuth(), clock, config: cfg, log: silent, scanner: cleanScanner, repeated_failure_rule: false, settings, ...(sandbox && { sandbox }) });
  const runner = new FakeRunner({ triage: () => ({ output: spec }) });
  const worker = new Worker({
    id: "w1" as WorkerId, store, sandbox: new FakeSandbox(), runner, broker: new FakeBroker(), storage: new MemoryStorage(),
    clock, config: cfg, prompts, log: silent, scanner: cleanScanner, toolEnv: {}, awake: new NoKeepAwake(),
  });
  source.queue.push({ kind: "item_requested", source: issueRef(1), requester: alice, title: "t", body: "b" });
  await controller.tickIntake();
  expect(await worker.tick()).toBe(true);
  await controller.tickRuns();
  const it = (await store.getWorkItemBySource("github_issue", issueRef(1).id))!;
  return { it, store, source, changes: await store.listStateChanges(it.id) };
}

// Shared by the skill-eval versions test files (design 06-measurement): fakes only, no live model.
export const OWNER = "local:owner" as UserId;
export const REQ: UiRequest = { method: "GET", url: undefined, host: "127.0.0.1" };
export const V1 = "# Review helper\n\nRead the change.\nReview the diff carefully.\n";
export const V2 = "# Review helper\n\nRead the change.\nReview the diff, then the tests.\n";
/** Flags any text holding LEAK. */
export const FLAGGING: EgressScanner = { scan: async (channel, t) => (t.includes("LEAK") ? { clean: false, findings: [{ rule: "test_rule", channel }] } : { clean: true }) };

/** A judge that answers yes when the replay's output names the tests (V2) or the case is CASE-A, else no. */
export class RubricLLM implements LLMProvider {
  async complete(req: LLMRequest): Promise<LLMResponse> {
    const said = req.messages.map((m) => m.content).join("\n");
    const answer = said.includes("then the tests") || said.includes("CASE-A") ? "yes" : "no";
    const parsed = { answers: [{ answer, reason: "ok" }] };
    return { text: JSON.stringify(parsed), parsed, stop_reason: "end", usage: { input_tokens: 1, output_tokens: 1, cost_usd: null } };
  }
}

/** A suite for an imported skill folder with two cases, the folder's two imported versions (v2 current), and the wiring. */
export async function setup(tmp: string) {
  const { store, clock } = await newStore();
  const folder = join(tmp, "skills", "review-helper");
  await mkdir(folder, { recursive: true });
  const skill = folder;
  await store.createSkillEvalSuite({ id: "s1", skill_ref: skill, title: "Review", created_by: OWNER });
  await store.addSkillEvalCase({ id: "c1", suite_id: "s1", input: "CASE-A", expected: ["names the tests"] });
  await store.addSkillEvalCase({ id: "c2", suite_id: "s1", input: "CASE-B", expected: ["names the tests"] });
  await writeFile(join(folder, "SKILL.md"), V1);
  const h1 = await skillVersion(folder);
  await store.recordSkillVersion({ ref_id: "sr_review", folder_hash: h1, text: V1, source: "claude" });
  clock.advance(1000);
  await writeFile(join(folder, "SKILL.md"), V2);
  const h2 = await skillVersion(folder);
  await store.recordSkillVersion({ ref_id: "sr_review", folder_hash: h2, text: V2, source: "claude" });
  // Both gates passed (design 07-self-improvement): v2 is the gate's current version.
  await store.db.run("UPDATE controller_skill_version_gates SET state = 'passed' WHERE ref_id = 'sr_review'");
  const runner = new FakeRunner({ implement: (spec) => ({ output: `${spec.system_prompt}\n${spec.prompt}` }) });
  let n = 0;
  const d: SkillEvalWiring = {
    store, root: tmp, judgePrompt: async () => "JUDGE", repo: { path: config.repo.path, base_branch: config.repo.base_branch }, deny_paths: [".env"], timeout_ms: 1000,
    plugins: async () => ({ sandbox: new FakeSandbox(), runner, llm: new RubricLLM(), scanner: cleanScanner }),
    newId: () => `run${++n}`,
  };
  const run = async (version?: string) => {
    clock.advance(1000);
    const r = await runSkillEvalFor(d, { skill, created_by: OWNER, signal: new AbortController().signal, ...(version !== undefined && { version }) });
    if (!("run" in r)) throw new Error(r.refused);
    return r.run;
  };
  return { store, clock, d, skill, h1, h2, runner, run };
}

export const get = (store: FactoryStore, path: string, scanner: EgressScanner = cleanScanner) =>
  readApi({ store, scanner } as unknown as ServerDeps, new URL(`http://127.0.0.1${path}`), REQ);
export const versionsPath = (skill: string) => `/api/v1/evals/${encodeURIComponent(skill)}/versions`;
export const diffPath = (skill: string, a: string, b: string) => `/api/v1/evals/${encodeURIComponent(skill)}/diff?a=${a}&b=${b}`;

export const bob: ExternalIdentity = { provider: "github", subject: "2", login: "bob" };

export function prRef(n: number): SourceRef {
  return { type: "github_issue", id: `o/r#${n}`, link: `https://github.com/o/r/pull/${n}` };
}

export function prOpen(n: number, o: Partial<Extract<ForgeEvent, { kind: "change_open" }>> = {}): ForgeEvent {
  return {
    kind: "change_open",
    source: prRef(n),
    change_ref: String(n),
    head_branch: "feature/x",
    head_sha: "h1",
    title: "Speed up the poll",
    body: "It reads fewer pages now.",
    author: bob,
    labels: [],
    ...o,
  };
}

/** The factory wired to fakes for the tests on pull requests it did not open (design 2026-11-01). */
export async function factory(script: ConstructorParameters<typeof FakeRunner>[0] = {}, log: Logger = silent) {
  const clock = new FakeClock();
  const { store } = await newStore(clock);
  const source = new FakeSource();
  const forge = new FakeForge(source);
  const sandbox = new FakeSandbox();
  const broker = new FakeBroker();
  const runner = new FakeRunner({
    triage: () => ({ output: triageSpec }),
    implement: () => ({ output: { summary: "s", next_steps: "n" } }),
    review: () => ({ output: { verdict: "pass", tier: 1, findings: [], summary: "fine" } }),
    ...script,
  });
  const controller = new ControllerRole({ store, source, forge, auth: new FakeAuth(), clock, config, log, scanner: cleanScanner });
  const worker = new Worker({
    id: "w1" as WorkerId, store, sandbox, runner, broker, storage: new MemoryStorage(), clock, config, prompts, log: silent,
    scanner: cleanScanner, toolEnv: { PATH: "/usr/bin" }, awake: new NoKeepAwake(), prRef: (pr) => forge.prRef(pr),
  });
  /** One poll tick: PR events come from the forge, the rest from the source. */
  const poll = async (...events: (SourceEvent | ForgeEvent)[]) => {
    for (const e of events) {
      if (e.kind.startsWith("change_") || e.kind === "pr_changes_requested") forge.queue.push(e as ForgeEvent);
      else source.queue.push(e as SourceEvent);
    }
    await controller.tickIntake();
  };
  const work = async () => {
    while (await worker.tick()) await controller.tickRuns();
    await controller.tickRuns();
  };
  const item = async (n: number) => store.getWorkItemBySource("github_issue", `o/r#${n}`);
  return { clock, store, source, forge, sandbox, broker, runner, controller, worker, poll, work, item };
}

// Auto mode (design 03-risk, issue #444): a local factory over a real git repo, as in local-merge-flow.test.ts, with the
// live settings read from the store each tick. The mode is flipped after the controller is built, so every test also
// shows a running controller reading the new mode at its next tick, with no restart. Each factory starts with a met
// merge record for the review's tier (50 clean merges), so the tier rule lets its change merge unless a test says otherwise.

export const ME = "local:me@example.com" as UserId;
export const DEV = "local:dev@example.com" as UserId;
const GIT_ENV = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null" };
export const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", env: GIT_ENV }).trim();
const ident = ["-c", "user.name=t", "-c", "user.email=t@example.com"];
export const commitIn = (dir: string, files: Record<string, string>, msg: string) => {
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(dir, path, ".."), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
  git(dir, "add", "-A");
  git(dir, ...ident, "commit", "--quiet", "-m", msg);
};
/** A check that passes everywhere except on a merge commit (the merge queue's merge-check run checks one). */
export const FAILS_ON_MERGE = ["sh", "-c", "git rev-parse -q --verify HEAD^2 >/dev/null && exit 1; exit 0"];
const OK = ["sh", "-c", "exit 0"];
/**
 * A UI check that passes on the merge check's merged commit (its subject ends in "(merge check)") and runs `script`
 * anywhere else, such as on the new base tip after an automatic merge: the change lands, and the red-main check fails.
 */
export const uiAfterMerge = (script: string) => ["sh", "-c", `git log -1 --format=%s | grep -q '(merge check)$' && exit 0; ${script}`];
/** A change to a `repo.ui_check` path ("web/"), so the merge check and the red-main check after its merge run the UI check. */
export const UI_CHANGE = { allowed_paths: ["web/"], files_to_change: ["web/app.css"] };

export interface Opts {
  /** The triage answer, over triageSpec. */
  spec?: Record<string, unknown>;
  /** The review's tier. */
  reviewTier?: number;
  test_command?: string[];
  /** Wraps the controller's sandbox (the worker keeps the real one); `clock` is the factory's. */
  controllerSandbox?: (s: NoOpSandbox, clock: FakeClock) => Sandbox;
  /** The text the `n`th implement run (1-based, across items) writes to the spec's file; default "changed\n". */
  change?: (n: number) => string;
  config?: Partial<FactoryConfig>;
  /** The supervisor's restart list the alarm step reads. */
  restarts?: () => Promise<readonly ChildRestart[]>;
  /** `repo.ui_check`: run at merge on a change to its paths, and on the new base tip after an automatic merge. */
  ui_check?: FactoryConfig["repo"]["ui_check"];
  /** The review tier's merge record seeded before the change (seedMergeRecord); default 50 clean merges, a met rule. */
  record?: { merges?: number; bad?: number };
}

export async function autoFactory(opts: Opts = {}) {
  const root = mkdtempSync(join(tmpdir(), "sf-auto-"));
  const repo = join(root, "repo");
  git(root, "init", "--quiet", "-b", "main", repo);
  commitIn(repo, { "README.md": "hi\n" }, "init");
  git(repo, "checkout", "--quiet", "-b", "work");

  const project = localProject({ owner: "o", name: "r" });
  const spec = { ...triageSpec, ...opts.spec };
  const file = String((spec.files_to_change as string[])[0]);
  const cfg: FactoryConfig = {
    ...config,
    project,
    local_only: true,
    repo: { ...config.repo, path: repo, install_command: OK, test_command: opts.test_command ?? OK, ...(opts.ui_check ? { ui_check: opts.ui_check } : {}) },
    ...opts.config,
  };
  const clock = new FakeClock();
  const { store } = await newStore(clock);
  await seedMergeRecord(store, clock, { tier: (opts.reviewTier ?? 2) as Tier, ...opts.record });
  const auth = new OwnerAuth(store);
  const sandbox = new NoOpSandbox(join(root, "wt"), undefined, undefined, { local: true });
  const settings = new LiveSettings({ config: cfg, base: baseFromConfig(cfg), source: store });
  const controller = new ControllerRole({
    store, sources: [new LocalSource(store)], auth, clock, config: cfg, log: silent, scanner: cleanScanner,
    sandbox: opts.controllerSandbox ? opts.controllerSandbox(sandbox, clock) : sandbox, repeated_failure_rule: false, settings,
    check_env: { PATH: process.env.PATH ?? "" }, links: new LocalForge(cfg.branch_prefix, null), ...(opts.restarts ? { restarts: opts.restarts } : {}),
  });
  let implemented = 0;
  const runner = new FakeRunner({
    triage: () => ({ output: spec }),
    implement: (s) => {
      commitIn(s.sandbox.workdir, { [file]: opts.change?.(++implemented) ?? "changed\n" }, "the change");
      return { output: { summary: "done", next_steps: "none" } };
    },
    review: () => ({ output: { verdict: "pass", tier: opts.reviewTier ?? 2, findings: [], summary: "s" } }),
  });
  const broker = new LocalToolBroker({ store, scanner: cleanScanner, branchPrefix: cfg.branch_prefix, repoPath: repo });
  const worker = new Worker({
    id: "w1" as WorkerId, store, sandbox, runner, broker, storage: new MemoryStorage(), clock, config: cfg, prompts, log: silent,
    scanner: cleanScanner, toolEnv: { PATH: process.env.PATH ?? "", HOME: root, GIT_CONFIG_GLOBAL: "/dev/null" }, awake: new NoKeepAwake(),
  });
  const step = async () => {
    await controller.tickIntake();
    while (await worker.tick()) await controller.tickRuns();
    await controller.tickRuns();
  };
  let n = 0;
  const cli = (user: UserId, a: CliAction) =>
    runLocalCli({ answers: { split: splitAnswers, detail: answersDetail }, store, identity: { user, from: "git user.email" }, project: async () => project.key, read: async () => "the body", newId: () => `id${++n}` }, a);
  const create = async () => (await cli(ME, { action: "create", title: "A change", bodyFile: "b.md" })).lines[0] as WorkItemId;
  /** An item the improve run files for a recurring failure (design §7), through the local source as the improver. */
  const fileAsImprover = async () => {
    const source = await new LocalSource(store).fileIssue({
      project: project.key, requester_id: IMPROVER.id as UserId, title: "Recurring failure", body: "the runs", marker: "<!-- factory:improve:k:ir_1 -->",
    });
    return (await store.getWorkItemBySource(source.type, source.id))!.id;
  };
  /** A person's `/approve` of the implement run the Rule of Two held after auto mode's approval, then a step. */
  const approveRun = async (id: WorkItemId) => {
    expect(await store.getWorkItem(id)).toMatchObject({ stage: "RUNNING", blocked_on: "human", blocked_reason: "rule_of_two" });
    expect((await cli(ME, { action: "command", command: "approve", id, text: "" })).code).toBe(0);
    await step();
  };
  /** `factory mode <mode> [--project o/r]` as `who`, with the local auth plugin's approve_merge check. */
  const mode = async (m: string, who: UserId = ME, ...rest: string[]) => {
    const action = parseModeArgs([m, ...rest]);
    if ("error" in action) throw new Error(action.error);
    return runSettings({
      store, base: baseFromConfig(cfg), repo: { owner: "o", name: "r" }, actor: who, resolveProject: async () => project,
      mayApproveMerge: async () => {
        const d = await auth.authorize({ user_id: who }, "approve_merge", { kind: "project", id: project.key });
        return d.allow ? null : d.reason;
      },
    }, action);
  };
  const setting = (key: string, value: unknown) => store.setSettingOverride({ key, project: "", value: JSON.stringify(value), actor: ME });
  const messages = async (id: WorkItemId, prefix: string) => (await store.listItemMessages(id)).filter((m) => m.marker.startsWith(prefix)).map((m) => m.body);
  const changes = async (id: WorkItemId) => store.listStateChanges(id);
  const modeRows = async () => (await store.listSettingChanges(50)).filter((c) => c.key === "mode");
  return { repo, store, controller, step, cli, create, fileAsImprover, approveRun, mode, setting, messages, changes, modeRows, project, clock, cfg };
}

export const AUTO = { kind: "system", id: AUTO_ACTOR };

/** Auto mode was set back to manual once, by `system:auto`, with one `auto_stopped` alert of `cause`. */
export const stopped = async (f: Awaited<ReturnType<typeof autoFactory>>, cause: string) => {
  const rows = await f.modeRows();
  expect(rows.map((r) => [r.new_value, r.actor])).toEqual([['"manual"', AUTO_ACTOR], ['"auto"', ME]]);
  const alerts = (await f.store.listAlerts({ limit: 10 })).filter((a) => a.pattern === "auto_stopped");
  expect(alerts.map((a) => a.error_code)).toEqual([cause]);
};
