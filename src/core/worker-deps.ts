// The worker's dependencies, run routing and the trusted git env, shared by the worker (src/worker/) and legacy
// code (core/session.ts, compose). Legacy on purpose: WorkerDeps still hands the worker an injected Clock (the time
// its tick generators wait on, run timestamps), which src/worker/ may not import (no-clock). They move into the
// worker as those waits move onto its ticks and the session's pushes and PR writes go to outbound (RFC 0015 M6/M7).

import { LOCAL_SOURCE, threadDelivery } from "./local-merge.js";
import { MODEL_CREDENTIAL, MODEL_CREDENTIAL_UNTIL, SETUP_MISSING } from "./policy.js";
import { isModelRunKind } from "./model-choice.js";

export { threadDelivery };
import type { FactoryConfig, Prompts } from "./config.js";
import { type LearnedSettingsSource, LiveSettings } from "./settings.js";
import type { ModelNames, ModelTable } from "./model-choice.js";
import type { GoldenEvidence } from "./proposals.js";
import type { SkillImproveWiring } from "./skill-improve.js";
import type { LogFields, Logger } from "./log.js";
import type { Run, RunKind, SourceRef, WorkItem, WorkerId } from "./types.js";
import type { AgentRunner } from "../interfaces/agent-runner.js";
import type { CapabilitySearch } from "../interfaces/capability-search.js";
import type { Clock } from "../interfaces/clock.js";
import type { EgressScanner } from "../interfaces/egress-scanner.js";
import type { FactoryStore, RunIntent } from "../interfaces/factory-store.js";
import type { KeepAwake } from "../interfaces/keep-awake.js";
import type { LLMProvider } from "../interfaces/llm-provider.js";
import type { ExecResult, Sandbox } from "../interfaces/sandbox.js";
import type { SharedStorage } from "../interfaces/shared-storage.js";
import type { TacitHandOff } from "../interfaces/tacit-ledger.js";
import type { RunPassportIssuer, ToolBroker } from "../interfaces/tool-broker.js";

/** Where a local item's runs go: the local broker (no remote, no PR) and a sandbox on the local base branch. */
export interface LocalRoute {
  broker: ToolBroker;
  sandbox: Sandbox;
}

/**
 * The refspec that copies the base branch from the factory repo into a run folder's `origin/<base>`: the factory
 * repo's `origin/<base>`, or its local `refs/heads/<base>` for a local item (`local`, from routeFor) or when no forge
 * plugin is selected (`local_only`). One rule for both readers: the implement run fetches with it (through
 * worker/support.ts) and `session finish`'s gate base does too.
 */
export function baseRefspec(cfg: Pick<FactoryConfig, "repo" | "local_only">, local: boolean): string {
  const base = cfg.repo.base_branch;
  return `+${cfg.local_only || local ? `refs/heads/${base}` : `refs/remotes/origin/${base}`}:refs/remotes/origin/${base}`;
}

/**
 * An item's broker and sandbox (design 05-sources, Local items): a local item with no PR takes `local` when it is
 * set, never the forge. A local item that already has a PR (one opened before #427) keeps its PR path: its branch
 * and its PR live on the forge, so it takes the forge's broker and sandbox like an item of a forge source.
 */
export function routeFor(
  d: { broker: ToolBroker; sandbox: Sandbox; local?: LocalRoute },
  item: Pick<WorkItem, "source" | "change_ref">,
): LocalRoute & { local: boolean } {
  const local = item.source.type === LOCAL_SOURCE && item.change_ref === null;
  return { ...(local && d.local ? d.local : { broker: d.broker, sandbox: d.sandbox }), local };
}

/** Whether `broker` serves `name`: the local broker has no PR, preflight or comment tool (design 05-sources). */
export function hasTool(broker: ToolBroker, name: string): boolean {
  return broker.allTools().some((t) => t.name === name);
}

/**
 * Env for every trusted git call (worker and broker) in a run folder. GIT_CONFIG_COUNT entries rank as command-line
 * config, above the run's `.git/config`, which the agent can write: no hooks, no fsmonitor, no signing program.
 * Replace refs and grafts the agent wrote cannot change what the gates see.
 */
export const TRUSTED_GIT_ENV: Readonly<Record<string, string>> = {
  GIT_CONFIG_COUNT: "4",
  GIT_CONFIG_KEY_0: "core.hooksPath",
  GIT_CONFIG_VALUE_0: "/dev/null",
  GIT_CONFIG_KEY_1: "core.fsmonitor",
  GIT_CONFIG_VALUE_1: "false",
  GIT_CONFIG_KEY_2: "commit.gpgSign",
  GIT_CONFIG_VALUE_2: "false",
  GIT_CONFIG_KEY_3: "tag.gpgSign",
  GIT_CONFIG_VALUE_3: "false",
  GIT_NO_REPLACE_OBJECTS: "1",
  GIT_GRAFT_FILE: "/dev/null",
  // Without it, every git call prints the grafts deprecation hint (GIT_GRAFT_FILE above) to stderr, and a stored
  // error (cut to 500 characters) holds only the hint, not git's message.
  GIT_ADVICE: "0",
  GIT_TERMINAL_PROMPT: "0",
};

/**
 * The issue title, in full, with no prefix (the bot author and the branch already say it is the factory's). Items
 * from before titles were stored use the problem's first line.
 */
export function prTitle(item: WorkItem): string {
  const title = item.title?.replace(/\s+/g, " ").trim();
  return title || firstLine(item.problem).slice(0, 80);
}

/** A PR's title, body and labels (label name → present), as a run's PR intent sends them. */
export interface PrText {
  readonly title: string;
  readonly body: string;
  readonly labels: Readonly<Record<string, boolean>>;
}

/**
 * A run's push and PR as keyed intents (RFC 0015 M7), once `git.store_branch` stored `sha` in the factory repo of
 * `host`: the push, then the PR (null: no PR write), in one destination (`git:<host>:<branch>`) so the PR waits
 * behind the push. The push is keyed by branch and sha (a head pushed once is never pushed again), the PR by branch
 * and run: each run's PR delivery is its own, so the controller can wait for it, and recording them again stores
 * nothing. Both name the run, which the controller applies when they are delivered. The worker's runs and
 * `factory session finish` record them through the store (`recordRunIntent`).
 */
export function runPushIntents(o: {
  host: string; work_item_id: string; run_id: string; branch: string; sha: string; base_ref: string; pr: PrText | null;
}): { intents: RunIntent[]; push: string; pr: string | null } {
  const target = { type: "git", id: `${o.host}:${o.branch}`, link: "" };
  const push = `push:${o.branch}:${o.sha}`;
  const intents: RunIntent[] = [{ action: "push", target, work_item_id: o.work_item_id, key: push, args: { branch: o.branch, sha: o.sha, run_id: o.run_id } }];
  if (!o.pr) return { intents, push, pr: null };
  const pr = `pr:${o.branch}:${o.run_id}`;
  intents.push({
    action: "pr", target, work_item_id: o.work_item_id, key: pr,
    args: { branch: o.branch, sha: o.sha, run_id: o.run_id, base_ref: o.base_ref, title: o.pr.title, body: o.pr.body, labels: JSON.stringify(o.pr.labels) },
  });
  return { intents, push, pr };
}

export function firstLine(s: string): string {
  return s.split("\n")[0] ?? s;
}

/** The rules and learnings section for a prompt; "" for none. Best effort: it warns on `log` and never rejects. */
export interface GuidanceSource {
  read(log: Logger): Promise<string>;
}

/** A golden replay of the review cases for one improve run: its ID names the results folder; `config` is the run's. */
export type ReviewReplay = (prompt: string, at: { run_id: string; config: FactoryConfig; signal: AbortSignal }) => Promise<GoldenEvidence>;

export interface WorkerDeps {
  /** G2 run passports (RFC 0015 §8, M9): minted at run start, checked by the broker. Compose always sets it. */
  passports?: RunPassportIssuer;
  /** `<host>:<pid>:<n>` under a WorkerPool: unique per worker loop, stored as the lease owner. */
  id: WorkerId;
  /**
   * The worker's index n in its process's pool. Set: passed as SF_WORKER_INDEX to the agent and to the update
   * and resolve runs' gate commands, so parallel runs on one host can pick their own ports or test DB. Unique only within
   * one process. Absent (a lone Worker): SF_WORKER_INDEX is not set.
   */
  index?: number;
  store: FactoryStore;
  sandbox: Sandbox;
  runner: AgentRunner;
  broker: ToolBroker;
  scanner: EgressScanner;
  storage: SharedStorage;
  /**
   * Plain completions with no tools: the improve run's one draft call per failure group (design §7). Absent: the
   * improve run asks no model and its groups carry no draft. Compose always passes the `plugins.llm` chain.
   */
  llm?: LLMProvider;
  /**
   * Whether the secret store holds the model credential the agent runner reads (design §5 Restarts, setup state):
   * presence only, never the value. Asked before each claim; false: no agent run is claimed and the store-wide
   * `model_credential` claim pause is set, true: it is ended. Compose sets it when every selected runner reads one;
   * absent: the runner needs none, and the tick ends a pause left in effect.
   */
  modelCredential?: () => Promise<boolean>;
  clock: Clock;
  config: FactoryConfig;
  prompts: Prompts;
  log: Logger;
  /** Non-secret env for the worker's own git commands inside the sandbox (PATH etc.). */
  toolEnv: Readonly<Record<string, string>>;
  /**
   * The host's CPU count (compose: `os.availableParallelism()`). Set: each run's agent and check commands get
   * SF_TEST_WORKERS, this run's share of it (testWorkerShare): the CPUs over the runs running on this host at its
   * claim (`hostRuns`), at least half for a merge-check run, kept for the run. Absent: SF_TEST_WORKERS is not set.
   */
  cpus?: number;
  /**
   * The runs running on this host now, this one included: the pool's busy slots plus the busy slots of the other
   * live worker processes on the host (their store rows). Read once at each claim. Absent (a lone Worker): 1.
   */
  hostRuns?: () => Promise<number>;
  /** Held while a claimed run executes, released after; never held while idle. */
  awake: KeepAwake;
  /**
   * Finds docs for the prompt's index section (design §7). Absent, or no results: no section, so the
   * prompt is exactly as without it. Finding a doc never changes tools, paths or grants.
   */
  capability?: CapabilitySearch;
  /**
   * The packs' rules and learnings (design 07-self-improvement.md), put before the doc index in every agent
   * prompt. Absent, nothing to read, or a failed read (a warning): no section.
   */
  guidance?: GuidanceSource;
  /** The learned settings layer (StoredLearnedSettings, src/core/learned-settings.ts), written by the daily improve run. Absent: none. */
  learned?: LearnedSettingsSource;
  /**
   * Model class per run kind and tier (`model_by`) and the model name per class (`models`), from
   * factory.config.json (design §4). Absent: the default table, and outcomes record the model name as null.
   */
  models?: { table: ModelTable; names?: ModelNames };
  /**
   * One golden replay of the review cases with `prompt` as the reviewer's system prompt, for the improve run's entity
   * proposals (design 07-improve-report). Built in the composition root (src/golden-replay.ts), so the improve run kind
   * imports neither golden.ts nor the runtime. Absent: the improve run proposes nothing.
   */
  reviewReplay?: ReviewReplay;
  /**
   * The improve run's skill improvement (design 07-self-improvement): the skill_improve keys, the skill folders, the
   * scratch run and SKILL.md I/O, built in the composition root (src/skill-evals.ts). Absent (capabilities.skill_folders
   * not set): the improve run drafts no skill and asks no question.
   */
  skillImprove?: SkillImproveWiring | undefined;
  /**
   * The owner's tacit ledger as the skill hand-off reads it (design 07-self-improvement): the plugin the worker's live
   * holder last built. Absent or off: a proposed skill draft stays in the store only.
   */
  tacit?: TacitHandOff;
  /**
   * The live settings (design 2026-11-03): refreshed before each claim and each lease renewal. A run reads the
   * values it started with, so a diff, timeout or model change applies at the next run. Absent: `config` and
   * `models`, fixed.
   */
  settings?: LiveSettings;
  /** Whether this loop may claim now. The pool's slot check: false once `workers` drops below this slot. */
  active?: () => boolean;
  /**
   * The host this worker runs on (compose: the state dir's stable host id), recorded on a paused run so only a
   * worker on the same host reattaches its folder and session (design §5 Pause), and naming its runs' git
   * destination (`git:<host>:<branch>`). Absent: the part of `id` before its first `:` (`<host>:<pid>:<n>`).
   */
  host?: string;
  /**
   * The local broker and a local-mode sandbox, for local items when `broker` and `sandbox` serve the forge (design
   * 05-sources, Local items). Compose always sets it. Absent: `broker` and `sandbox` serve every item.
   */
  local?: LocalRoute;
  /**
   * The revision this process runs, stamped on each run it executes (`worker_runs.code_version`): a run journaled by
   * another revision is resumed only by code that can resume it (RFC 0015 §8). Absent: `dev`.
   */
  code_version?: string;
  /**
   * The forge's PR `pr` as a comment target (`Forge.prRef`, a pure function: the worker writes nothing to the forge).
   * A run's PR comment is a thread entry on it, which outbound delivers (RFC 0015 M7). Absent (no forge): the
   * comment goes to the item's own source, as the controller's PR comments do.
   */
  prRef?: (pr: number) => SourceRef;
  /**
   * `<state_dir>/run-deps` (compose): the run-side install cache a run folder's `repo.install_command` step clones
   * node_modules from (src/worker/install-cache.ts, design 05-sandbox.md). Absent: every such step runs the install command.
   */
  install_cache?: string;
  /**
   * Runs `cmd` on the host, outside any sandbox, with no shell (compose: runProcess): the restart run's
   * `repo.restart_command` in the repo's base checkout (design 04-gate-commands, restart). It rejects when the
   * command cannot start. Absent: a restart run fails with `no_host_exec`.
   */
  host_exec?: (cmd: readonly string[], opts: { cwd: string; env: Readonly<Record<string, string>>; timeout_ms: number; signal: AbortSignal }) => Promise<ExecResult>;
}

/** The paused_by of an agent run requeued because its runner found no model credential (design §5 Restarts, setup state). */
export const SETUP_MISSING_PAUSED_BY = "system:setup_missing";
const CREDENTIAL_MISSING_LOG = "model credential missing: no agent run starts until one is added (run: npm run setup)";

/**
 * The run kinds a worker's tick may claim (design §5 Restarts, setup state). With no model credential: none that runs
 * an agent (MODEL_RUN_KINDS), and the store-wide `model_credential` claim pause is set, logged once by the worker whose
 * write started it. With one, or with no check (the runner reads none): every kind, and a pause in effect is ended.
 */
export async function claimableKinds(d: Pick<WorkerDeps, "id" | "store" | "log" | "modelCredential">, kinds: readonly RunKind[]): Promise<RunKind[]> {
  if (d.modelCredential && !(await d.modelCredential())) {
    if ((await d.store.pauseClaims(MODEL_CREDENTIAL_UNTIL, MODEL_CREDENTIAL)).started) d.log.warn(CREDENTIAL_MISSING_LOG, { worker_id: d.id });
    return kinds.filter((k) => !isModelRunKind(k));
  }
  if ((await d.store.getClaimPause(MODEL_CREDENTIAL)) !== null && (await d.store.endClaimPause(MODEL_CREDENTIAL)).ended) {
    d.log.info("model credential found: agent runs start again", { worker_id: d.id });
  }
  return [...kinds];
}

/**
 * An agent run whose runner found no model credential after its claim (a race with the check above): starts the
 * `model_credential` pause and puts the run back in the queue with its attempt unchanged, as the network pause does.
 * No outcome is stored, so it is never retried and never counts toward a limit or an alarm. Only with a check wired
 * (`modelCredential`), which then holds the run until the credential exists; without one the failure is stored.
 */
export async function requeueForCredential(d: Pick<WorkerDeps, "store" | "log">, run: Run, token: number, log: LogFields): Promise<void> {
  if ((await d.store.pauseClaims(MODEL_CREDENTIAL_UNTIL, MODEL_CREDENTIAL)).started) d.log.warn(CREDENTIAL_MISSING_LOG, log);
  const r = await d.store.pauseRun(run.id, token, { paused_by: SETUP_MISSING_PAUSED_BY, session_id: null, resume: null });
  if (r.ok) d.log.info("run requeued: model credential missing", { ...log, error_code: SETUP_MISSING });
  else d.log.warn("lease lost before the run was requeued; nothing stored", log);
}
