// The Settings page's API (design §8 and §9, issue #236): GET /api/v1/settings reads every settable key with its
// description, effective value, source, file value, project values and "applies at", the PR-only keys with their
// descriptions and the last 50 audit rows; POST /api/v1/settings sets or resets one key. Every write goes through runSettings (src/settings-cmd.ts),
// the same function `factory settings` runs, so the page accepts and refuses exactly what the CLI does.
//
// The UI process has no forge client and no forge credential: `--project` finds the configured repo's project
// key from the stored project label (storeProjectResolver), and a write for a repo with no stored label is
// refused with a pointer to `factory settings`. Project labels, actor IDs, values and messages leave through the
// Withholder, as on the other routes. The request guards (Host, Origin, Content-Type, CSRF token) run in
// server.ts before writeSettings is reached.

import { randomBytes, timingSafeEqual } from "node:crypto";
import { type ProjectRef, rekeyProjectSettings } from "../core/project.js";
import { readProjectLabel, readStoredProject } from "../core/project-labels.js";
import {
  PROJECT_SETTABLE_KEYS, PR_ONLY_DESCRIPTIONS, PR_ONLY_KEYS, SETTABLE_DEFAULTS, SETTABLE_KEYS, SETTING_APPLIES, SETTING_DESCRIPTIONS, type SettableKey,
  type GlobalSettableKey, type SettableValues, type SettingsBase, type SettingSource,
  effectiveSetting, isProjectSettableKey, resolveSettings,
} from "../core/settings.js";
import type { FactoryStore } from "../interfaces/factory-store.js";
import { type SettingsAction, type SettingsDeps, runSettings } from "../settings-cmd.js";
import type { UiDeps } from "./pages.js";
import { Withholder } from "./withhold.js";

export const SETTINGS_PATH = "/api/v1/settings";
/** The header the page sends the per-process token in. */
export const CSRF_HEADER = "x-csrf-token";
/** The rows `settings history` shows by default. */
export const SETTINGS_HISTORY = 50;
/** Work items read to find the configured repo's project key from a stored label. */
const PROJECT_SCAN = 500;

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

type Kind = "number" | "boolean" | "models" | "model_by";
const kindOf = (k: SettableKey): Kind =>
  k === "phases_auto_approve" ? "boolean" : k === "models" ? "models" : k === "model_by" ? "model_by" : "number";

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

  const keys = [];
  for (const k of SETTABLE_KEYS) {
    const e = effectiveSetting(r, k);
    const file = isProjectSettableKey(k) ? s.base.layers.defaults[k] : s.base.file[k];
    const projects = [];
    if (isProjectSettableKey(k)) {
      for (const [p, own] of Object.entries(r.projects)) {
        const v = own[k];
        if (v) projects.push({ project: await text(label(p)), value: await text(fmt(v.value)), source: v.source });
      }
    }
    keys.push({
      key: k,
      description: await text(SETTING_DESCRIPTIONS[k]),
      kind: kindOf(k),
      value: await text(fmt(r.global[k].raw)),
      source: e.source,
      file_value: file === undefined ? null : await text(fmt(file)),
      default_value: fmt(SETTABLE_DEFAULTS[k]),
      applies_at: SETTING_APPLIES[k],
      project_settable: isProjectSettableKey(k),
      projects,
      ...(k === "workers" ? { max: r.workers_cap, capped_at: r.values.workers < r.global.workers.value ? r.workers_cap : null } : {}),
    });
  }
  const prOnly = [];
  for (const key of PR_ONLY_KEYS) prOnly.push({ key, note: "changes by PR only", description: await text(PR_ONLY_DESCRIPTIONS[key]) });
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
    ignored,
    history,
  };
}

export type SettingsWrite = { action: "set"; key: string; value: string; project?: string } | { action: "reset"; key: string; project?: string };

/** The POST body, or why it is not one. */
export function parseWrite(body: unknown): SettingsWrite | { error: string } {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return { error: "the body must be a JSON object" };
  const b = body as Record<string, unknown>;
  const allowed = new Set(["action", "key", "value", "project"]);
  const extra = Object.keys(b).find((k) => !allowed.has(k));
  if (extra) return { error: `unknown field "${extra}"` };
  if (typeof b.key !== "string" || b.key === "") return { error: "key must be a non-empty string" };
  if (b.project !== undefined && typeof b.project !== "string") return { error: "project must be a string (owner/name)" };
  const project = typeof b.project === "string" ? { project: b.project } : {};
  if (b.action === "set") {
    if (typeof b.value !== "string") return { error: "value must be JSON text, as `factory settings set` takes it" };
    return { action: "set", key: b.key, value: b.value, ...project };
  }
  if (b.action === "reset") {
    if (b.value !== undefined) return { error: "reset takes no value" };
    return { action: "reset", key: b.key, ...project };
  }
  return { error: 'action must be "set" or "reset"' };
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
 * POST /api/v1/settings, after the request guards: 200 with the CLI's lines, 422 with the CLI's refusal in
 * `error` (nothing stored), 400 for a body that is not a set or reset.
 */
export async function writeSettings(d: UiDeps, s: UiSettings, body: unknown): Promise<{ status: number; value: unknown }> {
  const w = new Withholder(d.scanner);
  const text = async (v: string) => (await w.plain(v)).text;
  const parsed = parseWrite(body);
  if ("error" in parsed) return { status: 400, value: { error: parsed.error } };
  const deps: SettingsDeps = {
    store: d.store,
    base: s.base,
    repo: s.repo,
    actor: s.actor,
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
  return r.ok ? { status: 200, value: { ok: true, lines } } : { status: 422, value: { error: lines.join("\n") } };
}
