// What the controller role is built from (moved out of the legacy controller, RFC 0015 M5): the legacy plugin
// interfaces it is given, and the forge budget it reports. It goes with FactoryStore and the other legacy
// interfaces (M11).

import type { FactoryConfig } from "./config.js";
import type { TickLease } from "./lease.js";
import type { Logger } from "./log.js";
import type { LearnedSettingsSource, LiveSettings } from "./settings.js";
import type { AuthAction, AuthDecision, AuthProvider } from "../interfaces/auth-provider.js";
import type { Clock } from "../interfaces/clock.js";
import type { EgressScanner } from "../interfaces/egress-scanner.js";
import type { FactoryStore } from "../interfaces/factory-store.js";
import type { Forge } from "../interfaces/forge.js";
import type { LLMProvider } from "../interfaces/llm-provider.js";
import type { NetworkProbe } from "../interfaces/network-probe.js";
import type { Sandbox } from "../interfaces/sandbox.js";
import type { SourceAdapter } from "../interfaces/source-adapter.js";
import type { ChildRestart } from "../interfaces/updater.js";

/**
 * The forge's core rate limit as one process sees it (design §5 Sources, call budget): the forge's limit,
 * remaining calls and reset time, this process's `budget_share`, the calls it may count (`share_limit`, null before
 * the forge reported a limit) and its counted calls in the window. `waiting`: no calls left before the reset; `low`:
 * optional reads wait (under `min_remaining`, or the share is used).
 */
export interface GitHubBudgetStatus {
  limit: number;
  remaining: number;
  reset_at: string;
  budget_share: number;
  share_limit: number | null;
  counted: number;
  state: "ok" | "low" | "waiting";
  as_of: string;
}

/** The reset time a call refused for a used-up rate limit waits for (its `wait_until`), else null. */
export function rateLimitWait(err: unknown): string | null {
  const v = err instanceof Error ? (err as { wait_until?: unknown }).wait_until : undefined;
  return typeof v === "string" && v !== "" ? v : null;
}

export interface ControllerDeps {
  store: FactoryStore;
  /**
   * The configured sources (`plugins.source`), at most one per source type (design 2026-11-01). Each item's
   * comments, mark-seen, status and close go to the adapter of its own source type. Give `sources`, or `source`
   * for exactly one.
   */
  sources?: readonly SourceAdapter[];
  /** One source: the same as `sources: [source]`. */
  source?: SourceAdapter;
  /**
   * The forge (`plugins.forge`, issue #273): every PR event and PR fact is read from it, and every PR comment and
   * PR status goes through it, whatever source the item came from. Absent or null: no PR is read or written; a PR
   * comment or status then goes to the item's own source.
   */
  forge?: Forge | null;
  /**
   * Reads change refs (reverts, fix-forwards) when no forge is selected: compose gives the local forge, built through
   * the registry but not selected (docs/plugins/forge.md). Ignored when `forge` is given: the forge reads its own.
   */
  links?: Pick<Forge, "parseLinks">;
  /** Authorizes commands from the forge (and every origin with no plugin of its own). */
  auth: AuthProvider;
  /**
   * Authorizes commands from the local CLI (identity provider `local`) and the local UI (app requests); issue
   * #318: local commands never depend on the forge's auth plugin. Absent: `auth`.
   */
  local_auth?: AuthProvider;
  /** Authorizes commands from Slack threads (identity provider `slack`; issue #486). Absent: `local_auth`, else `auth` (issue #498). */
  slack_auth?: AuthProvider;
  /**
   * The controller's automatic steps (auto mode's spec approvals and merges) authorized under its service passport
   * (RFC 0015 §8, `service:controller`), audited there. Absent (no Identity: tests, a startup check): allowed.
   */
  service_auth?: (action: AuthAction, resource: { project: string; item: string }) => Promise<AuthDecision>;
  /**
   * Outbound's deliveries authorized under its service passport (RFC 0015 §8, `service:outbound`): `use_tool` on
   * each target, audited there. Absent (no Identity: tests, a startup check): allowed, under no passport.
   */
  outbound_auth?: (project: string, target: string) => Promise<{ passport_id: string; decision: AuthDecision }>;
  clock: Clock;
  config: FactoryConfig;
  log: Logger;
  /** G5: the last-attempt comment carries run output, so it is scanned before it is posted. */
  scanner: EgressScanner;
  /** This replica's id, recorded where this replica acts (the sync lease is the role's, src/runtime/roles). */
  replica_id?: string;
  /**
   * This machine's git host (design 10-event-driven, Git destinations): `id` (the state dir's `host-id`) names the
   * factory repo writes this controller records (`git:<id>:…`); `flush_all`: it flushes every host's git destinations
   * (a SQLite store: one machine), else only its own id's. Absent (tests, one process): id `local`, every host's.
   */
  git_host?: { readonly id: string; readonly flush_all: boolean };
  /**
   * Suggests a command for a plain-language comment (design §4). Absent: plain comments get no reply. The
   * controller's state decisions never use it.
   */
  llm?: LLMProvider;
  /**
   * The network pause's probe (design §5 Restarts). Absent: nothing can be asked, so the pause ends at its first
   * probe time, as a stall pause does with no LLM provider.
   */
  network_probe?: NetworkProbe;
  /** The learned settings layer (StoredLearnedSettings, src/core/learned-settings.ts), written by the daily improve run. Absent: none. */
  learned?: LearnedSettingsSource;
  /**
   * The live settings (design 2026-11-03): refreshed at the start of each tick and of each public tick step, so
   * a retry, attempt or loop change applies at the next decision and a poll, tick or lease change at the next
   * tick. Absent: `config`, fixed.
   */
  settings?: LiveSettings;
  /**
   * The repeated-failure rule (issue #167, design 05-restarts): two task failures in a row in one step with the
   * same code and detail line block the item with `repeated_failure`. Absent or true: on. False: off, and the step
   * retries up to max_attempts.
   */
  repeated_failure_rule?: boolean;
  /**
   * The sandbox the worker pool uses (design §5 Merge check): the controller only fetches through it and runs
   * its read-only merge check. Absent, or without fetchBranch and mergeCheck: no local merge check.
   */
  sandbox?: Sandbox;
  /**
   * The supervisor's restart list on this host (design 05-alarms), read by the alarm step each poll. Absent: no
   * restart alarm (in-place or none updater, or a test).
   */
  restarts?: () => Promise<readonly ChildRestart[]>;
  /**
   * The sync lease (design 05-coordination), shared with inbound, which polls under it: only its holder delivers
   * the synced type's outbox rows. Absent or null: nothing is leased.
   */
  sync?: TickLease | null;
  /**
   * Reads the shared forge budget (`forge_budget`) into the forge client, at most once per tick (design 05-sources,
   * call budget), so every replica's optional reads see the last response any replica got. Called before each
   * tick's optional reads. Absent: the client's own responses only.
   */
  refresh_forge_budget?: () => Promise<void>;
  /**
   * The environment the red-main check runs the install command and the checks in on the base tip after an automatic
   * merge (design 03-risk), as the worker's checks get it. Absent: an empty environment.
   */
  check_env?: Readonly<Record<string, string>>;
}
