// The shared choices `factory setup` writes to factory.config.json (owner decision 2026-11-08): which sync
// plugins (GitHub, Slack) are on. Pure: it reads and returns the file's text, and changes only the top-level keys
// a choice touches, leaving every other line as it was written.

import { type Json, type JsonObject as Obj, formatValue, isJsonObject as isObj } from "../../../core/config-text.js";

/** The layout-keeping text edit lives in core, beside the file-only key writer that shares it. */
export { editConfigText } from "../../../core/config-text.js";

/** What setup asks for the whole team. Per-person choices (the display name) never go to the file. */
export interface SharedChoices {
  github: boolean;
  slack: boolean;
  /** Slack channel IDs (`C…`, `G…`); read only when `slack` is on. */
  slack_channels: readonly string[];
}

const SLACK_CHANNEL = /^[CG][A-Z0-9]{2,}$/;

/** The channel IDs in `raw` (comma or space separated), or the first one that is not an ID. */
export function parseSlackChannels(raw: string): { ok: true; channels: string[] } | { ok: false; bad: string } {
  const channels = raw.split(/[\s,]+/).filter((c) => c !== "");
  const bad = channels.find((c) => !SLACK_CHANNEL.test(c));
  return bad === undefined ? { ok: true, channels } : { ok: false, bad };
}

/**
 * The choices as the file stands: each step's default. `githubSelected` is the loaded config's answer (any GitHub
 * plugin selected). A file that lists no sources yet gets the solo defaults: local only, no Slack.
 */
export function currentChoices(raw: Obj, githubSelected: boolean): SharedChoices {
  const plugins = isObj(raw.plugins) ? raw.plugins : {};
  const sources = sourceList(plugins);
  const slack = isObj(raw.slack) && Array.isArray(raw.slack.channels) ? raw.slack.channels.filter((c): c is string => typeof c === "string") : [];
  return {
    github: plugins.source === undefined && plugins.sources === undefined ? false : githubSelected,
    slack: sources.includes("slack"),
    slack_channels: slack,
  };
}

function sourceList(plugins: Obj): string[] {
  const s = plugins.sources ?? plugins.source;
  if (typeof s === "string") return [s];
  return Array.isArray(s) ? s.filter((x): x is string => typeof x === "string") : [];
}

/** The new value of each top-level key the choices change; `undefined` removes the key. Unchanged keys are left out. */
export function applyChoices(raw: Obj, c: SharedChoices): Map<string, Json | undefined> {
  const out = new Map<string, Json | undefined>();
  const set = (key: string, value: Json | undefined) => {
    if (JSON.stringify(value) !== JSON.stringify(raw[key])) out.set(key, value);
  };

  const plugins: Obj = isObj(raw.plugins) ? { ...raw.plugins } : {};
  const kept = sourceList(plugins).filter((s) => s !== "github-issues" && s !== "slack" && s !== "local");
  const sources = [...(c.github ? ["github-issues"] : []), "local", ...kept, ...(c.slack ? ["slack"] : [])];
  if (plugins.sources !== undefined) plugins.sources = sources;
  else plugins.source = sources;
  if (c.github) {
    if (plugins.broker === "local") plugins.broker = "github";
  } else {
    plugins.broker = "local";
    if (plugins.forge === "github") delete plugins.forge;
  }
  set("plugins", plugins);

  // Who judges GitHub comments: GitHub when it is on; with GitHub off no GitHub plugin may stay selected.
  if (c.github) {
    if (raw.auth === undefined || raw.auth === "local") set("auth", "github");
    else if (isObj(raw.auth) && raw.auth.github_issue !== "github") set("auth", { ...raw.auth, github_issue: "github" });
  } else if (isObj(raw.auth)) {
    set("auth", { ...raw.auth, github_issue: "local", ...(raw.auth.local === "github" ? { local: "local" } : {}) });
  } else if (raw.auth !== "local" && raw.auth !== "none") {
    set("auth", "local");
  }
  const permissions = isObj(raw.permissions) ? raw.permissions : {};
  // No `grants` means the default, github-permission: GitHub off lists the local ones; GitHub on adds it back.
  const grants = Array.isArray(permissions.grants) ? permissions.grants : null;
  if (!c.github) {
    const local = (grants ?? []).filter((g) => g !== "github-permission");
    set("permissions", { ...permissions, grants: local.length > 0 ? local : ["static"] });
  } else if (grants && !grants.includes("github-permission")) {
    set("permissions", { ...permissions, grants: [...grants, "github-permission"] });
  }

  if (c.slack) set("slack", { ...(isObj(raw.slack) ? raw.slack : {}), channels: [...c.slack_channels] });
  return out;
}

/** The change as lines: `- "key": old` and `+ "key": new` per changed key. Empty when nothing changes. */
export function configDiffLines(raw: Obj, changes: ReadonlyMap<string, Json | undefined>): string[] {
  const lines: string[] = [];
  const show = (sign: string, key: string, v: Json) =>
    lines.push(...`${JSON.stringify(key)}: ${formatValue(v)}`.split("\n").map((l) => `${sign} ${l}`));
  for (const [key, value] of changes) {
    if (raw[key] !== undefined) show("-", key, raw[key]);
    if (value !== undefined) show("+", key, value);
  }
  return lines;
}
