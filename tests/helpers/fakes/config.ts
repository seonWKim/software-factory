// Test config, prompts, settings, identities, refs and small test utilities (RFC 0023 R4): no port fake here.
import { type FactoryConfig, type Prompts, RETENTION_DEFAULTS } from "../../../src/core/config.js";
import type { ProjectRef } from "../../../src/core/project.js";
import { type ProjectSettings, type SettingsLayers, settingValues } from "../../../src/core/settings.js";
import type { LogFields, Logger } from "../../../src/core/log.js";
import type { SourceRef, WorkItemId } from "../../../src/core/types.js";
import { PatternEgressScanner } from "../../../src/impl/egress/pattern-egress-scanner.js";
import type { ExternalIdentity } from "../../../src/interfaces/auth-provider.js";
import type { FactoryStore } from "../../../src/interfaces/factory-store.js";

/** The configured repo o/r as startup resolves it: keyed by its (fake) node ID, labelled by its path. */
export const PROJECT: ProjectRef = { key: "github:github.com:R_kgDOrepo1", label: "github.com/o/r" };

/**
 * Stands in for GitHubClient.repoIdentity at startup: every repo resolves to a fixed node ID under its own
 * path, so build() needs no network.
 */
export const fakeRepoLookup = {
  async repoIdentity(repo: { owner: string; name: string }) {
    return { node_id: "R_kgDOfake", owner: repo.owner, name: repo.name, host: "github.com" };
  },
};

export const config: FactoryConfig = {
  project: PROJECT,
  repo: { owner: "o", name: "r", path: "/repo", base_branch: "main", install_command: ["npm", "ci"], test_command: ["npm", "test"] },
  intake_label: "factory",
  status_label_prefix: "sf: ",
  branch_prefix: "factory/",
  dials: { spec_gate_min_tier: 1, auto_merge_max_tier: 0 },
  settings: {
    defaults: { floors: [{ prefix: "src/impl/broker/", tier: 4 }], max_attempts: 3, max_diff_lines: 1500, max_diff_files: 40 },
    projects: {},
  },
  max_loops: 3,
  max_restart: 3,
  retry_base_ms: 60_000,
  retry_max_ms: 1_800_000,
  lease_ms: 60_000,
  heartbeat_ms: 10_000,
  tick_ms: 1000,
  poll_interval_ms: 30_000,
  run_timeout_ms: 600_000,
  retention: RETENTION_DEFAULTS,
  // Tests that are not about batching send each commit at once (`commit`): the `auto` debounce waits on time these
  // tests never advance. Batching has its own tests (tests/outbound/).
  outbound_batching: { "*": { mode: "commit", debounce_ms: 2_000, max_wait_ms: 30_000, max_messages: 10 } },
  merge_queue_depth: 1,
  workers: 1,
  deny_paths: ["/home/u/.config/software-factory"],
  agent_git_identity: { name: "bot", email: "bot@example.com" },
};

/** `base`'s settings with `defaults` changed: for tests that need another global gate value. */
export function settingsWith(changes: Partial<ProjectSettings>, base: FactoryConfig = config): SettingsLayers {
  return { ...base.settings, defaults: { ...base.settings.defaults, ...changes } };
}

/** The gate values a test config gives every project (no project overrides in the fakes). */
export function gates(c: FactoryConfig = config): ProjectSettings {
  return settingValues(c.project.key, c.settings);
}

export const prompts: Prompts = { triage: "TRIAGE", implement: "IMPLEMENT", review: "REVIEW", resolve: "RESOLVE" };

/** The real pattern scanner with no known secret values: blocks token-shaped text only. */
export const cleanScanner = new PatternEgressScanner(async () => []);

export const silent: Logger = { info() {}, warn() {}, error() {} };

export const alice: ExternalIdentity = { provider: "github", subject: "1", login: "alice" };
export const mallory: ExternalIdentity = { provider: "github", subject: "666", login: "mallory" };

export function issueRef(n: number): SourceRef {
  return { type: "github_issue", id: `o/r#${n}`, link: `https://github.com/o/r/issues/${n}` };
}

export function slackRef(n: number): SourceRef {
  return { type: "slack_thread", id: `C1/${n}`, link: `https://slack.example/archives/C1/p${n}` };
}

/** PR `pr` of `owner/repo` as the GitHub forge hands it out (`prRef`): the target of a run's PR comment. */
export function fakePrRef(pr: number, repo = "o/r"): SourceRef {
  return { type: "github_issue", id: `${repo}#${pr}`, link: `https://github.com/${repo}/pull/${pr}` };
}

/**
 * The comments a run handed to outbound for `item` (RFC 0015 M7): its thread entries with a delivery, in order.
 * `number` is the issue or PR number the target names; `pr` whether the target is a PR.
 */
export async function runComments(
  store: Pick<FactoryStore, "listDeliveries">,
  item: WorkItemId,
): Promise<{ number: number | null; pr: boolean; body: string; marker: string; target: SourceRef }[]> {
  return (await store.listDeliveries(item)).map((d) => ({
    number: /#(\d+)$/.test(d.target.id) ? Number(/#(\d+)$/.exec(d.target.id)![1]) : null,
    pr: /\/pull\/\d+$/.test(d.target.link),
    body: d.body,
    marker: d.marker,
    target: d.target,
  }));
}

/**
 * Yields to timers and I/O until `cond` holds (e.g. a background heartbeat landed in the store). Gives up
 * after at least `tries` yields and `ms` of real time, so a slow machine (CI) gets the same chance as a fast one.
 */
export async function waitFor(cond: () => boolean | Promise<boolean>, what = "condition", tries = 200, ms = 5_000): Promise<void> {
  const deadline = Date.now() + ms;
  for (let i = 0; i < tries || Date.now() < deadline; i++) {
    if (await cond()) return;
    await new Promise((r) => setImmediate(r));
  }
  throw new Error(`timed out waiting for ${what}`);
}

/** A Logger that keeps every line, for asserting on warnings. */
export function recordingLog(): Logger & { lines: { level: string; msg: string; fields?: LogFields | undefined }[] } {
  const lines: { level: string; msg: string; fields?: LogFields | undefined }[] = [];
  const at = (level: string) => (msg: string, fields?: LogFields) => void lines.push({ level, msg, fields });
  return { lines, info: at("info"), warn: at("warn"), error: at("error") };
}

export const triageSpec = {
  in_short: "AS-IS: nothing checks the scope.\nTO-BE: CI checks the scope.",
  problem: "Add a CI scope gate",
  done_criteria: ["CI fails when files outside allowed_paths change"],
  // One check per done-when line (design 04-triage, 2026-11-22): a test file, so it holds whatever check commands a test sets.
  done_checks: [{ line: "CI fails when files outside allowed_paths change", test_file: "tests/scope-gate.test.ts" }],
  desired_output: "workflow + test",
  scope: "CI only",
  allowed_paths: [".github/workflows/"],
  files_to_change: [".github/workflows/scope.yml"],
  tier: 2,
  tier_reason: "CI config",
  estimated_lines: 40,
  estimated_files: 2,
};
