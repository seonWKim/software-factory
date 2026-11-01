// Known keys per factory.config.json level. loadConfig checks them right after the JSON parse, so a typo
// ("plugin" for "plugins", "hots" for "host") fails at load instead of silently falling back to a default.
// Only unknown keys are checked here; value and shape checks stay where they were.

import type { FileConfig } from "./compose.js";
import { PROJECT_SETTING_KEYS } from "./core/settings.js";
import { VERDICT_SEVERITIES } from "./core/verdict.js";

export const TOP_LEVEL_KEYS = [
  "env",
  "store",
  "repo",
  "intake_label",
  "status_label_prefix",
  "branch_prefix",
  "dials",
  "floors",
  "auth",
  "plugins",
  "models",
  "max_loops",
  "max_attempts",
  "max_restart",
  "retry_base_ms",
  "retry_max_ms",
  "max_diff_lines",
  "max_diff_files",
  "lease_ms",
  "heartbeat_ms",
  "tick_ms",
  "poll_interval_ms",
  "run_timeout_ms",
  "workers",
  "state_dir",
  "worktrees_dir",
  "agent_git_identity",
  "ui",
  "stats",
  "budgets",
  "budget_min_sample",
  "inbox_retention_days",
  "defaults",
  "projects",
] as const satisfies readonly (keyof FileConfig)[];

// Fails typecheck when FileConfig gains a key that is not listed above.
type MissingTopLevel = Exclude<keyof FileConfig, (typeof TOP_LEVEL_KEYS)[number]>;
const _allTopLevelListed: [MissingTopLevel] extends [never] ? true : false = true;
void _allTopLevelListed;

/** Store keys per store.type. A type not listed here (an invalid one) skips the store key check. */
export const STORE_KEYS: Readonly<Record<string, readonly string[]>> = {
  sqlite: ["type"],
  mysql: ["type", "host", "port", "database", "user"],
};

export const REPO_KEYS = ["owner", "name", "path", "base_branch", "install_command", "test_command"] as const satisfies readonly (keyof FileConfig["repo"])[];
export const DIALS_KEYS = ["spec_gate_min_tier", "auto_merge_max_tier"] as const satisfies readonly (keyof FileConfig["dials"])[];
export const FLOOR_KEYS = ["prefix", "tier"] as const satisfies readonly (keyof NonNullable<FileConfig["floors"]>[number])[];
export const MODELS_KEYS = ["cheap", "strong"] as const satisfies readonly (keyof FileConfig["models"])[];
export const AGENT_GIT_IDENTITY_KEYS = ["name", "email"] as const satisfies readonly (keyof FileConfig["agent_git_identity"])[];
export const UI_KEYS = ["port"] as const satisfies readonly (keyof NonNullable<FileConfig["ui"]>)[];
export const STATS_KEYS = ["weights", "min_sample"] as const satisfies readonly (keyof NonNullable<FileConfig["stats"]>)[];

/** A suggestion is offered only within this edit distance. */
export const SUGGEST_MAX_DISTANCE = 2;

/** Levenshtein edit distance (insert, delete, substitute; each costs 1). */
export function editDistance(a: string, b: string): number {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[b.length]!;
}

/** The valid key closest to `key` if it is within SUGGEST_MAX_DISTANCE; ties go to the earlier key. */
export function closestKey(key: string, valid: readonly string[]): string | undefined {
  let best: string | undefined;
  let bestDistance = SUGGEST_MAX_DISTANCE + 1;
  for (const v of valid) {
    const d = editDistance(key, v);
    if (d < bestDistance) {
      best = v;
      bestDistance = d;
    }
  }
  return best;
}

/** `; did you mean "x"?` when a valid key is close, else "". */
export function suggestion(key: string, valid: readonly string[]): string {
  const best = closestKey(key, valid);
  return best === undefined ? "" : `; did you mean ${JSON.stringify(best)}?`;
}

/** Every unknown config key, one message per key. `message` is the messages joined by newlines. */
export class ConfigKeyError extends Error {
  constructor(readonly problems: readonly string[]) {
    super(problems.join("\n"));
    this.name = "ConfigKeyError";
  }
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Every unknown key at every level of a parsed factory.config.json, as messages. Values that are not
 * objects where an object belongs are skipped: shape errors are reported by the later checks. `plugins`
 * keys are checked by selectPlugins (src/plugins.ts).
 */
export function unknownConfigKeys(raw: unknown): string[] {
  if (!isObject(raw)) return [];
  const problems: string[] = [];
  const check = (obj: unknown, path: string, what: string, valid: readonly string[]) => {
    if (!isObject(obj)) return;
    for (const key of Object.keys(obj)) {
      if (valid.includes(key)) continue;
      const at = path === "" ? key : `${path}.${key}`;
      problems.push(`unknown config key "${key}" at ${at}; valid ${what} keys: ${valid.join(", ")}${suggestion(key, valid)}`);
    }
  };
  check(raw, "", "top-level", TOP_LEVEL_KEYS);
  const store = raw.store;
  if (isObject(store) && typeof store.type === "string" && Object.hasOwn(STORE_KEYS, store.type)) {
    check(store, "store", `store (type "${store.type}")`, STORE_KEYS[store.type]!);
  }
  // Each floors entry, wherever floors may be set: top level, `defaults`, a project block.
  const checkFloorEntries = (block: unknown, path: string) => {
    if (!isObject(block) || !Array.isArray(block.floors)) return;
    block.floors.forEach((f, i) => check(f, `${path}floors[${i}]`, "floors entry", FLOOR_KEYS));
  };
  check(raw.repo, "repo", "repo", REPO_KEYS);
  check(raw.dials, "dials", "dials", DIALS_KEYS);
  checkFloorEntries(raw, "");
  check(raw.models, "models", "models", MODELS_KEYS);
  check(raw.agent_git_identity, "agent_git_identity", "agent_git_identity", AGENT_GIT_IDENTITY_KEYS);
  check(raw.ui, "ui", "ui", UI_KEYS);
  check(raw.stats, "stats", "stats", STATS_KEYS);
  if (isObject(raw.stats)) check(raw.stats.weights, "stats.weights", "stats.weights", VERDICT_SEVERITIES);
  // Per-project settings (design 2026-11-01): `defaults` and each project block take only the per-project
  // keys. Anything else in a project (dials, plugins, repo, budget_min_sample, a guard) is an unknown key.
  check(raw.defaults, "defaults", "defaults", PROJECT_SETTING_KEYS);
  checkFloorEntries(raw.defaults, "defaults.");
  if (isObject(raw.projects)) {
    for (const [id, block] of Object.entries(raw.projects)) {
      const at = `projects[${JSON.stringify(id)}]`;
      check(block, at, `project ${JSON.stringify(id)}`, PROJECT_SETTING_KEYS);
      checkFloorEntries(block, `${at}.`);
    }
  }
  return problems;
}

/** Throws one ConfigKeyError listing every unknown key, or returns. */
export function checkConfigKeys(raw: unknown): void {
  const problems = unknownConfigKeys(raw);
  if (problems.length > 0) throw new ConfigKeyError(problems);
}

/** What `factory doctor` prints when the config does not load: one FAIL line per problem, no stack. */
export function configFailLines(err: unknown): string[] {
  const problems =
    err instanceof ConfigKeyError ? err.problems : [err instanceof Error ? err.message : String(err)];
  return problems.map((p) => `FAIL  ${p}`);
}
