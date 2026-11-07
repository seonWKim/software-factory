// `factory session` (design §5, 2026-11-01): the CLI around src/core/session.ts. Parses the arguments, keeps the
// open sessions' local records under <state_dir>/sessions/, maps the person's GitHub login to a user ID through
// the configured auth (as commands map commenters), and runs one command.

import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { join } from "node:path";
import type { FactoryConfig } from "./core/config.js";
import { type IssueLookup, type SessionFile, type SessionFiles, type SessionResult, Sessions } from "./core/session.js";
import type { WorkItemId } from "./core/types.js";
import type { ExternalIdentity } from "./interfaces/auth-provider.js";

export const SESSION_USAGE = `factory session <command>

  start <issue number | work item id> [--spec <file>] [--transcript <url>] [--as <github login>]
               takes the item for your own LLM session: one interactive run with a lease, and a run folder on
               the item's branch (its path is printed). Stays in the foreground and keeps the lease; Ctrl-C stops
               it, the lease expires and the item is released. --spec: your own spec (triage output JSON) for a
               NEW item or an issue with no item yet. --as: the GitHub login (default: repo.owner)
  status [<work item id>]
               the item, the run, the lease expiry and the result of the last finish attempt
  note [<work item id>] [<text>] [--tokens <n>] [--transcript <url>]
               stores a note (egress-scanned), your latest token total, or a transcript URL on the run
  finish [<work item id>] [--tokens <n>]
               scope gate, size gate, floor check, then repo.test_command in the run folder; all pass: pushes
               the branch and opens the PR through the factory's broker, and the item goes to review
  abandon [<work item id>] [--tokens <n>]
               ends the session as failed (abandoned); the pushed branch and the run folder are kept

  With no work item id, the command uses the only open session on this machine.`;

export type SessionAction =
  | { cmd: "start"; target: string; spec?: string; transcript?: string; as?: string }
  | { cmd: "status"; id?: WorkItemId }
  | { cmd: "note"; id?: WorkItemId; text?: string; tokens?: number; transcript?: string }
  | { cmd: "finish"; id?: WorkItemId; tokens?: number }
  | { cmd: "abandon"; id?: WorkItemId; tokens?: number };

const FLAGS: Record<SessionAction["cmd"], readonly string[]> = {
  start: ["--spec", "--transcript", "--as"],
  status: [],
  note: ["--tokens", "--transcript"],
  finish: ["--tokens"],
  abandon: ["--tokens"],
};

const ITEM_ID = /^wi_[A-Za-z0-9]+$/;

/** The parsed command, or why it does not parse. */
export function parseSessionArgs(args: readonly string[]): SessionAction | { error: string } {
  const [cmd, ...rest] = args;
  if (cmd !== "start" && cmd !== "status" && cmd !== "note" && cmd !== "finish" && cmd !== "abandon") {
    return { error: cmd ? `unknown session command: ${cmd}` : "missing session command" };
  }
  const flags: Record<string, string> = {};
  const positional: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!;
    if (a.startsWith("--")) {
      if (!FLAGS[cmd].includes(a)) return { error: `${a} is not a flag of session ${cmd}` };
      const v = rest[i + 1];
      if (v === undefined || v.startsWith("--")) return { error: `${a} needs a value` };
      flags[a] = v;
      i++;
    } else positional.push(a);
  }
  let tokens: number | undefined;
  if (flags["--tokens"] !== undefined) {
    if (!/^\d+$/.test(flags["--tokens"]) || !Number.isSafeInteger(Number(flags["--tokens"]))) {
      return { error: "--tokens takes a whole number of 0 or more" };
    }
    tokens = Number(flags["--tokens"]);
  }
  const tok = tokens === undefined ? {} : { tokens };
  const transcript = flags["--transcript"] === undefined ? {} : { transcript: flags["--transcript"] };
  // An optional leading work item id.
  const id = positional[0] !== undefined && ITEM_ID.test(positional[0]) ? (positional[0] as WorkItemId) : undefined;
  const after = id ? positional.slice(1) : positional;
  const idPart = id ? { id } : {};
  switch (cmd) {
    case "start": {
      if (positional.length !== 1) return { error: "session start takes one issue number or work item id" };
      return {
        cmd, target: positional[0]!, ...transcript,
        ...(flags["--spec"] !== undefined ? { spec: flags["--spec"] } : {}),
        ...(flags["--as"] !== undefined ? { as: flags["--as"] } : {}),
      };
    }
    case "note": {
      const text = after.join(" ").trim();
      if (!text && tokens === undefined && flags["--transcript"] === undefined) return { error: "session note needs a text, --tokens or --transcript" };
      return { cmd, ...idPart, ...(text ? { text } : {}), ...tok, ...transcript };
    }
    case "status":
    case "finish":
    case "abandon":
      if (after.length > 0) return { error: `session ${cmd} takes at most a work item id` };
      return cmd === "status" ? { cmd, ...idPart } : { cmd, ...idPart, ...tok };
  }
}

/** Open sessions as one JSON file per item under `dir` (owner-only). Holds a lease token, never a credential. */
export class FileSessionFiles implements SessionFiles {
  constructor(private readonly dir: string) {}

  private path(id: WorkItemId): string {
    if (!ITEM_ID.test(id)) throw new Error(`not a work item id: ${id}`);
    return join(this.dir, `${id}.json`);
  }

  async read(id: WorkItemId): Promise<SessionFile | null> {
    try {
      return JSON.parse(await readFile(this.path(id), "utf8")) as SessionFile;
    } catch {
      return null;
    }
  }

  async list(): Promise<SessionFile[]> {
    let names: string[];
    try {
      names = await readdir(this.dir);
    } catch {
      return [];
    }
    const out: SessionFile[] = [];
    for (const n of names.filter((x) => x.endsWith(".json")).sort()) {
      const f = await this.read(n.slice(0, -".json".length) as WorkItemId);
      if (f) out.push(f);
    }
    return out;
  }

  async write(file: SessionFile): Promise<void> {
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    await writeFile(this.path(file.work_item_id), `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600 });
  }

  async remove(id: WorkItemId): Promise<void> {
    await rm(this.path(id), { force: true });
  }
}

/** The GitHub reads a session needs, through the factory's GitHub client. */
export interface SessionGitHub {
  request<T>(method: string, path: string, body?: unknown): Promise<T>;
}

/** The repo's issues, for `session start` on an issue with no work item. A pull request is not an issue here. */
export function githubIssues(github: SessionGitHub, repo: { owner: string; name: string }): IssueLookup {
  return {
    async issue(n) {
      let r: { title?: string; body?: string | null; html_url?: string; user?: { id?: number }; pull_request?: unknown };
      try {
        r = await github.request("GET", `/repos/${repo.owner}/${repo.name}/issues/${n}`);
      } catch {
        return null;
      }
      if (r.pull_request || typeof r.user?.id !== "number") return null;
      return {
        source: { type: "github_issue", id: `${repo.owner}/${repo.name}#${n}`, link: r.html_url ?? `https://github.com/${repo.owner}/${repo.name}/issues/${n}` },
        title: r.title ?? "",
        body: r.body ?? "",
        author: { provider: "github", subject: String(r.user.id) },
      };
    },
  };
}

/** The person's GitHub account from their login: the numeric id is the subject, as for a commenter. */
export async function githubPerson(github: SessionGitHub, login: string): Promise<ExternalIdentity | null> {
  if (!/^[A-Za-z0-9-]{1,39}$/.test(login)) return null;
  try {
    const u = await github.request<{ id?: number }>("GET", `/users/${login}`);
    return typeof u.id === "number" ? { provider: "github", subject: String(u.id), login } : null;
  } catch {
    return null;
  }
}

export interface SessionCmdDeps {
  sessions: Sessions;
  config: FactoryConfig;
  github: SessionGitHub;
  /** Reads the --spec file. */
  readSpec(path: string): Promise<string>;
  print(line: string): void;
  /** Aborts when the person stops `session start` (Ctrl-C). */
  stop: AbortSignal;
}

/** Runs one command; returns the exit code. `start` returns only when its heartbeat stops. */
export async function runSession(d: SessionCmdDeps, a: SessionAction): Promise<number> {
  const out = (r: SessionResult): number => {
    for (const l of r.lines) d.print(l);
    return r.ok ? 0 : 1;
  };
  switch (a.cmd) {
    case "start": {
      const login = a.as ?? d.config.repo.owner;
      const person = await githubPerson(d.github, login);
      if (!person) return out({ ok: false, lines: [`refused: no GitHub account ${JSON.stringify(login)} (use --as <login>)`] });
      let spec: string | undefined;
      if (a.spec !== undefined) {
        try {
          spec = await d.readSpec(a.spec);
        } catch {
          return out({ ok: false, lines: [`refused: cannot read the --spec file ${a.spec}`] });
        }
      }
      const r = await d.sessions.start({ target: a.target, person, ...(spec !== undefined ? { spec } : {}), ...(a.transcript !== undefined ? { transcript: a.transcript } : {}) });
      const code = out(r);
      if (!r.ok || !r.file) return code;
      const why = await d.sessions.heartbeat(r.file, d.stop);
      d.print(why === "stopped"
        ? "stopped keeping the lease; when it expires the reaper ends the session (session_lost) and the item is released"
        : "the session has ended");
      return 0;
    }
    case "status":
      return out(await d.sessions.status(a.id));
    case "note":
      return out(await d.sessions.note(a));
    case "finish":
      return out(await d.sessions.finish({ ...a, signal: d.stop }));
    case "abandon":
      return out(await d.sessions.abandon(a));
  }
}

/** The lease owner of sessions started by this process: never a worker id, so `workers pause` skips it. */
export function sessionOwner(): string {
  return `session:${hostname()}:${process.pid}`;
}

/** Where open sessions are recorded. */
export function sessionsDir(stateDir: string): string {
  return join(stateDir, "sessions");
}
