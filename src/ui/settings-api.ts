// The Settings page's API (design §8 and §9, issue #236): GET /api/v1/settings reads every settable key with its
// description, effective value, source, file value, project values, learned values (each resolved through settingsFor,
// with its evidence run IDs and set time) and "applies at", the PR-only keys with their
// descriptions and the last 50 audit rows; POST /api/v1/settings sets or resets one key, or (`"action": "edit-file"`)
// sets one file-only key of factory.config.json on a new local branch (design 08-settings). Every write goes through runSettings (src/settings-cmd.ts),
// the same function `factory settings` runs, so the page accepts and refuses exactly what the CLI does. GET also carries
// `file_keys` for the page's typed form: each file-only key's value in the file as loaded, the read-only keys' values,
// and each `plugins` interface with its registered plugin names; an edit-file answer names the filed item and its branch.
//
// The UI process has no forge client and no forge credential: `--project` finds the configured repo's project
// key from the stored project label (storeProjectResolver), and a write for a repo with no stored label is
// refused with a pointer to `factory settings`. Project labels, actor IDs, values and messages leave through the
// Withholder, as on the other routes. The request guards (Host, Origin, Content-Type, CSRF token) run in
// server.ts before writeSettings is reached. A set or reset of an owner-only key (`integrations`) then needs the page's
// user to be the local owner (rules-api.ts ownerOf); with no owner check wired it is refused. GET lists each
// integration (design 08-settings, 2026-11-12) with the plugin in force and whether a setting or the config chose it.

import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { basename, isAbsolute, join, relative, sep } from "node:path";
import type { Loaded } from "../compose.js";
import { checkConfigKeys, configFailLines } from "../config-keys.js";
import { type LearnedSetting, learnedFromRows } from "../core/learned-settings.js";
import { type ProjectRef, rekeyProjectSettings } from "../core/project.js";
import { readProjectLabel, readStoredProject } from "../core/project-labels.js";
import {
  PROJECT_SETTABLE_KEYS, PR_ONLY_KEYS, SETTABLE_DEFAULTS, SETTABLE_KEYS, type SettableKey,
  type GlobalSettableKey, type LearnedSettingsSource, type SettableValues, type SettingsBase, type SettingSource,
  effectiveSetting, isGateSettableKey, isProjectSettableKey, resolveSettings, settingsFor,
} from "../core/settings.js";
import type { RunId, Timestamp, UserId, WorkItemId } from "../core/types.js";
import { ConfigFileChangesSql } from "../impl/store/sql/config-file-changes.js";
import { storeSql } from "../impl/store/sql/store-sql.js";
import type { FactoryStore } from "../interfaces/factory-store.js";
import type { Sandbox } from "../interfaces/sandbox.js";
import { loadSettingCatalog } from "../runtime/index.js";
import { type ConfigEditRequest, type ConfigEditResult, FILE_ONLY_KEYS, editConfigFile } from "../core/config-writer.js";
import { type SettingsAction, type SettingsDeps, runSettings } from "../settings-cmd.js";
import type { UiDeps } from "./pages.js";
import type { PauseDeps } from "./pause-api.js";
import { ownerOf } from "./rules-api.js";
import { Withholder } from "./withhold.js";

export const SETTINGS_PATH = "/api/v1/settings";
/** The header the page sends the per-process token in. */
export const CSRF_HEADER = "x-csrf-token";
/** The rows `settings history` shows by default. */
export const SETTINGS_HISTORY = 50;
/** Work items read to find the configured repo's project key from a stored label. */
const PROJECT_SCAN = 500;
/** Learned audit rows read to find each learned value's evidence: far more than the per-project keys a daily run writes. */
const LEARNED_SCAN = 500;

/** What the Settings routes need beside the store. Built once per UI process (compose.ts buildUiParts). */
export interface UiSettings {
  /** The config file's settings, project blocks keyed by `owner/name` (compose.ts settingsBase). */
  base: SettingsBase;
  /** The configured repo; a project write must name its `owner/name`. */
  repo: { owner: string; name: string };
  /** Who writes from this page, as an ID (`local:<OS login>`), never a display name. */
  actor: string;
  /** The configured repo's key and label from the store only, or null when no label is stored. Never asks the forge. */
  resolveProject(): Promise<ProjectRef | null>;
  /** Random, per process; held only in memory. GET returns it, POST must send it in x-csrf-token. */
  csrfToken: string;
  /** The `approve_merge` check for `mode`, `auto_merge_max_tier` and a loosening change (SettingsDeps.mayApproveMerge). Absent: no check. */
  mayApproveMerge?: () => Promise<string | null>;
  /** Each integration interface (src/plugins.ts INTEGRATION_KINDS) and the plugin factory.config.json selects for it. Absent: none listed. */
  integrations?: readonly { kind: string; interface: string; configured: string }[];
  /**
   * The file-only key writer `factory settings edit-file` runs (compose.ts configWriter). Absent: an edit-file write is
   * refused. Its `fileKeys` feeds the page's typed form; a writer without it shows no form.
   */
  editFile?: ((r: ConfigEditRequest) => Promise<ConfigEditResult>) & Partial<Pick<ConfigFileWriter, "fileKeys">>;
}

/**
 * The keys the Settings page shows with their value and no write control (design 08-settings, owner list): each
 * moves state, binds at start, or is too free-form for one control. `factory.config.json` is the way to change them.
 */
export const READ_ONLY_FILE_KEYS = ["store", "env", "state_dir", "worktrees_dir", "ui", "outbound.batching", "cli_user"] as const;

/** One key's value in the file as loaded: JSON text, null when the file leaves it out. */
export interface FileKeyValue {
  key: string;
  value: string | null;
}

/** What the Settings page's typed form reads (design 08-settings). */
export interface FileKeysView {
  /** Each file-only key the page edits, in the writer's order. */
  editable: FileKeyValue[];
  /** READ_ONLY_FILE_KEYS, in order. */
  read_only: FileKeyValue[];
  /** Each interface selected under `plugins`: its registered plugin names, whether it is a guard, and the plugin in force. */
  plugins: { kind: string; interface: string; guard: boolean; names: string[]; selected: string | null }[];
}

/** The file-only key writer, and what its typed form on the Settings page reads. */
export type ConfigFileWriter = ((r: ConfigEditRequest) => Promise<ConfigEditResult>) & { fileKeys(): FileKeysView };

const isReadOnlyFileKey = (key: string): boolean => (READ_ONLY_FILE_KEYS as readonly string[]).includes(key);

/** The guards' own `plugins.<kind>` keys: the page edits them through the plugins list. */
const GUARD_MEMBER = /^plugins\./;

function fileValue(file: unknown, key: string): string | null {
  let v: unknown = file;
  for (const k of key.split(".")) v = typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>)[k] : undefined;
  return v === undefined ? null : JSON.stringify(v);
}

/** The typed form's view of the loaded config: the file's values and the registry's plugin names. */
export function fileKeysOf(loaded: Pick<Loaded, "file" | "registry" | "plugins">): FileKeysView {
  const of = (key: string): FileKeyValue => ({ key, value: fileValue(loaded.file, key) });
  const selection = loaded.plugins as unknown as Record<string, unknown>;
  return {
    editable: FILE_ONLY_KEYS.filter((k) => !isReadOnlyFileKey(k) && !GUARD_MEMBER.test(k)).map(of),
    read_only: READ_ONLY_FILE_KEYS.map(of),
    plugins: Object.values(loaded.registry)
      .filter((e) => e.configKey.startsWith("plugins."))
      .map((e) => {
        const kind = e.configKey.slice("plugins.".length);
        const selected = selection[kind];
        return { kind, interface: e.interface, guard: e.guard, names: Object.keys(e.plugins), selected: typeof selected === "string" ? selected : null };
      }),
  };
}

/** What the file-only key writer is built from: the CLI handler and compose.ts buildUiParts pass the same parts. */
export interface ConfigWriterParts {
  loaded: Pick<Loaded, "root" | "codeRoot" | "configFile" | "externalConfig" | "config" | "file" | "registry" | "plugins">;
  store: FactoryStore;
  sandbox: Sandbox;
  /** The time, ISO (the injected Clock). */
  now(): string;
  /** Who asks, as an ID, never a display name. */
  actor: string;
  /** The configured repo's project key, or null when none is known here. */
  project(): Promise<string | null>;
  /** compose.ts loadConfig: the loader runs on the new text as on the file. */
  loadConfig(root: string, opts: { codeRoot: string; configFile: string | undefined; text: string }): Promise<unknown>;
}

/**
 * The file-only key writer (core/config-writer.ts, design 08-settings) that `factory settings edit-file` and the
 * Settings write route both run: the configured sandbox, the factory repo's local base, the config file's path in
 * that repo (null when it is outside it), the factory's git identity, and the loader's checks (checkConfigKeys, then
 * loadConfig) on the whole new text. Its `fileKeys` reads the file as this process loaded it (fileKeysOf).
 */
export function configWriter(p: ConfigWriterParts): ConfigFileWriter {
  const { repo } = p.loaded.config;
  const rel = relative(repo.path, p.loaded.externalConfig ?? join(p.loaded.root, basename(p.loaded.configFile)));
  const file = rel === "" || rel.startsWith("..") || isAbsolute(rel) ? null : rel.split(sep).join("/");
  const check = async (text: string): Promise<string | null> => {
    try {
      checkConfigKeys(JSON.parse(text));
      await p.loadConfig(p.loaded.root, { codeRoot: p.loaded.codeRoot, configFile: p.loaded.externalConfig ?? undefined, text });
      return null;
    } catch (err) {
      return `the config loader refuses the new file: ${configFailLines(err).map((l) => l.replace(/^FAIL {2}/, "")).join("; ")}`;
    }
  };
  const deps = {
    store: new ConfigFileChangesSql(storeSql(p.store), () => p.now() as Timestamp),
    sandbox: p.sandbox, repo: { path: repo.path, base_branch: repo.base_branch }, file, branch_prefix: p.loaded.config.branch_prefix,
    identity: p.loaded.config.agent_git_identity, actor: p.actor as UserId, project: p.project, check,
    newId: () => `wi_${randomUUID().replaceAll("-", "")}` as WorkItemId,
  };
  const fileKeys = fileKeysOf(p.loaded);
  return Object.assign((r: ConfigEditRequest) => editConfigFile(deps, r), { fileKeys: () => fileKeys });
}

/** A fresh CSRF token: 32 random bytes, base64url. Never stored or written to disk. */
export function newCsrfToken(): string {
  return randomBytes(32).toString("base64url");
}

/** True when `sent` is the process's token (compared in constant time). */
export function csrfMatches(expected: string, sent: string | undefined): boolean {
  if (sent === undefined || sent === "") return false;
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(sent, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * The configured repo's project from the store alone: its stored key (`project_key:<owner>/<name>`, design
 * 2026-11-07); for a store written before that, the project keys of stored overrides and of recent work items,
 * the first whose stored label ends in `/owner/name` (the CLI's own match). Null when none is stored.
 */
export function storeProjectResolver(
  store: Pick<FactoryStore, "getCursor" | "listSettingOverrides" | "listWorkItems">,
  repo: { owner: string; name: string },
): () => Promise<ProjectRef | null> {
  const suffix = `/${repo.owner}/${repo.name}`;
  return async () => {
    const stored = await readStoredProject(store, repo);
    if (stored) return stored;
    const keys = new Set<string>();
    for (const o of await store.listSettingOverrides()) if (o.project !== "") keys.add(o.project);
    for (const it of await store.listWorkItems(PROJECT_SCAN)) keys.add(it.project);
    for (const key of keys) {
      const label = await readProjectLabel(store, key);
      if (label.endsWith(suffix)) return { key, label };
    }
    return null;
  };
}

/** What the CLI prints for a value: JSON text. */
const fmt = (v: unknown): string => JSON.stringify(v) ?? String(v);

/** The base without the Settings wiring: no file values, so overrides and defaults decide. */
const NO_FILE: SettingsBase = { file: {}, layers: { defaults: {}, projects: {} } };

/**
 * A global setting the factory acts on now: file, override or default (`workers` capped at `max_workers`), the same
 * resolve the Settings page reads. Without the Settings wiring the file layer is empty.
 */
export async function effectiveGlobal<K extends GlobalSettableKey>(d: UiDeps, key: K): Promise<{ value: SettableValues[K]; source: SettingSource }> {
  const e = effectiveSetting(resolveSettings(d.settings?.base ?? NO_FILE, await d.store.listSettingOverrides()), key);
  return { value: e.value, source: e.source };
}

/**
 * The stored learned layer with each value's record (design 08-settings): the evidence run IDs of the newest audit
 * row that wrote the stored value, and the time the value was stored. A value with no such row has no evidence.
 */
export async function learnedWithRecords(
  store: Pick<FactoryStore, "listLearnedSettings" | "listLearnedSettingChanges">,
): Promise<{ rows: LearnedSetting[]; source: LearnedSettingsSource }> {
  const rows = await store.listLearnedSettings();
  const changes = rows.length === 0 ? [] : await store.listLearnedSettingChanges(LEARNED_SCAN);
  const records = new Map<string, { evidence_run_ids: RunId[]; set_at: Timestamp }>();
  for (const r of rows) {
    const wrote = changes.find((c) => c.project === r.project && c.key === r.key && c.new_value === r.value);
    records.set(JSON.stringify([r.project, r.key]), { evidence_run_ids: wrote?.evidence_run_ids ?? [], set_at: r.updated_at });
  }
  const view = learnedFromRows(rows);
  return { rows, source: { get: (project, key) => view.get(project, key), record: (project, key) => records.get(JSON.stringify([project, key])) } };
}

/** How the page edits a key. `json`: an object edited as JSON text (`model_by`, `hold_policy`). `text`: free text, sent as a JSON string (`message_style`). */
type Kind = "number" | "boolean" | "models" | "json" | "mode" | "text";
const kindOf = (k: SettableKey): Kind =>
  k === "phases_auto_approve" ? "boolean" : k === "models" ? "models" : k === "model_by" || k === "hold_policy" || k === "integrations" ? "json" : k === "mode" ? "mode" : k === "message_style" ? "text" : "number";

/** GET /api/v1/settings. */
export async function readSettings(d: UiDeps, s: UiSettings) {
  const w = new Withholder(d.scanner);
  const text = async (v: string) => (await w.plain(v)).text;
  const ownerName = `${s.repo.owner}/${s.repo.name}`;
  const rows = await d.store.listSettingOverrides();
  const ref = await s.resolveProject();
  const labels = new Map<string, string>();
  if (ref) labels.set(ref.key, ref.label);
  for (const p of new Set(rows.map((r) => r.project).filter((p) => p !== ""))) {
    if (!labels.has(p)) labels.set(p, await readProjectLabel(d.store, p));
  }
  const label = (p: string) => labels.get(p) ?? p;
  const base: SettingsBase = ref
    ? { ...s.base, layers: { ...s.base.layers, projects: rekeyProjectSettings(s.base.layers.projects, ownerName, ref.key) } }
    : s.base;
  const r = resolveSettings(base, rows, label);
  const catalog = await loadSettingCatalog();
  const learned = await learnedWithRecords(d.store);
  for (const p of new Set(learned.rows.map((l) => l.project))) {
    if (!labels.has(p)) labels.set(p, await readProjectLabel(d.store, p));
  }

  const keys = [];
  for (const k of SETTABLE_KEYS) {
    const e = effectiveSetting(r, k);
    const file = isGateSettableKey(k) ? s.base.layers.defaults[k] : isProjectSettableKey(k) ? undefined : s.base.file[k];
    const projects = [];
    if (isProjectSettableKey(k)) {
      for (const [p, own] of Object.entries(r.projects)) {
        const v = own[k];
        if (v) projects.push({ project: await text(label(p)), value: await text(fmt(v.value)), source: v.source });
      }
    }
    // Each stored learned value, with the layer settingsFor resolves for its project: "learned" while it is in force.
    const learnedValues = [];
    if (isGateSettableKey(k)) {
      for (const l of learned.rows.filter((l) => l.key === k)) {
        const v = learned.source.get(l.project, k);
        if (v === undefined) continue;
        const rec = learned.source.record?.(l.project, k);
        learnedValues.push({
          project: await text(label(l.project)),
          value: await text(fmt(v)),
          source: settingsFor(l.project, r.layers, learned.source)[k].layer,
          evidence_run_ids: rec?.evidence_run_ids ?? [],
          set_at: rec?.set_at ?? l.updated_at,
        });
      }
    }
    keys.push({
      key: k,
      description: await text(catalog.describe(k).description),
      kind: kindOf(k),
      value: await text(fmt(r.global[k].raw)),
      source: e.source,
      file_value: file === undefined ? null : await text(fmt(file)),
      default_value: fmt(SETTABLE_DEFAULTS[k]),
      applies_at: catalog.describe(k).applies,
      project_settable: isProjectSettableKey(k),
      projects,
      learned: learnedValues,
      ...(k === "workers" ? { max: r.workers_cap, capped_at: r.values.workers < r.global.workers.value ? r.workers_cap : null } : {}),
    });
  }
  const prOnly = [];
  for (const key of PR_ONLY_KEYS) prOnly.push({ key, description: await text(catalog.describe(key).description) });
  // Each integration: the entry's plugin when one is stored, else the config's (design 08-settings).
  const integrations = (s.integrations ?? []).map((i) => {
    const set = r.values.integrations[i.kind];
    return { kind: i.kind, interface: i.interface, plugin: set ?? i.configured, source: set === undefined ? "config" : "setting", configured: i.configured };
  });
  const fileKeys = s.editFile?.fileKeys?.();
  const withheld = async (list: FileKeyValue[]) => {
    const out = [];
    for (const f of list) out.push({ key: f.key, value: f.value === null ? null : await text(f.value) });
    return out;
  };
  const file_keys = fileKeys ? { ...fileKeys, editable: await withheld(fileKeys.editable), read_only: await withheld(fileKeys.read_only) } : null;
  const ignored = [];
  for (const i of r.ignored) {
    ignored.push({ key: i.key, project: i.project ? await text(label(i.project)) : null, value: await text(i.value), reason: await text(i.reason) });
  }

  const changes = await d.store.listSettingChanges(SETTINGS_HISTORY);
  for (const p of new Set(changes.map((c) => c.project).filter((p) => p !== ""))) {
    if (!labels.has(p)) labels.set(p, await readProjectLabel(d.store, p));
  }
  const history = [];
  for (const c of changes) {
    history.push({
      seq: c.seq,
      at: c.at,
      actor: await text(c.actor),
      key: c.key,
      project: c.project ? await text(label(c.project)) : null,
      old_value: c.old_value === null ? null : await text(c.old_value),
      new_value: c.new_value === null ? null : await text(c.new_value),
    });
  }

  return {
    as_of: d.clock.now().toISOString(),
    csrf_token: s.csrfToken,
    repo: ownerName,
    /** The configured repo's stored label; null: no label stored, so project writes go through `factory settings`. */
    project: ref ? await text(ref.label) : null,
    project_keys: PROJECT_SETTABLE_KEYS,
    keys,
    pr_only: prOnly,
    /** The typed form of the file-only keys (design 08-settings); null: this process has no file writer. */
    file_keys,
    integrations,
    ignored,
    history,
  };
}

export type SettingsWrite =
  | { action: "set"; key: string; value: string; project?: string }
  | { action: "reset"; key: string; project?: string; learned?: true }
  | ({ action: "edit-file" } & ConfigEditRequest);

/** The POST body, or why it is not one. */
export function parseWrite(body: unknown): SettingsWrite | { error: string } {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return { error: "the body must be a JSON object" };
  const b = body as Record<string, unknown>;
  const allowed = new Set(["action", "key", "value", "project", "learned", "confirm"]);
  const extra = Object.keys(b).find((k) => !allowed.has(k));
  if (extra) return { error: `unknown field "${extra}"` };
  if (typeof b.key !== "string" || b.key === "") return { error: "key must be a non-empty string" };
  if (b.project !== undefined && typeof b.project !== "string") return { error: "project must be a string (owner/name)" };
  const project = typeof b.project === "string" ? { project: b.project } : {};
  if (b.learned !== undefined && (b.learned !== true || b.action !== "reset")) return { error: "learned is only true, and only on a reset" };
  if (b.confirm !== undefined && (typeof b.confirm !== "boolean" || b.action !== "edit-file")) return { error: "confirm is only true or false, and only on an edit-file" };
  if (b.action === "edit-file") {
    if (typeof b.value !== "string") return { error: "value must be JSON text, as `factory settings edit-file` takes it" };
    if (b.project !== undefined) return { error: "edit-file takes no project: the file is global" };
    return { action: "edit-file", key: b.key, value: b.value, confirm: b.confirm === true };
  }
  if (b.action === "set") {
    if (typeof b.value !== "string") return { error: "value must be JSON text, as `factory settings set` takes it" };
    return { action: "set", key: b.key, value: b.value, ...project };
  }
  if (b.action === "reset") {
    if (b.value !== undefined) return { error: "reset takes no value" };
    if (b.learned !== true) return { action: "reset", key: b.key, ...project };
    // The CLI's own refusal (parseSettingsArgs): a learned value is per project.
    if (b.project === undefined) return { error: "reset --learned needs --project <owner/name>: a learned value is per project" };
    return { action: "reset", key: b.key, ...project, learned: true };
  }
  return { error: 'action must be "set", "reset" or "edit-file"' };
}

class NoStoredProject extends Error {}

/** The refusal for a project write the page cannot place without asking the forge. */
export function noLabelMessage(repo: { owner: string; name: string }): string {
  const ownerName = `${repo.owner}/${repo.name}`;
  return (
    `refused: no project label is stored for ${ownerName} yet, so this page cannot find its project key without asking the forge; ` +
    `use npm run factory -- settings set <key> <value> --project ${ownerName} on the command line`
  );
}

/**
 * POST /api/v1/settings, after the request guards: 200 with the CLI's lines (an edit-file also with the filed item
 * and its branch, for the page's Merge button), 422 with the CLI's refusal in `error` (nothing stored), 400 for a
 * body that is not a set, reset or edit-file.
 */
export async function writeSettings(d: PauseDeps, s: UiSettings, body: unknown): Promise<{ status: number; value: unknown }> {
  const w = new Withholder(d.scanner);
  const text = async (v: string) => (await w.plain(v)).text;
  const parsed = parseWrite(body);
  if ("error" in parsed) return { status: 400, value: { error: parsed.error } };
  let filed: { item: string; branch: string } | null = null;
  const editFile = s.editFile;
  const deps: SettingsDeps = {
    store: d.store,
    base: s.base,
    repo: s.repo,
    actor: s.actor,
    // The same scanner the page's reads withhold through: a flagged message_style is refused, as on the CLI.
    scanner: d.scanner,
    ...(s.mayApproveMerge ? { mayApproveMerge: s.mayApproveMerge } : {}),
    ...(editFile
      ? {
          editFile: async (req: ConfigEditRequest) => {
            const e = await editFile(req);
            if (e.ok) filed = { item: e.item, branch: e.branch };
            return e;
          },
        }
      : {}),
    // An owner-only key needs the local owner; a page with no owner check refuses it.
    mayOwn: async () => {
      if (!d.pauses) return "this page has no owner check";
      const who = await ownerOf(d, d.pauses, "changes this key");
      return "error" in who ? who.error : null;
    },
    resolveProject: async () => {
      let ref: ProjectRef | null;
      try {
        ref = await s.resolveProject();
      } catch {
        ref = null;
      }
      if (!ref) throw new NoStoredProject();
      return ref;
    },
  };
  let r;
  try {
    r = await runSettings(deps, parsed as SettingsAction);
  } catch (err) {
    if (err instanceof NoStoredProject) return { status: 422, value: { error: noLabelMessage(s.repo) } };
    throw err;
  }
  const lines = [];
  for (const l of r.lines) lines.push(await text(l));
  return r.ok ? { status: 200, value: { ok: true, lines, ...(filed ?? {}) } } : { status: 422, value: { error: lines.join("\n") } };
}
