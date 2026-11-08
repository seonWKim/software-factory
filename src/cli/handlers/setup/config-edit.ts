// The shared choices `factory setup` writes to factory.config.json (owner decision 2026-11-08): the store and
// which sync plugins (GitHub, Slack) are on. Pure: it reads and returns the file's text, and changes only the
// top-level keys a choice touches, leaving every other line as it was written.

/** What setup asks for the whole team. Per-person choices (the display name) never go to the file. */
export interface SharedChoices {
  store: "sqlite" | "mysql";
  github: boolean;
  slack: boolean;
  /** Slack channel IDs (`C…`, `G…`); read only when `slack` is on. */
  slack_channels: readonly string[];
}

type Json = null | boolean | number | string | Json[] | { [k: string]: Json };
type Obj = { [k: string]: Json };

/** The MySQL block a file without one gets: the local server, the factory's own database and user. */
export const DEFAULT_MYSQL: Obj = { type: "mysql", host: "localhost", port: 3306, database: "software_factory", user: "factory" };

const SLACK_CHANNEL = /^[CG][A-Z0-9]{2,}$/;

/** The channel IDs in `raw` (comma or space separated), or the first one that is not an ID. */
export function parseSlackChannels(raw: string): { ok: true; channels: string[] } | { ok: false; bad: string } {
  const channels = raw.split(/[\s,]+/).filter((c) => c !== "");
  const bad = channels.find((c) => !SLACK_CHANNEL.test(c));
  return bad === undefined ? { ok: true, channels } : { ok: false, bad };
}

const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * The choices as the file stands: each step's default. `githubSelected` is the loaded config's answer (any GitHub
 * plugin selected). A file that lists no sources yet gets the solo defaults: SQLite, local only, no Slack.
 */
export function currentChoices(raw: Obj, githubSelected: boolean): SharedChoices {
  const plugins = isObj(raw.plugins) ? raw.plugins : {};
  const sources = sourceList(plugins);
  const slack = isObj(raw.slack) && Array.isArray(raw.slack.channels) ? raw.slack.channels.filter((c): c is string => typeof c === "string") : [];
  return {
    store: isObj(raw.store) && raw.store.type === "mysql" ? "mysql" : "sqlite",
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

  if (c.store === "sqlite") set("store", raw.store === undefined ? undefined : { type: "sqlite" });
  else set("store", isObj(raw.store) && raw.store.type === "mysql" ? raw.store : DEFAULT_MYSQL);

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

// Text edits that keep the file's own layout.

interface Member {
  key: string;
  /** Index of the key's opening quote. */
  start: number;
  valueStart: number;
  /** Index just past the value. */
  end: number;
}

function skipWs(t: string, i: number): number {
  while (i < t.length && /\s/.test(t[i]!)) i++;
  return i;
}

function skipString(t: string, i: number): number {
  for (i++; i < t.length; i++) {
    if (t[i] === "\\") i++;
    else if (t[i] === '"') return i + 1;
  }
  throw new Error("factory.config.json: unterminated string");
}

function skipValue(t: string, i: number): number {
  if (t[i] === '"') return skipString(t, i);
  if (t[i] !== "{" && t[i] !== "[") {
    while (i < t.length && !/[\s,}\]]/.test(t[i]!)) i++;
    return i;
  }
  let depth = 0;
  for (; i < t.length; i++) {
    const ch = t[i]!;
    if (ch === '"') i = skipString(t, i) - 1;
    else if (ch === "{" || ch === "[") depth++;
    else if (ch === "}" || ch === "]") {
      depth--;
      if (depth === 0) return i + 1;
    }
  }
  throw new Error("factory.config.json: unbalanced brackets");
}

/** The top-level members of a JSON object text, in order, with their positions. */
function members(t: string): { members: Member[]; close: number } {
  let i = skipWs(t, 0);
  if (t[i] !== "{") throw new Error("factory.config.json: not a JSON object");
  const out: Member[] = [];
  i = skipWs(t, i + 1);
  while (t[i] !== "}") {
    const start = i;
    i = skipString(t, i);
    const key = JSON.parse(t.slice(start, i)) as string;
    i = skipWs(t, i);
    if (t[i] !== ":") throw new Error(`factory.config.json: expected ":" after "${key}"`);
    const valueStart = skipWs(t, i + 1);
    const end = skipValue(t, valueStart);
    out.push({ key, start, valueStart, end });
    i = skipWs(t, end);
    if (t[i] === ",") i = skipWs(t, i + 1);
  }
  return { members: out, close: i };
}

/** One line when short (`{ "a": 1 }`), else one member per line, each member's value on one line. */
export function formatValue(v: Json, indent = "  "): string {
  const one = compact(v);
  if (one.length <= 100 || !isObj(v)) return one;
  return `{\n${Object.entries(v).map(([k, x]) => `${indent}  ${JSON.stringify(k)}: ${compact(x)}`).join(",\n")}\n${indent}}`;
}

function compact(v: Json): string {
  if (Array.isArray(v)) return `[${v.map(compact).join(", ")}]`;
  if (isObj(v)) {
    const e = Object.entries(v);
    return e.length === 0 ? "{}" : `{ ${e.map(([k, x]) => `${JSON.stringify(k)}: ${compact(x)}`).join(", ")} }`;
  }
  return JSON.stringify(v);
}

/** `text` with each top-level key set to its new value (`undefined`: removed); new keys go last. */
export function editConfigText(text: string, changes: ReadonlyMap<string, Json | undefined>): string {
  let t = text;
  for (const [key, value] of changes) {
    const { members: ms, close } = members(t);
    const at = ms.findIndex((m) => m.key === key);
    const m = ms[at];
    if (value === undefined) {
      if (!m) continue;
      // Drop the member and the separator before it (or after it, when it is the first).
      t = at > 0 ? t.slice(0, ms[at - 1]!.end) + t.slice(m.end) : t.slice(0, m.start) + t.slice(ms[1] ? ms[1].start : m.end);
    } else if (m) {
      t = t.slice(0, m.valueStart) + formatValue(value) + t.slice(m.end);
    } else {
      const last = ms[ms.length - 1];
      const entry = `  ${JSON.stringify(key)}: ${formatValue(value)}`;
      t = last ? `${t.slice(0, last.end)},\n${entry}${t.slice(last.end)}` : `${t.slice(0, close)}\n${entry}\n${t.slice(close)}`;
    }
  }
  return t;
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
