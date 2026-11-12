// `factory settings`: change a settable key while the factory runs (design 2026-11-03, "Settings change at
// runtime"). Every check goes through resolveSettings, the same function the running controller and worker pool
// read settings through, so a value this command accepts is a value they use. A refused command writes nothing.

import { NOT_OWNER, NOT_OWNER_REPLY } from "./interfaces/auth-provider.js";
import { COMMAND_TABLE, cliUsageOf, topWords } from "./core/command-table.js";
import { type ProjectRef, rekeyProjectSettings } from "./core/project.js";
import { readProjectLabel } from "./core/project-labels.js";
import {
  APPROVE_MERGE_KEYS,
  GATE_SETTABLE_KEYS,
  type GateSettableKey,
  MODES,
  OWNER_KEYS,
  PROJECT_SETTABLE_KEYS,
  SETTABLE_KEYS,
  type SettableKey,
  type SettingsBase,
  effectiveSetting,
  isProjectSettableKey,
  keyRefusal,
  loosening,
  parseSettable,
  resolveSettings,
  settingsFor,
  workersCap,
} from "./core/settings.js";
import { learnedFromRows } from "./core/learned-settings.js";
import type { ConfigEditRequest, ConfigEditResult } from "./core/config-writer.js";
import type { EgressScanner } from "./interfaces/egress-scanner.js";
import type { FactoryStore, SettingOverride } from "./interfaces/factory-store.js";
import { loadSettingCatalog } from "./runtime/index.js";
import { loosens } from "./shared/setting.js";

const SETTINGS_COMMANDS = COMMAND_TABLE.filter((c) => c.name.startsWith("settings "));
const MODE_COMMAND = COMMAND_TABLE.find((c) => c.name === "mode")!;

/** The words `factory` hands to the settings handler: `settings` and `mode`, from the command table. */
export const SETTINGS_TOP_WORDS = topWords(["settings"]);

/** `settings edit-file` (design 08-settings): outside the command table, which SET_UP.md mirrors. */
const EDIT_FILE_USAGE = "edit-file <key> <json> [--confirm]";

export const SETTINGS_USAGE = `usage: npm run factory -- settings <action>
${SETTINGS_COMMANDS.map((c) => `  ${cliUsageOf(c).slice("settings ".length).padEnd(42)}  ${c.does}`).join("\n")}
--project: only for ${PROJECT_SETTABLE_KEYS.join(", ")}, and only with the configured repo's owner/name.
${APPROVE_MERGE_KEYS.join(" and ")}, and a set or reset that loosens a tighten-only key: only with approve_merge on the project.
reset <key> --project <owner/name> --learned: clear the value the improve run learned; only with approve_merge when that loosens the value in force.
  ${EDIT_FILE_USAGE.padEnd(42)}  Set one file-only key of factory.config.json on a new local branch, filed for your \`factory merge <id>\`; a guard, floor or permission needs --confirm`;

export const MODE_USAGE = `usage: npm run factory -- ${cliUsageOf(MODE_COMMAND)}
  ${MODE_COMMAND.does}: needs approve_merge on the project, and writes one audit row`;

/** `factory mode <auto|manual> [--project <owner/name>]`: the `settings set mode` action, or an error to print with the usage. */
export function parseModeArgs(args: readonly string[]): SettingsAction | { error: string } {
  const [mode, ...rest] = args;
  if (!(MODES as readonly (string | undefined)[]).includes(mode)) return { error: `mode needs ${MODES.join(" or ")}` };
  const parsed = parseSettingsArgs(["set", "mode", JSON.stringify(mode), ...rest]);
  return "error" in parsed ? { error: parsed.error.replace(/^set needs <key> <value>$/, "mode takes only --project <owner/name>") } : parsed;
}

export type SettingsAction =
  | { action: "list" }
  | { action: "set"; key: string; value: string; project?: string }
  | { action: "reset"; key: string; project?: string; learned?: true }
  | { action: "history"; limit: number }
  | ({ action: "edit-file" } & ConfigEditRequest);

const DEFAULT_HISTORY = 50;

/** Free-text keys that reach a model's prompt: a set runs the egress scanner on the value and refuses a hit (design 04-agents). */
const SCANNED_KEYS: readonly SettableKey[] = ["message_style"];

/** The action, or an error to print with the usage. */
export function parseSettingsArgs(args: readonly string[]): SettingsAction | { error: string } {
  const [action, ...rest] = args;
  const free: string[] = [];
  const flags: Record<string, string> = {};
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!;
    if (a === "--learned" || a === "--confirm") flags[a] = "";
    else if (a === "--project" || a === "--limit") {
      const v = rest[i + 1];
      if (v === undefined) return { error: `${a} needs a value` };
      flags[a] = v;
      i++;
    } else free.push(a);
  }
  const project = flags["--project"] !== undefined ? { project: flags["--project"] } : {};
  const extra = (allowed: string[]) => Object.keys(flags).find((f) => !allowed.includes(f));
  switch (action) {
    case "list":
      if (free.length > 0 || extra([])) return { error: "list takes no arguments" };
      return { action };
    case "set": {
      if (free.length !== 2 || extra(["--project"])) return { error: "set needs <key> <value>" };
      return { action, key: free[0]!, value: free[1]!, ...project };
    }
    case "reset":
      if (free.length !== 1 || extra(["--project", "--learned"])) return { error: "reset needs <key>" };
      if (flags["--learned"] === undefined) return { action, key: free[0]!, ...project };
      if (flags["--project"] === undefined) return { error: "reset --learned needs --project <owner/name>: a learned value is per project" };
      return { action, key: free[0]!, ...project, learned: true };
    case "history": {
      const raw = flags["--limit"];
      if (free.length > 0 || extra(["--limit"])) return { error: "history takes only --limit <n>" };
      if (raw !== undefined && !/^[1-9]\d*$/.test(raw)) return { error: "--limit must be a positive integer" };
      return { action, limit: raw === undefined ? DEFAULT_HISTORY : Number(raw) };
    }
    case "edit-file":
      if (free.length !== 2 || extra(["--confirm"])) return { error: `edit-file needs <key> <json> [--confirm]` };
      return { action, key: free[0]!, value: free[1]!, confirm: flags["--confirm"] !== undefined };
    default:
      return { error: action ? `unknown settings action "${action}"` : "settings needs an action" };
  }
}

export interface SettingsDeps {
  store: Pick<FactoryStore, "listSettingOverrides" | "setSettingOverride" | "resetSettingOverride" | "listSettingChanges" | "getCursor" | "getLearnedSetting" | "resetLearnedSetting">;
  /** The config file's settings (compose.ts settingsBase): project blocks keyed by `owner/name`, as the file writes them. */
  base: SettingsBase;
  /** The configured repo. `--project` must be its `owner/name`. */
  repo: { owner: string; name: string };
  /** The configured repo's key and label. Asked only for `--project` (it may call the forge). */
  resolveProject(): Promise<ProjectRef>;
  /** Who runs the command, as an ID (`local:<OS login>`), never a display name. */
  actor: string;
  /**
   * Whether `actor` holds `approve_merge` on the configured project (design 08-settings): asked before a set or reset
   * of `mode` or `auto_merge_max_tier`, before one that loosens a tighten-only key, and before a learned reset that loosens the value in force; the refusal, or null. Solo: the local owner holds it with no setup. Absent: no check.
   */
  mayApproveMerge?(): Promise<string | null>;
  /** Whether `actor` is the owner, asked before a set or reset of an owner-only key (OWNER_KEYS, `integrations`); the refusal, or null. Absent: no check. */
  mayOwn?(): Promise<string | null>;
  /**
   * The configured egress scanner (G5): a set of a free-text key that reaches a model's prompt (SCANNED_SETTABLE_KEYS,
   * `message_style`) is refused when it flags the value. Absent: such a set is refused, never stored unscanned.
   */
  scanner?: EgressScanner;
  /** The file-only key writer (compose.ts configWriter), the one the Settings write route runs too. Absent: edit-file is refused. */
  editFile?(r: ConfigEditRequest): Promise<ConfigEditResult>;
}

export interface SettingsResult {
  ok: boolean;
  lines: string[];
}

const fail = (reason: string): SettingsResult => ({ ok: false, lines: [`refused: ${reason}`] });

export async function runSettings(deps: SettingsDeps, a: SettingsAction): Promise<SettingsResult> {
  switch (a.action) {
    case "list":
      return list(deps);
    case "history":
      return history(deps, a.limit);
    case "edit-file":
      return editFile(deps, a);
    case "set":
    case "reset":
      return a.action === "reset" && a.learned ? resetLearned(deps, a.key, a.project!) : change(deps, a);
  }
}

/**
 * The base with the file's project block re-keyed to the project key, so it lines up with stored project
 * overrides, and a label per project for messages. The key comes from `ref` when `--project` resolved it, else
 * from the stored label of a project override that names the configured repo. Never asks the forge.
 */
async function aligned(deps: SettingsDeps, rows: readonly SettingOverride[], ref?: ProjectRef) {
  const ownerName = `${deps.repo.owner}/${deps.repo.name}`;
  const labels = new Map<string, string>();
  if (ref) labels.set(ref.key, ref.label);
  for (const p of new Set(rows.map((r) => r.project).filter((p) => p !== ""))) {
    if (!labels.has(p)) labels.set(p, await readProjectLabel(deps.store, p));
  }
  const key = ref?.key ?? [...labels].find(([, l]) => l.endsWith(`/${ownerName}`))?.[0];
  const base: SettingsBase = key ? { ...deps.base, layers: { ...deps.base.layers, projects: rekeyProjectSettings(deps.base.layers.projects, ownerName, key) } } : deps.base;
  const label = (p: string) => labels.get(p) ?? p;
  return { base, label };
}

/** The refusal's note when the user is not the owner (design 08-permissions, issue #575). */
const notOwnerNote = (refused: string): string => (refused === NOT_OWNER ? `: ${NOT_OWNER_REPLY}` : "");

function fmt(v: unknown): string {
  return JSON.stringify(v) ?? String(v);
}

async function change(deps: SettingsDeps, a: Extract<SettingsAction, { action: "set" | "reset" }>): Promise<SettingsResult> {
  const refused = keyRefusal(a.key);
  if (refused) return fail(refused);
  const key = a.key as SettableKey;
  if (OWNER_KEYS.includes(key) && deps.mayOwn) {
    const refused = await deps.mayOwn();
    if (refused !== null) return fail(`${key} changes only by the owner: ${refused}`);
  }
  if (APPROVE_MERGE_KEYS.includes(key) && deps.mayApproveMerge) {
    const refused = await deps.mayApproveMerge();
    if (refused !== null) return fail(`${key} changes only with approve_merge on the project: ${refused}${notOwnerNote(refused)}`);
  }
  let ref: ProjectRef | undefined;
  if (a.project !== undefined) {
    if (!isProjectSettableKey(key)) return fail(`--project applies only to ${PROJECT_SETTABLE_KEYS.join(", ")}; ${key} is global`);
    const resolved = await projectRef(deps, a.project);
    if ("ok" in resolved) return resolved;
    ref = resolved;
  }
  const project = ref?.key ?? "";

  let value: string | null = null;
  if (a.action === "set") {
    let raw: unknown;
    try {
      raw = JSON.parse(a.value);
    } catch {
      raw = a.value;
    }
    let parsed: unknown;
    try {
      parsed = parseSettable(key, raw);
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err));
    }
    value = JSON.stringify(raw);
    if (SCANNED_KEYS.includes(key)) {
      const refused = await scanRefusal(deps.scanner, key, String(parsed));
      if (refused) return fail(refused);
    }
    if (key === "notify_channels") {
      const refused = await unknownChannel(parsed as string[]);
      if (refused) return fail(refused);
    }
    if (key === "integrations") {
      const refused = await integrationRefusal(parsed);
      if (refused) return fail(refused);
    }
    if (key === "workers") {
      const cap = workersCap(deps.base);
      if ((parsed as number) > cap) {
        return fail(
          `workers ${String(parsed)} is above the config file's max_workers (${cap}), which sizes this process's worker index block; raise max_workers in factory.config.json by PR`,
        );
      }
    }
  }

  const rows = await deps.store.listSettingOverrides();
  const { base, label } = await aligned(deps, rows, ref);
  const current = rows.find((r) => r.key === key && r.project === project);
  const where = project ? ` for ${label(project)}` : "";
  if (a.action === "reset" && !current) return fail(`${key} has no override${where}; nothing to reset`);
  const others = rows.filter((r) => r !== current);
  const next = value === null ? others : [...others, { key, project, value }];
  const before = resolveSettings(base, rows, label);
  const after = resolveSettings(base, next, label);
  const same = (x: { key: string; project: string; value: string; reason: string }, y: typeof x) =>
    x.key === y.key && x.project === y.project && x.value === y.value && x.reason === y.reason;
  const newly = after.ignored.filter((i) => !before.ignored.some((b) => same(b, i)));
  if (newly.length > 0) return fail(newly[0]!.reason);

  const was = effectiveSetting(before, key, project);
  const now = effectiveSetting(after, key, project);
  // Loosening a tighten-only key (a higher max_diff_lines, phases_auto_approve true) needs the same grant as mode;
  // tightening needs none (design 08-settings, 2026-11-09).
  if (!APPROVE_MERGE_KEYS.includes(key) && deps.mayApproveMerge) {
    const descriptor = (await loadSettingCatalog()).get(key);
    if (descriptor && loosens(descriptor, now.value, was.value) !== null) {
      const refused = await deps.mayApproveMerge();
      if (refused !== null) return fail(`loosening ${key}${where} from ${fmt(was.raw)} to ${fmt(now.raw)} needs approve_merge on the project: ${refused}${notOwnerNote(refused)}`);
    }
  }
  if (value !== null) {
    await deps.store.setSettingOverride({ key, project, value, actor: deps.actor });
  } else if ((await deps.store.resetSettingOverride({ key, project, actor: deps.actor })) === null) {
    return fail(`${key} has no override${where}; nothing to reset`);
  }
  return {
    ok: true,
    lines: [
      `${key}${where} = ${fmt(now.raw)} (${now.source}; was ${fmt(was.raw)}, ${was.source})`,
      `applies at ${(await loadSettingCatalog()).describe(key).applies}, with no restart`,
    ],
  };
}

/**
 * `notify_channels` names source plugins (design 12-notification-channels): a name the plugin registry does not hold
 * is refused here, where the registry is read, since the core reads none. Imported when asked: the registry loads
 * every plugin, and the slack plugin imports this file.
 */
async function unknownChannel(names: readonly string[]): Promise<string | null> {
  const known = Object.keys((await import("./plugins.js")).REGISTRY.source.plugins);
  const bad = names.find((n) => !known.includes(n));
  return bad === undefined ? null : `notify_channels names "${bad}", which is not a source plugin; the source plugins are ${known.join(", ")}`;
}

/**
 * `integrations` names interfaces and plugins (design 08-settings): only an interface marked `integration`, never a
 * guard, and only a plugin registered for it. Imported when asked, as for unknownChannel.
 */
async function integrationRefusal(value: unknown): Promise<string | null> {
  const { REGISTRY, checkIntegrations } = await import("./plugins.js");
  try {
    checkIntegrations(REGISTRY, value);
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

/** Why the egress scanner refuses `value` for `key`, naming the rules and never the text; null when it is clean. */
async function scanRefusal(scanner: EgressScanner | undefined, key: string, value: string): Promise<string | null> {
  if (!scanner) return `${key} is checked by the egress scanner before it is stored, and none is configured here; nothing stored`;
  const scan = await scanner.scan("log", value);
  if (scan.clean) return null;
  const rules = [...new Set(scan.findings.map((f) => f.rule))].join(", ");
  return `${key} was flagged by the egress scanner (${rules}); it reaches model prompts, so nothing was stored`;
}

/** The configured repo's ProjectRef for `--project`, or the refusal when it names another repo. */
async function projectRef(deps: SettingsDeps, project: string): Promise<ProjectRef | SettingsResult> {
  const ownerName = `${deps.repo.owner}/${deps.repo.name}`;
  if (project !== ownerName) {
    return fail(`project ${JSON.stringify(project)} does not match the configured repo's ID ${JSON.stringify(ownerName)} (repo.owner/repo.name)`);
  }
  return deps.resolveProject();
}

/**
 * `settings reset <key> --project <owner/name> --learned` (design 08-settings): clears the value the daily improve run
 * learned. The one check for the CLI and the Settings page (its POST runs this function): a reset that loosens the
 * value in force (the learned value is in force and the layer below it is looser) needs approve_merge; a refusal
 * writes nothing. One audit row.
 */
async function resetLearned(deps: SettingsDeps, key: string, project: string): Promise<SettingsResult> {
  if (!(GATE_SETTABLE_KEYS as readonly string[]).includes(key)) return fail(`--learned applies only to ${GATE_SETTABLE_KEYS.join(", ")}`);
  const gate = key as GateSettableKey;
  const ref = await projectRef(deps, project);
  if ("ok" in ref) return ref;
  const stored = await deps.store.getLearnedSetting(ref.key, gate);
  if (!stored) return fail(`${key} has no learned value for ${ref.label}; nothing to reset`);
  const rows = await deps.store.listSettingOverrides();
  const { base, label } = await aligned(deps, rows, ref);
  const layers = resolveSettings(base, rows, label).layers;
  const was = settingsFor(ref.key, layers, learnedFromRows([stored]))[gate];
  const now = settingsFor(ref.key, layers)[gate];
  if (was.layer === "learned" && loosening(gate, now.value, was.value) !== null && deps.mayApproveMerge) {
    const refused = await deps.mayApproveMerge();
    if (refused !== null) {
      return fail(`resetting the learned ${key} for ${ref.label} loosens it from ${was.value} to ${now.value} and needs approve_merge on the project: ${refused}${notOwnerNote(refused)}`);
    }
  }
  const change = await deps.store.resetLearnedSetting({ key, project: ref.key, actor: deps.actor });
  if (!change) return fail(`${key} has no learned value for ${ref.label}; nothing to reset`);
  return { ok: true, lines: [`${key} for ${ref.label}: learned value ${change.old_value ?? ""} cleared; ${now.value} (${now.layer}) applies`] };
}

/** `settings edit-file <key> <json> [--confirm]`: the file-only key writer; a refusal writes nothing. */
async function editFile(deps: SettingsDeps, r: ConfigEditRequest): Promise<SettingsResult> {
  if (!deps.editFile) return fail("this process has no file-only key writer");
  const e = await deps.editFile({ key: r.key, value: r.value, confirm: r.confirm });
  if (!e.ok) return fail(e.refusal);
  return {
    ok: true,
    lines: [
      `${r.key} = ${e.new_value} (was ${e.old_value ?? "not set"}) on the local branch ${e.branch} as ${e.sha.slice(0, 12)}, filed as ${e.item}`,
      `the file changes once you merge it: factory merge ${e.item}`,
    ],
  };
}

async function list(deps: SettingsDeps): Promise<SettingsResult> {
  const rows = await deps.store.listSettingOverrides();
  const { base, label } = await aligned(deps, rows);
  const r = resolveSettings(base, rows, label);
  const width = Math.max(...SETTABLE_KEYS.map((k) => k.length));
  const lines: string[] = [];
  for (const k of SETTABLE_KEYS) {
    const e = r.global[k];
    const capped = k === "workers" && r.values.workers < r.global.workers.value ? ` (capped at max_workers ${r.workers_cap})` : "";
    lines.push(`${k.padEnd(width)}  ${e.source.padEnd(8)}  ${fmt(e.raw)}${capped}`);
  }
  for (const [p, keys] of Object.entries(r.projects)) {
    lines.push(`project ${label(p)}:`);
    for (const k of PROJECT_SETTABLE_KEYS) {
      const own = keys[k];
      if (own) lines.push(`  ${k.padEnd(width)}  ${own.source.padEnd(8)}  ${fmt(own.value)}`);
    }
  }
  for (const i of r.ignored) lines.push(`ignored override ${i.key}${i.project ? ` for ${label(i.project)}` : ""} = ${i.value}: ${i.reason}`);
  return { ok: true, lines };
}

async function history(deps: SettingsDeps, limit: number): Promise<SettingsResult> {
  const rows = await deps.store.listSettingChanges(limit);
  if (rows.length === 0) return { ok: true, lines: ["no settings changes yet"] };
  const labels = new Map<string, string>();
  for (const p of new Set(rows.map((r) => r.project).filter((p) => p !== ""))) labels.set(p, await readProjectLabel(deps.store, p));
  return {
    ok: true,
    lines: rows.map((c) => {
      const where = c.project ? ` for ${labels.get(c.project) ?? c.project}` : "";
      const what = c.new_value === null ? `reset (was ${c.old_value})` : `${c.old_value ?? "(no override)"} → ${c.new_value}`;
      return `${c.at}  ${c.actor}  ${c.key}${where}  ${what}`;
    }),
  };
}
