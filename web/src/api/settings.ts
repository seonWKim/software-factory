// The Settings page: GET /api/v1/settings, GET /api/v1/settings/capabilities and POST /api/v1/settings (postSettings).

import { t } from "../i18n/index.js";
import { postJson } from "./client.js";
import type { AutoStop } from "./overview.js";
import { API } from "./routes.js";

/** One settable key on the Settings page. Values are JSON text, as `factory settings set` takes them. */
export interface SettingRow {
  key: string;
  /** What the key controls, from the settings core module. */
  description: string;
  /** `text`: free text, shown as plain text and sent back as a JSON string. `list`: a list of strings, edited item by item and sent back as a JSON array. */
  kind: "number" | "boolean" | "models" | "json" | "mode" | "text" | "list";
  value: string;
  source: "override" | "file" | "default";
  file_value: string | null;
  default_value: string;
  applies_at: string;
  project_settable: boolean;
  projects: { project: string; value: string; source: "override" | "file" }[];
  /** workers only: the file's max_workers, and the cap when the stored value is above it. */
  max?: number;
  capped_at?: number | null;
}

/** `/api/v1/settings`. */
export interface SettingsView {
  as_of: string;
  /** Sent back in x-csrf-token on every write; a reload fetches a new one after a restart. */
  csrf_token: string;
  /** The configured repo's owner/name: the `project` a per-project write names. */
  repo: string;
  /** Its stored label; null: none stored, so per-project writes go through `factory settings`. */
  project: string | null;
  project_keys: string[];
  keys: SettingRow[];
  pr_only: { key: string; description: string }[];
  /** The typed form of the file-only keys (design 08-settings); null or absent: this server has no file writer. */
  file_keys?: FileKeysView | null;
  /** Each integration (design 08-settings): the plugin in force, and whether the `integrations` setting or the config chose it. Absent: none. */
  integrations?: IntegrationRow[];
  ignored: { key: string; project: string | null; value: string; reason: string }[];
  history: { seq: number; at: string; actor: string; key: string; project: string | null; old_value: string | null; new_value: string | null }[];
  /** The auto-mode stop still in force, which the Mode toggle shows; null or absent: none. */
  auto_stop?: AutoStop | null;
}

/**
 * One entry of the capability list (design 08-settings, 2026-11-15): a skill, a tool or a provider entry; the Settings
 * page shows the provider entries. `id` names it (`runner:claude-code`); `last_used` is the newest stored run that used it, null when none did.
 */
export interface CapabilityRow {
  kind: "skill" | "tool" | "provider";
  id: string;
  name: string;
  /** A skill's folder, a tool's description, a provider's endpoint host; null when there is none. */
  detail: string | null;
  enabled: boolean;
  roles: string[];
  last_used: string | null;
  read_only?: boolean;
  /** A provider entry's model per class: the names `model_by` picks between. */
  models?: { class: string; model: string }[];
}

/** `/api/v1/settings/capabilities`. */
export interface CapabilitiesView {
  as_of: string;
  /** The roles a tool may be granted to (the `tool_grants` keys). */
  roles: string[];
  capabilities: CapabilityRow[];
}

/** One integration interface on the Settings page. `configured`: the plugin factory.config.json selects. */
export interface IntegrationRow {
  kind: string;
  interface: string;
  plugin: string;
  source: "setting" | "config";
  configured: string;
}

/** One key's value in factory.config.json as the server loaded it: JSON text, null when the file leaves it out. */
export interface FileKeyValue {
  key: string;
  value: string | null;
}

/** `file_keys` of `/api/v1/settings`: what the Settings page's typed form edits and shows. */
export interface FileKeysView {
  /** The file-only keys the page edits, each saved through the file writer onto a local branch. */
  editable: FileKeyValue[];
  /** The keys shown with their value and no control. */
  read_only: FileKeyValue[];
  /** Each interface under `plugins`: its registered plugin names, whether it is a guard, and the plugin in force. */
  plugins: { kind: string; interface: string; guard: boolean; names: string[]; selected: string | null }[];
}

export type SettingsWrite =
  | { action: "set"; key: string; value: string; project?: string }
  | { action: "reset"; key: string; project?: string }
  | { action: "edit-file"; key: string; value: string; confirm: boolean }
  | { action: "project-label"; value: string };

/** The answer to a write: the CLI's lines (an edit-file also with its filed item and branch), or its refusal. */
export type WriteResult = { ok: true; lines: string[]; filed?: { item: string; branch: string } } | { ok: false; error: string };

/** POST /api/v1/settings: a set, reset, edit-file or project-label, with the CSRF token. A refusal comes back as `{ ok: false, error }`. */
export async function postSettings(token: string, body: SettingsWrite): Promise<WriteResult> {
  const r = await postJson<{ ok?: boolean; lines?: string[]; error?: string; item?: string; branch?: string }>(API.settings, token, body);
  if (r.ok && r.value.ok) {
    const { item, branch } = r.value;
    return { ok: true, lines: r.value.lines ?? [], ...(item !== undefined && branch !== undefined ? { filed: { item, branch } } : {}) };
  }
  return { ok: false, error: r.value.error ?? t("api.http", { status: r.status }) };
}
