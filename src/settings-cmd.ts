// `factory settings`: change a settable key while the factory runs (design 2026-11-03, "Settings change at
// runtime"). Every check goes through resolveSettings, the same function the running controller and worker pool
// read settings through, so a value this command accepts is a value they use. A refused command writes nothing.

import { type ProjectRef, rekeyProjectSettings } from "./core/project.js";
import { readProjectLabel } from "./core/project-labels.js";
import {
  PROJECT_SETTABLE_KEYS,
  SETTABLE_KEYS,
  SETTING_APPLIES,
  type SettableKey,
  type SettingsBase,
  effectiveSetting,
  isProjectSettableKey,
  keyRefusal,
  parseSettable,
  resolveSettings,
  workersCap,
} from "./core/settings.js";
import type { FactoryStore, SettingOverride } from "./interfaces/factory-store.js";

export const SETTINGS_USAGE = `usage: npm run factory -- settings <action>
  list                                        every settable key: its effective value and source (override, file, default)
  set <key> <value> [--project <owner/name>]  stores an override; <value> is JSON (2, '{"cheap":"haiku",...}')
  reset <key> [--project <owner/name>]        removes an override; the file value (else the default) applies again
  history [--limit <n>]                       audit rows of every set and reset, newest first (default 50)
--project: only for ${PROJECT_SETTABLE_KEYS.join(", ")}, and only with the configured repo's owner/name.`;

export type SettingsAction =
  | { action: "list" }
  | { action: "set"; key: string; value: string; project?: string }
  | { action: "reset"; key: string; project?: string }
  | { action: "history"; limit: number };

const DEFAULT_HISTORY = 50;

/** The action, or an error to print with the usage. */
export function parseSettingsArgs(args: readonly string[]): SettingsAction | { error: string } {
  const [action, ...rest] = args;
  const free: string[] = [];
  const flags: Record<string, string> = {};
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!;
    if (a === "--project" || a === "--limit") {
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
      if (free.length !== 1 || extra(["--project"])) return { error: "reset needs <key>" };
      return { action, key: free[0]!, ...project };
    case "history": {
      const raw = flags["--limit"];
      if (free.length > 0 || extra(["--limit"])) return { error: "history takes only --limit <n>" };
      if (raw !== undefined && !/^[1-9]\d*$/.test(raw)) return { error: "--limit must be a positive integer" };
      return { action, limit: raw === undefined ? DEFAULT_HISTORY : Number(raw) };
    }
    default:
      return { error: action ? `unknown settings action "${action}"` : "settings needs an action" };
  }
}

export interface SettingsDeps {
  store: Pick<FactoryStore, "listSettingOverrides" | "setSettingOverride" | "resetSettingOverride" | "listSettingChanges" | "getCursor">;
  /** The config file's settings (compose.ts settingsBase): project blocks keyed by `owner/name`, as the file writes them. */
  base: SettingsBase;
  /** The configured repo. `--project` must be its `owner/name`. */
  repo: { owner: string; name: string };
  /** The configured repo's key and label. Asked only for `--project` (it may call the forge). */
  resolveProject(): Promise<ProjectRef>;
  /** Who runs the command, as an ID (`local:<OS login>`), never a display name. */
  actor: string;
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
    case "set":
    case "reset":
      return change(deps, a);
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

function fmt(v: unknown): string {
  return JSON.stringify(v) ?? String(v);
}

async function change(deps: SettingsDeps, a: Extract<SettingsAction, { action: "set" | "reset" }>): Promise<SettingsResult> {
  const refused = keyRefusal(a.key);
  if (refused) return fail(refused);
  const key = a.key as SettableKey;
  let ref: ProjectRef | undefined;
  if (a.project !== undefined) {
    if (!isProjectSettableKey(key)) return fail(`--project applies only to ${PROJECT_SETTABLE_KEYS.join(", ")}; ${key} is global`);
    const ownerName = `${deps.repo.owner}/${deps.repo.name}`;
    if (a.project !== ownerName) {
      return fail(`project ${JSON.stringify(a.project)} does not match the configured repo's ID ${JSON.stringify(ownerName)} (repo.owner/repo.name)`);
    }
    ref = await deps.resolveProject();
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
  if (value !== null) {
    await deps.store.setSettingOverride({ key, project, value, actor: deps.actor });
  } else if ((await deps.store.resetSettingOverride({ key, project, actor: deps.actor })) === null) {
    return fail(`${key} has no override${where}; nothing to reset`);
  }
  const now = effectiveSetting(after, key, project);
  return {
    ok: true,
    lines: [
      `${key}${where} = ${fmt(now.raw)} (${now.source}; was ${fmt(was.raw)}, ${was.source})`,
      `applies at ${SETTING_APPLIES[key]}, with no restart`,
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
