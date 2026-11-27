// Feedback schedule grants (design 08-schedules): what a feedback schedule's agent may use beyond the read-only
// tools Read, Glob and Grep, each named by the owner on the schedule (`--grant`, stored as `settings.grants`).
//   browser  the Browse tool, GET of the schedule's sandbox URL (a local server: localhost or a loopback address) only
//   notes    Write and Edit, inside the schedule's notes folder `.factory/notes/<schedule id>/` only
//   repo     the agent runs in a fresh checkout of the git repo the owner names, outside the factory's state folder, and no other
//   shell    one command: `sqlite3 -readonly` on the database file the owner names
// Every grant is checked and handed out by ScheduleGrantBroker, a ToolBroker: a grant it refuses fails the run
// before any agent starts, and the shell grant's only tool is a broker tool (`tool_grants`), served through the
// runner's tool bridge by scheduleGrantTools, which calls the run's schedule's broker, inside the G2 guard: each call
// is checked against the schedule run's passport (withSchedulePassports) and audited like every broker tool.

import type { AgentRunner } from "../interfaces/agent-runner.js";
import type { ToolCallContext, ToolDescriptor, ToolBroker, ToolResult as BrokerResult } from "../interfaces/tool-broker.js";
import { Browse, Edit, Write } from "./tools/index.js";
import { isAbsolute, isUnder, normalize, resolvePath } from "./tools/paths.js";
import type { ScheduleActionSpec, ScheduleStore } from "./schedule.js";
import type { ToolSpec } from "./tools/types.js";

/** The factory's state folder, relative to the factory repo. */
export const STATE_DIR = ".factory";
/** The one command a shell grant runs. */
export const SCHEDULE_SHELL_COMMAND = "sqlite3 -readonly";
/** The broker tool a shell grant hands out. */
export const SQLITE_TOOL = "schedule.sqlite_readonly";

export type ScheduleGrant =
  | { kind: "browser"; url: string }
  | { kind: "notes" }
  | { kind: "repo"; path: string; base_ref: string }
  | { kind: "shell"; command: typeof SCHEDULE_SHELL_COMMAND; db: string };

/**
 * A schedule ID: lowercase letters, digits and `-`, 1 to 64 characters, starting with a letter or digit, so it is one plain
 * folder name. `_` is allowed too: `schedule draft` names its schedules `sch_<id>`, and stored IDs use it.
 */
const SCHEDULE_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/;

/** Why `id` is no schedule ID, or null. */
export const scheduleIdProblem = (id: string): string | null =>
  SCHEDULE_ID.test(id) ? null : `the schedule ID ${JSON.stringify(id)} is not allowed: use lowercase letters, digits, '-' and '_' (1 to 64 characters, starting with a letter or digit)`;

/** The schedule's notes folder, relative to the factory repo: `.factory/notes/<schedule id>/`. Throws on an ID that is no schedule ID. */
export function notesFolder(schedule_id: string): string {
  const problem = scheduleIdProblem(schedule_id);
  if (problem) throw new Error(problem);
  return `${STATE_DIR}/notes/${schedule_id}/`;
}

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** Why `g` cannot be stored, or null. Pure: the repo's and the database's files are checked when the run starts. */
export function grantProblem(g: ScheduleGrant): string | null {
  if (g.kind === "browser") {
    let url: URL;
    try {
      url = new URL(g.url);
    } catch {
      return "a browser grant's URL is not a valid URL";
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") return "a browser grant's URL is http or https";
    if (url.username !== "" || url.password !== "") return "a browser grant's URL carries no credentials";
    if (!LOOPBACK.has(url.hostname)) return "a browser grant's URL is the schedule's sandbox URL: localhost or a loopback address";
    return null;
  }
  if (g.kind === "repo") {
    if (!isAbsolute(g.path)) return "a repo grant names an absolute path";
    if (normalize(g.path).split("/").includes(STATE_DIR)) return `a repo grant's repo is outside the factory's state folder (${STATE_DIR})`;
    if (!/^[\w./-]+$/.test(g.base_ref) || g.base_ref.startsWith("-")) return "a repo grant's branch is a plain branch name";
    return null;
  }
  if (g.kind === "shell") {
    if (g.command !== SCHEDULE_SHELL_COMMAND) return `a shell grant allows only ${SCHEDULE_SHELL_COMMAND}`;
    return isAbsolute(g.db) ? null : "a shell grant names the database as an absolute path";
  }
  return null;
}

/** One `--grant` word as a grant, or why it is none: `browser=<url>`, `notes`, `repo=<path>[#<branch>]`, `shell=<database>`. */
export function grantOfWord(word: string): ScheduleGrant | { problem: string } {
  const at = word.indexOf("="), kind = at < 0 ? word : word.slice(0, at), value = at < 0 ? "" : word.slice(at + 1).trim();
  let g: ScheduleGrant;
  if (kind === "notes" && at < 0) g = { kind };
  else if (kind === "browser" && value) g = { kind, url: value };
  else if (kind === "repo" && value) {
    const hash = value.lastIndexOf("#");
    g = hash < 0 ? { kind, path: value, base_ref: "main" } : { kind, path: value.slice(0, hash), base_ref: value.slice(hash + 1) };
  } else if (kind === "shell" && value) g = { kind, command: SCHEDULE_SHELL_COMMAND, db: value };
  else return { problem: `unknown grant ${JSON.stringify(word)}: browser=<url>, notes, repo=<path>[#<branch>], shell=<database>, or none` };
  const problem = grantProblem(g);
  return problem ? { problem } : g;
}

/** The `--grant` words as the grant list to store (`none` alone: no grants), or why they cannot be. One grant of each kind. */
export function grantsOfWords(words: readonly string[]): ScheduleGrant[] | { problem: string } {
  if (words.length === 1 && words[0] === "none") return [];
  const out: ScheduleGrant[] = [];
  for (const w of words) {
    const g = grantOfWord(w.trim());
    if ("problem" in g) return g;
    if (out.some((o) => o.kind === g.kind)) return { problem: `one ${g.kind} grant per schedule` };
    out.push(g);
  }
  return out;
}

/** The grants stored in an action's settings; a stored entry that is no valid grant throws (it fails the run). */
export function storedGrants(settings: Readonly<Record<string, unknown>>): ScheduleGrant[] {
  const raw = settings.grants;
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) throw new Error("the schedule's grants are not a list");
  return raw.map((g: ScheduleGrant) => {
    const problem = typeof g === "object" && g !== null && ["browser", "notes", "repo", "shell"].includes(g.kind) ? grantProblem(g) : "unknown grant";
    if (problem) throw new Error(`the schedule's grant is refused: ${problem}`);
    return g;
  });
}

/** One grant in plain words, as `schedule list` shows it. */
export function grantWords(g: ScheduleGrant, schedule_id: string): string {
  if (g.kind === "browser") return `browser: Browse may read only ${g.url}`;
  if (g.kind === "notes") return `notes: may write only in ${notesFolder(schedule_id)}`;
  if (g.kind === "repo") return `repo: its agent runs in ${g.path} (${g.base_ref}) and no other`;
  return `shell: only ${g.command} ${g.db}`;
}

/**
 * A feedback schedule's grants, each in plain words (a stored grant that is refused: `refused (why)`), as `schedule list`
 * and GET /api/v1/schedules show them; none for no grants or another kind.
 */
export function grantList(action: ScheduleActionSpec | null, schedule_id: string): string[] {
  if (action?.kind !== "feedback" || action.settings.grants === undefined) return [];
  try {
    return storedGrants(action.settings).map((g) => grantWords(g, schedule_id));
  } catch (e) {
    return [`refused (${e instanceof Error ? e.message : String(e)})`];
  }
}

/** The grants column of `schedule list` (`grants: …; …`), or none when the schedule has no grants. */
export function grantsLine(action: ScheduleActionSpec | null, schedule_id: string): string[] {
  const list = grantList(action, schedule_id);
  return list.length === 0 ? [] : [`grants: ${list.join("; ")}`];
}

/** The grant fields of a schedule add or edit (ScheduleFields): feedback only, the `--grant` words, one grant each. */
export interface GrantFields {
  grants?: string[];
}

/**
 * `action` (or its problem, passed on) with the `--grant` words as its grants (`none`: an empty list, which an edit
 * stores over the old), or why they cannot be: only a feedback schedule takes grants, and a notes grant needs a plain
 * schedule ID (its folder's name). No words: `action` as it is.
 */
export function withGrantWords(action: ScheduleActionSpec | { problem: string }, words: readonly string[] | undefined, schedule_id: string): ScheduleActionSpec | { problem: string } {
  if (words === undefined || "problem" in action) return action;
  if (action.kind !== "feedback") return { problem: "only a feedback schedule takes --grant" };
  const grants = grantsOfWords(words);
  if ("problem" in grants) return grants;
  const idProblem = grants.some((g) => g.kind === "notes") ? scheduleIdProblem(schedule_id) : null;
  if (idProblem) return { problem: `a notes grant needs a plain schedule ID: ${idProblem}` };
  return { kind: action.kind, settings: { ...action.settings, grants } };
}

/** What a feedback run gets once its grants are handed out. */
export interface GrantedRun {
  /** The read-only tools, then each granted one. */
  tools: ToolSpec[];
  /** The repo the run checks out, and its base. */
  repo: string;
  base_ref: string;
  /** The notes folder (absolute), when granted: the only place its Write and Edit reach. */
  writable_paths: string[];
  /** The broker tools granted: SQLITE_TOOL for a shell grant. */
  tool_grants: string[];
}

/** What the broker reads and runs (node's in src/impl/schedule-action/routed-action.ts); tests fake each. */
export interface GrantBrokerDeps {
  exists(path: string): boolean;
  mkdir(path: string): Promise<void>;
  /** Runs `file` with `args`, no shell, and returns its stdout or throws. */
  exec(file: string, args: readonly string[], signal?: AbortSignal): Promise<string>;
}

/** The one statement the read-only shell runs: a SELECT, WITH, EXPLAIN or PRAGMA table_info, with at most a trailing `;`. */
const ALLOWED_SQL = /^\s*(select|with|explain|pragma\s+table_info)\b[^;]*;?\s*$/i;
/**
 * Second layer under ALLOWED_SQL and `-safe`: a line starting a dot command, ATTACH, VACUUM (its INTO writes a file even under -readonly), and the
 * CLI's functions and virtual tables that read or write files or load code (fsdir reads any file, even under -safe).
 */
const UNSAFE_SQL = /(^|\n)\s*\.|\b(attach|vacuum|fsdir|zipfile|sqlar_compress|sqlar_uncompress|lsmode|readfile|writefile|load_extension|fts3_tokenizer)\b|\bedit\s*\(/i;

const SQLITE_DESCRIPTOR: ToolDescriptor = {
  name: SQLITE_TOOL,
  description: `Run one SQL query with ${SCHEDULE_SHELL_COMMAND} on the database the owner granted; returns its output.`,
  input_schema: { type: "object", properties: { sql: { type: "string" } }, required: ["sql"], additionalProperties: false },
  read_only: true,
};

/**
 * The ToolBroker of one feedback run's grants: `handOut` checks every grant and returns what the run gets; the shell
 * grant's tool is served by `call`, which runs `sqlite3 -safe -readonly` on the granted database and nothing else.
 */
export class ScheduleGrantBroker implements ToolBroker {
  constructor(
    private readonly schedule_id: string,
    private readonly grants: readonly ScheduleGrant[],
    private readonly deps: GrantBrokerDeps,
  ) {}

  private shell() {
    return this.grants.find((g): g is Extract<ScheduleGrant, { kind: "shell" }> => g.kind === "shell");
  }

  allTools(): readonly ToolDescriptor[] {
    return this.shell() ? [SQLITE_DESCRIPTOR] : [];
  }

  listTools(grants: readonly string[]): ToolDescriptor[] {
    return this.allTools().filter((t) => grants.includes(t.name));
  }

  async call(_ctx: ToolCallContext, name: string, args: unknown): Promise<BrokerResult> {
    const shell = this.shell();
    if (name !== SQLITE_TOOL || !shell) return { ok: false, error_code: "not_granted", message: `${name} is not granted to schedule ${this.schedule_id}` };
    const sql = (args as { sql?: unknown } | null)?.sql;
    if (typeof sql !== "string" || sql.trim() === "") return { ok: false, error_code: "bad_args", message: "sql must be a query" };
    // The allowlist also refuses dot commands and a leading `-`, which sqlite3 reads as an option even after the database.
    if (!ALLOWED_SQL.test(sql) || UNSAFE_SQL.test(sql)) return { ok: false, error_code: "refused", message: `${SCHEDULE_SHELL_COMMAND} runs one SELECT, WITH, EXPLAIN or PRAGMA table_info only: no ATTACH, VACUUM or file functions` };
    try {
      // -safe turns off the CLI's commands and functions that touch files; fsdir is still refused above.
      return { ok: true, content: await this.deps.exec("sqlite3", ["-safe", "-readonly", shell.db, sql]) };
    } catch (e) {
      return { ok: false, error_code: "failed", message: e instanceof Error ? e.message : String(e) };
    }
  }

  /**
   * Checks each grant and hands it out over `base` (the read-only tools, the factory repo and its base branch). Throws,
   * before any agent starts, on a refused grant: a repo that is no git repo or lies in the state folder, a missing database.
   * Creates the notes folder when granted.
   */
  async handOut(base: GrantBase): Promise<GrantedRun> {
    const run: GrantedRun = { tools: [...base.tools], repo: base.repo, base_ref: base.base_ref, writable_paths: [], tool_grants: [] };
    for (const g of this.grants) {
      const problem = grantProblem(g);
      if (problem) throw new Error(`schedule ${this.schedule_id}: ${problem}`);
      if (g.kind === "browser") run.tools.push(browseOnly(g.url));
      else if (g.kind === "notes") {
        const folder = resolvePath(base.repo, notesFolder(this.schedule_id));
        const root = resolvePath(base.repo, `${STATE_DIR}/notes`);
        if (folder === root || !isUnder(folder, root)) throw new Error(`schedule ${this.schedule_id}: the notes folder ${folder} is outside ${STATE_DIR}/notes/`);
        await this.deps.mkdir(folder);
        run.writable_paths.push(folder);
        run.tools.push(insideOnly(Write, folder), insideOnly(Edit, folder));
      } else if (g.kind === "repo") {
        const path = normalize(g.path);
        if (isUnder(path, resolvePath(base.repo, STATE_DIR))) throw new Error(`schedule ${this.schedule_id}: a repo grant's repo is outside the factory's state folder`);
        if (!this.deps.exists(`${path}/.git`)) throw new Error(`schedule ${this.schedule_id}: the granted repo ${path} is no git repo`);
        Object.assign(run, { repo: path, base_ref: g.base_ref });
      } else {
        if (!this.deps.exists(g.db)) throw new Error(`schedule ${this.schedule_id}: the granted database ${g.db} does not exist`);
        run.tool_grants.push(SQLITE_TOOL);
      }
    }
    return run;
  }
}

/** scheduleGrantTools' `grantsOf` over the store: the stored grants of the feedback schedule with the ID, else none. */
export const storedScheduleGrants = (store: Pick<ScheduleStore, "listSchedules">) => async (schedule_id: string): Promise<ScheduleGrant[]> => {
  const action = (await store.listSchedules()).find((s) => s.id === schedule_id)?.action;
  return action?.kind === "feedback" ? storedGrants(action.settings) : [];
};

/** The work item ID of a schedule's agent runs (routed-action.ts): `schedule:<id>`. */
const SCHEDULE_ITEM = "schedule:";

/**
 * The runner's broker `inner` with the shell grant's tool: listed when a run is granted it, and each call served by
 * the ScheduleGrantBroker of the run's schedule (work item `schedule:<id>`) over its stored grants, read per call by
 * `grantsOf`. Any other run, or a schedule with no shell grant, gets not_granted. Every other tool goes to `inner`.
 * Compose wraps the result in the G2 guard (PassportToolBroker), so each call is checked against the run's passport
 * and audited in authz_audit first; withSchedulePassports gives a schedule run that passport.
 */
export function scheduleGrantTools(inner: ToolBroker, grantsOf: (schedule_id: string) => Promise<readonly ScheduleGrant[]>, deps: GrantBrokerDeps): ToolBroker {
  return {
    listTools: (grants) => [...inner.listTools(grants), ...(grants.includes(SQLITE_TOOL) ? [SQLITE_DESCRIPTOR] : [])],
    allTools: () => [...inner.allTools(), SQLITE_DESCRIPTOR],
    call: async (ctx, name, args) => {
      if (name !== SQLITE_TOOL) return inner.call(ctx, name, args);
      const id = ctx.work_item_id.startsWith(SCHEDULE_ITEM) ? ctx.work_item_id.slice(SCHEDULE_ITEM.length) : null;
      const grants = id === null ? [] : await grantsOf(id).catch(() => []);
      return new ScheduleGrantBroker(id ?? ctx.work_item_id, grants, deps).call(ctx, name, args);
    },
  };
}

/** The run passport kind of a schedule run: it names no worker tool, only the broker tools its grants hand out. */
export const SCHEDULE_PASSPORT_KIND = "schedule";

/** What withSchedulePassports mints and drops a run passport through (RunPassports, src/worker/passports/run-passports.ts). */
export interface SchedulePassports {
  begin(req: { run: string; lease_token: number; kind: string; item: string; project: string; branch: string; grants: readonly string[] }): Promise<unknown>;
  end(run: string, lease_token: number): void;
}

/**
 * The schedule action's runner: a schedule run (work item `schedule:<id>`) granted broker tools holds a run passport
 * for project `project`, narrowed to its run, item and `tool_grants`, minted before the run and dropped after it, so
 * the G2 guard passes only that run's own granted calls. Any other run goes to `runner` as it is.
 */
export function withSchedulePassports(runner: AgentRunner, passports: SchedulePassports, project: string): AgentRunner {
  return {
    run: async (spec) => {
      if (!spec.work_item_id.startsWith(SCHEDULE_ITEM) || spec.tool_grants.length === 0) return runner.run(spec);
      const held = { run: spec.run_id, lease_token: spec.lease_token };
      await passports.begin({ ...held, kind: SCHEDULE_PASSPORT_KIND, item: spec.work_item_id, project, branch: `schedule/${spec.run_id}`, grants: spec.tool_grants });
      try {
        return await runner.run(spec);
      } finally {
        passports.end(held.run, held.lease_token);
      }
    },
  };
}

/** The read-only tools, the factory repo and its base branch: what a feedback run gets before its grants. */
type GrantBase = { tools: readonly ToolSpec[]; repo: string; base_ref: string };

/**
 * Compose's wiring of feedback schedule grants (design 08-schedules), over this machine's I/O `deps` (nodeGrantDeps in
 * src/impl/schedule-action/routed-action.ts): `broker` gives the runner's broker the shell grant's tool (compose wraps
 * it in the G2 guard, so it reaches a run through the runner's tool bridge), `handOut` is the feedback route's
 * hand-out over `base`, and `runner` holds a run passport for a schedule run granted broker tools in `project`.
 */
export function feedbackGrants(d: { store: Pick<ScheduleStore, "listSchedules">; deps: GrantBrokerDeps; passports: SchedulePassports; base: GrantBase }) {
  return {
    broker: (inner: ToolBroker): ToolBroker => scheduleGrantTools(inner, storedScheduleGrants(d.store), d.deps),
    handOut: feedbackGrantHandOut(d.base, d.deps),
    runner: (runner: AgentRunner, project: string): AgentRunner => withSchedulePassports(runner, d.passports, project),
  };
}

/**
 * The feedback route's hand-out (ports.ts GrantHandOut) over `base`: null for a schedule with no grants, else
 * ScheduleGrantBroker's hand-out with each grant in plain words. A refused grant throws.
 */
export const feedbackGrantHandOut = (base: GrantBase, deps: GrantBrokerDeps) =>
  async (s: { id: string; settings: Readonly<Record<string, unknown>> }): Promise<(GrantedRun & { granted: string[] }) | null> => {
    const grants = storedGrants(s.settings);
    if (grants.length === 0) return null;
    return { ...(await new ScheduleGrantBroker(s.id, grants, deps).handOut(base)), granted: grants.map((g) => grantWords(g, s.id)) };
  };

/** Browse, fetching `url` only, whatever the run's policy holds. */
function browseOnly(url: string): ToolSpec {
  return { ...Browse, run: (input, ctx) => Browse.run(input, { ...ctx, policy: { ...ctx.policy, browse_url: url } }) };
}

/** `tool` (Write or Edit), refusing any `file_path` outside `folder`. */
function insideOnly(tool: ToolSpec, folder: string): ToolSpec {
  return {
    ...tool,
    description: `${tool.description} Only inside ${folder}.`,
    run: async (input, ctx) => {
      const file = (input as { file_path?: unknown } | null)?.file_path;
      if (typeof file !== "string" || !isUnder(resolvePath(ctx.policy.workdir, file), folder)) return { ok: false, error: `${tool.name} writes only inside the notes folder ${folder}` };
      return tool.run(input, ctx);
    },
  };
}
