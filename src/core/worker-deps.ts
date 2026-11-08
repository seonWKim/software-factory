// The worker's dependencies, run routing and the trusted git env, shared by the worker (src/worker/) and legacy
// code (core/session.ts, compose). Legacy on purpose: WorkerDeps still hands the worker an injected Clock (the time
// its tick generators wait on, run timestamps), which src/worker/ may not import (no-clock). They move into the
// worker as those waits move onto its ticks and the session's pushes and PR writes go to outbound (RFC 0015 M6/M7).

import { LOCAL_SOURCE, threadDelivery } from "./local-merge.js";

export { threadDelivery };
import type { FactoryConfig, Prompts } from "./config.js";
import { type LearnedSettingsSource, LiveSettings } from "./settings.js";
import type { ModelNames, ModelTable } from "./model-choice.js";
import type { Logger } from "./log.js";
import type { SourceRef, WorkItem, WorkerId } from "./types.js";
import type { AgentRunner } from "../interfaces/agent-runner.js";
import type { CapabilitySearch } from "../interfaces/capability-search.js";
import type { Clock } from "../interfaces/clock.js";
import type { EgressScanner } from "../interfaces/egress-scanner.js";
import type { FactoryStore } from "../interfaces/factory-store.js";
import type { KeepAwake } from "../interfaces/keep-awake.js";
import type { LLMProvider } from "../interfaces/llm-provider.js";
import type { Sandbox } from "../interfaces/sandbox.js";
import type { SharedStorage } from "../interfaces/shared-storage.js";
import type { TestDatabase } from "../interfaces/test-database.js";
import type { RunPassportIssuer, ToolBroker } from "../interfaces/tool-broker.js";

/** Where a local item's runs go: the local broker (no remote, no PR) and a sandbox on the local base branch. */
export interface LocalRoute {
  broker: ToolBroker;
  sandbox: Sandbox;
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

export function firstLine(s: string): string {
  return s.split("\n")[0] ?? s;
}

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
  clock: Clock;
  config: FactoryConfig;
  prompts: Prompts;
  log: Logger;
  /** Non-secret env for the worker's own git commands inside the sandbox (PATH etc.). */
  toolEnv: Readonly<Record<string, string>>;
  /**
   * The host's CPU count (compose: `os.availableParallelism()`). Set: each run's agent and check commands get
   * SF_TEST_WORKERS, this run's share of it (testWorkerShare). Absent: SF_TEST_WORKERS is not set.
   */
  cpus?: number;
  /** Held while a claimed run executes, released after; never held while idle. */
  awake: KeepAwake;
  /**
   * Finds docs for the prompt's index section (design §7). Absent, or no results: no section, so the
   * prompt is exactly as without it. Finding a doc never changes tools, paths or grants.
   */
  capability?: CapabilitySearch;
  /** The learned settings layer (src/core/settings.ts). Absent: no learned values; none are written yet. */
  learned?: LearnedSettingsSource;
  /**
   * Model class per run kind and tier (`model_by`) and the model name per class (`models`), from
   * factory.config.json (design §4). Absent: the default table, and outcomes record the model name as null.
   */
  models?: { table: ModelTable; names?: ModelNames };
  /**
   * The pre-push checks' throwaway database (design §4): one per run, made the first time a check runs and
   * dropped when the run ends. Its env reaches only the check commands. Absent: no database and no skip line.
   */
  testDatabase?: TestDatabase;
  /**
   * The live settings (design 2026-11-03): refreshed before each claim and each lease renewal. A run reads the
   * values it started with, so a diff, timeout or model change applies at the next run. Absent: `config` and
   * `models`, fixed.
   */
  settings?: LiveSettings;
  /** Whether this loop may claim now. The pool's slot check: false once `workers` drops below this slot. */
  active?: () => boolean;
  /**
   * The host this worker runs on, recorded on a paused run so only a worker on the same host reattaches its
   * folder and session (design §5 Pause). Absent: the part of `id` before its first `:` (`<host>:<pid>:<n>`).
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
}
