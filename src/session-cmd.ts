// `factory session` (design §5, 2026-11-01): the CLI around src/core/session.ts. Open sessions are recorded under
// <state_dir>/sessions/; the person's GitHub login maps to their account, then to a user ID as for a commenter.

import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { join } from "node:path";
import type { SessionParts } from "./compose.js";
import type { FactoryConfig } from "./core/config.js";
import { type IssueLookup, type SessionFile, type SessionFiles, type SessionResult, Sessions } from "./core/session.js";
import { ConsoleLogger } from "./impl/log/console-logger.js";
import { baseEnv } from "./impl/process/run-process.js";
import type { WorkItemId } from "./core/types.js";
import type { ExternalIdentity } from "./interfaces/auth-provider.js";

export const SESSION_USAGE = `factory session start <issue number | work item id> [--spec <file>] [--transcript <url>] [--as <github login>]
                status | note [<text>] [--tokens <n>] [--transcript <url>] | finish [--tokens <n>] | abandon [--tokens <n>]
  status, note, finish and abandon take a work item id first, or use the only open session here (SET_UP.md)`;

export type SessionAction =
  | { cmd: "start"; target: string; spec?: string; transcript?: string; as?: string }
  | { cmd: "status"; id?: WorkItemId }
  | { cmd: "note"; id?: WorkItemId; text?: string; tokens?: number; transcript?: string }
  | { cmd: "finish" | "abandon"; id?: WorkItemId; tokens?: number };

const FLAGS = { start: ["--spec", "--transcript", "--as"], status: [], note: ["--tokens", "--transcript"], finish: ["--tokens"], abandon: ["--tokens"] };
const ITEM_ID = /^wi_[A-Za-z0-9]+$/;

export function parseSessionArgs(args: readonly string[]): SessionAction | { error: string } {
  const [cmd, ...rest] = args;
  if (!cmd || !(cmd in FLAGS)) return { error: cmd ? `unknown session command: ${cmd}` : "missing session command" };
  const c = cmd as SessionAction["cmd"];
  const flags: Record<string, string> = {};
  const pos: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!;
    if (!a.startsWith("--")) pos.push(a);
    else if (!(FLAGS[c] as readonly string[]).includes(a)) return { error: `${a} is not a flag of session ${c}` };
    else if (rest[i + 1] === undefined || rest[i + 1]!.startsWith("--")) return { error: `${a} needs a value` };
    else flags[a] = rest[++i]!;
  }
  const t = flags["--tokens"];
  if (t !== undefined && (!/^\d+$/.test(t) || !Number.isSafeInteger(Number(t)))) return { error: "--tokens takes a whole number of 0 or more" };
  const opt = (k: string, v: unknown) => (v === undefined ? {} : { [k]: v });
  const tokens = opt("tokens", t === undefined ? undefined : Number(t));
  const transcript = opt("transcript", flags["--transcript"]);
  const id = pos[0] !== undefined && ITEM_ID.test(pos[0]) ? (pos[0] as WorkItemId) : undefined;
  const after = id ? pos.slice(1) : pos;
  if (c === "start") {
    if (pos.length !== 1) return { error: "session start takes one issue number or work item id" };
    return { cmd: c, target: pos[0]!, ...opt("spec", flags["--spec"]), ...transcript, ...opt("as", flags["--as"]) };
  }
  if (c === "note") {
    const text = after.join(" ").trim();
    if (!text && t === undefined && flags["--transcript"] === undefined) return { error: "session note needs a text, --tokens or --transcript" };
    return { cmd: c, ...opt("id", id), ...opt("text", text || undefined), ...tokens, ...transcript };
  }
  if (after.length > 0) return { error: `session ${c} takes at most a work item id` };
  return c === "status" ? { cmd: c, ...opt("id", id) } : { cmd: c, ...opt("id", id), ...tokens };
}

/** Open sessions as one owner-only JSON file per item under `dir`. A lease token, never a credential. */
export class FileSessionFiles implements SessionFiles {
  constructor(private readonly dir: string) {}

  private path(id: WorkItemId): string {
    if (!ITEM_ID.test(id)) throw new Error(`not a work item id: ${id}`);
    return join(this.dir, `${id}.json`);
  }
  async read(id: WorkItemId): Promise<SessionFile | null> {
    return ITEM_ID.test(id) ? readFile(this.path(id), "utf8").then((t) => JSON.parse(t) as SessionFile, () => null) : null;
  }
  async list(): Promise<SessionFile[]> {
    const names = await readdir(this.dir).catch(() => [] as string[]);
    const files = await Promise.all(names.filter((n) => ITEM_ID.test(n.replace(/\.json$/, ""))).sort().map((n) => this.read(n.replace(/\.json$/, "") as WorkItemId)));
    return files.filter((f) => f !== null);
  }
  async write(file: SessionFile): Promise<void> {
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    await writeFile(this.path(file.work_item_id), `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600 });
  }
  async remove(id: WorkItemId): Promise<void> {
    await rm(this.path(id), { force: true });
  }
}

export interface SessionGitHub { request<T>(method: string, path: string, body?: unknown): Promise<T> }

/** The repo's issues, for `session start` on an issue with no work item. A pull request is not an issue here. */
export function githubIssues(github: SessionGitHub, repo: { owner: string; name: string }): IssueLookup {
  return {
    async issue(n) {
      type Issue = { title?: string; body?: string | null; html_url?: string; user?: { id?: number }; pull_request?: unknown };
      const r = await github.request<Issue>("GET", `/repos/${repo.owner}/${repo.name}/issues/${n}`).catch(() => null);
      if (!r || r.pull_request || typeof r.user?.id !== "number") return null;
      const link = r.html_url ?? `https://github.com/${repo.owner}/${repo.name}/issues/${n}`;
      return { source: { type: "github_issue", id: `${repo.owner}/${repo.name}#${n}`, link }, title: r.title ?? "", body: r.body ?? "", author: { provider: "github", subject: String(r.user.id) } };
    },
  };
}

/** The person's GitHub account from their login: its numeric id is the subject, as for a commenter. */
export async function githubPerson(github: SessionGitHub, login: string): Promise<ExternalIdentity | null> {
  if (!/^[A-Za-z0-9-]{1,39}$/.test(login)) return null;
  const u = await github.request<{ id?: number }>("GET", `/users/${login}`).catch(() => null);
  return typeof u?.id === "number" ? { provider: "github", subject: String(u.id), login } : null;
}

/** `stop` aborts on Ctrl-C: `start` stops keeping the lease, `finish` stops the test command. */
export interface SessionCmdDeps {
  sessions: Sessions; config: FactoryConfig; github: SessionGitHub; readSpec(path: string): Promise<string>; print(line: string): void; stop: AbortSignal;
}

/** Runs one command; returns the exit code. `start` returns only when its heartbeat stops. */
export async function runSession(d: SessionCmdDeps, a: SessionAction): Promise<number> {
  const out = (r: SessionResult): number => {
    for (const l of r.lines) d.print(l);
    return r.ok ? 0 : 1;
  };
  if (a.cmd === "status") return out(await d.sessions.status(a.id));
  if (a.cmd === "note") return out(await d.sessions.note(a));
  if (a.cmd !== "start") return out(a.cmd === "finish" ? await d.sessions.finish({ ...a, signal: d.stop }) : await d.sessions.abandon(a));
  const login = a.as ?? d.config.repo.owner;
  const person = await githubPerson(d.github, login);
  if (!person) return out({ ok: false, lines: [`refused: no GitHub account ${JSON.stringify(login)} (use --as <login>)`] });
  const spec = a.spec === undefined ? undefined : await d.readSpec(a.spec).catch(() => null);
  if (spec === null) return out({ ok: false, lines: [`refused: cannot read the --spec file ${a.spec}`] });
  const r = await d.sessions.start({ target: a.target, person, ...(spec !== undefined ? { spec } : {}), ...(a.transcript !== undefined ? { transcript: a.transcript } : {}) });
  const code = out(r);
  if (!r.ok || !r.file) return code;
  const why = await d.sessions.heartbeat(r.file, d.stop);
  d.print(why === "stopped" ? "stopped keeping the lease; when it expires the reaper ends the session (session_lost) and the item is released" : "the session has ended");
  return 0;
}

/** The command's deps from the built parts. The lease owner is never a worker id, so `workers pause` skips it. */
export function sessionDeps(p: SessionParts, stateDir: string, stop: AbortSignal): SessionCmdDeps {
  const { owner, name } = p.config.repo;
  const sessions = new Sessions({
    store: p.store, sandbox: p.sandbox, broker: p.broker, scanner: p.scanner, auth: p.auth, clock: p.clock, config: p.config,
    log: new ConsoleLogger(p.clock, "session"), files: new FileSessionFiles(join(stateDir, "sessions")), issues: githubIssues(p.github, { owner, name }),
    toolEnv: baseEnv(), owner: `session:${hostname()}:${process.pid}`,
  });
  return { sessions, config: p.config, github: p.github, readSpec: (path) => readFile(path, "utf8"), print: (l) => console.log(l), stop };
}
