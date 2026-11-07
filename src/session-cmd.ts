// `factory session`: a person's own LLM session on a work item, recorded as an `interactive` run (design
// 2026-11-01). `start` makes the run folder and stays in the foreground renewing the lease until Ctrl-C; the other
// commands run in another terminal. The open session is kept under <state_dir>/sessions/, one file per item.

import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { join } from "node:path";
import { type Loaded, buildSessionParts } from "./compose.js";
import { type SessionFiles, type SessionRecord, Sessions } from "./core/session.js";
import type { WorkItemId, WorkerId } from "./core/types.js";
import { baseEnv } from "./impl/process/run-process.js";

export const SESSION_USAGE = `usage: npm run factory -- session <command>
  start <issue number | work item id> [--as <github login>] [--spec <file>] [--transcript <url>]
  status [<work item id>]
  note [--item <work item id>] [--tokens <n>] [--transcript <url>] <text>
  finish [<work item id>] [--tokens <n>]
  abandon [<work item id>] [--tokens <n>]`;

export type SessionAction =
  | { action: "start"; ref: string; as?: string; spec?: string; transcript?: string }
  | { action: "status"; id?: string }
  | { action: "note"; text: string; id?: string; tokens?: number; transcript?: string }
  | { action: "finish"; id?: string; tokens?: number }
  | { action: "abandon"; id?: string; tokens?: number };

const FLAGS: Record<SessionAction["action"], readonly string[]> = {
  start: ["--as", "--spec", "--transcript"],
  status: ["--item"],
  note: ["--item", "--tokens", "--transcript"],
  finish: ["--item", "--tokens"],
  abandon: ["--item", "--tokens"],
};

/** The action, or an error line (the caller prints it with the usage). Nothing is read or written here. */
export function parseSessionArgs(args: readonly string[]): SessionAction | { error: string } {
  const [action, ...rest] = args;
  if (!action || !(action in FLAGS)) return { error: action ? `unknown session command: ${action}` : "missing session command" };
  const allowed = FLAGS[action as SessionAction["action"]];
  const flags: Record<string, string> = {};
  const free: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!;
    if (a.startsWith("--")) {
      const v = rest[i + 1];
      if (!allowed.includes(a)) return { error: `${a} is not a flag of session ${action}` };
      if (v === undefined) return { error: `${a} needs a value` };
      flags[a] = v;
      i++;
    } else free.push(a);
  }
  let tokens: number | undefined;
  if (flags["--tokens"] !== undefined) {
    if (!/^\d+$/.test(flags["--tokens"]) || !Number.isSafeInteger(Number(flags["--tokens"]))) return { error: "--tokens must be a whole number of 0 or more" };
    tokens = Number(flags["--tokens"]);
  }
  const opt = <K extends string, V>(k: K, v: V | undefined) => (v === undefined ? {} : ({ [k]: v } as Record<K, V>));
  switch (action) {
    case "start":
      if (free.length !== 1) return { error: "session start takes one issue number or work item id" };
      return { action, ref: free[0]!, ...opt("as", flags["--as"]), ...opt("spec", flags["--spec"]), ...opt("transcript", flags["--transcript"]) };
    case "status":
    case "finish":
    case "abandon": {
      if (free.length > 1) return { error: `session ${action} takes at most one work item id` };
      const id = flags["--item"] ?? free[0];
      if (action === "status") return { action, ...opt("id", id) };
      return { action, ...opt("id", id), ...opt("tokens", tokens) };
    }
    case "note": {
      const text = free.join(" ").trim();
      if (!text && tokens === undefined && flags["--transcript"] === undefined) return { error: "session note needs a text" };
      return { action, text, ...opt("id", flags["--item"]), ...opt("tokens", tokens), ...opt("transcript", flags["--transcript"]) };
    }
  }
  return { error: `unknown session command: ${action}` };
}

/** One JSON file per open session under `dir`, keyed by item id. Local to this machine: the store holds the run. */
export function fileSessions(dir: string): SessionFiles {
  const path = (id: string) => join(dir, `${id.replace(/[^A-Za-z0-9_-]/g, "_")}.json`);
  return {
    async read(id: WorkItemId) {
      try {
        return JSON.parse(await readFile(path(id), "utf8")) as SessionRecord;
      } catch {
        return null;
      }
    },
    async write(r: SessionRecord) {
      await mkdir(dir, { recursive: true, mode: 0o700 });
      await writeFile(path(r.work_item_id), JSON.stringify(r, null, 2), { mode: 0o600 });
    },
    async remove(id: WorkItemId) {
      await rm(path(id), { force: true });
    },
    async list() {
      const names = await readdir(dir).catch(() => [] as string[]);
      const out: SessionRecord[] = [];
      for (const n of names.filter((f) => f.endsWith(".json")).sort()) {
        try {
          out.push(JSON.parse(await readFile(join(dir, n), "utf8")) as SessionRecord);
        } catch {
          // A half-written file is not a session.
        }
      }
      return out;
    },
  };
}

/** Runs one `factory session` command. `start` returns when `signal` aborts (Ctrl-C) or the session ends. */
export async function runSession(
  loaded: Loaded,
  a: SessionAction,
  print: (line: string) => void,
  signal: AbortSignal,
): Promise<number> {
  const parts = await buildSessionParts(loaded);
  try {
    const { owner, name } = parts.config.repo;
    const sessions = new Sessions({
      store: parts.store,
      sandbox: parts.sandbox,
      broker: parts.broker,
      scanner: parts.scanner,
      clock: parts.clock,
      config: parts.config,
      toolEnv: baseEnv(),
      files: fileSessions(join(loaded.stateDir, "sessions")),
      issue: async (n) => {
        try {
          const i = await parts.github.request<{ title: string; body: string | null; pull_request?: unknown }>("GET", `/repos/${owner}/${name}/issues/${n}`);
          return i.pull_request ? null : { title: i.title, body: i.body ?? "" };
        } catch {
          return null;
        }
      },
      owner: `session:${hostname()}:${process.pid}` as WorkerId,
    });
    const done = (r: { ok: boolean; lines: string[] }) => {
      for (const l of r.lines) print(l);
      return r.ok ? 0 : 1;
    };
    switch (a.action) {
      case "start": {
        // The person, mapped to a user ID the way commands map commenters; `start` needs write permission.
        const login = a.as ?? owner;
        let subject: string;
        try {
          subject = String((await parts.github.request<{ id: number }>("GET", `/users/${encodeURIComponent(login)}`)).id);
        } catch {
          print(`session start refused: GitHub has no user ${login}`);
          return 1;
        }
        const principal = await parts.auth.resolve({ provider: "github", subject, login });
        if (!principal) {
          print(`session start refused: ${login} is not linked to a factory user`);
          return 1;
        }
        const allowed = await parts.auth.authorize(principal, "approve_spec", { kind: "project", id: parts.config.project.key });
        if (!allowed.allow) {
          print(`session start refused: it needs write permission on ${owner}/${name} (\`${allowed.reason}\`)`);
          return 1;
        }
        const spec = a.spec === undefined ? undefined : await readFile(a.spec, "utf8");
        const r = await sessions.start({
          ref: a.ref,
          actor: principal.user_id,
          ...(spec === undefined ? {} : { spec }),
          ...(a.transcript === undefined ? {} : { transcript: a.transcript }),
        });
        const code = done(r);
        if (!r.record) return code;
        const end = await sessions.keepAlive(r.record, signal);
        print(end === "ended" ? "the session ended (finished, abandoned or lost); the lease is no longer renewed" : "stopped renewing the lease; the session ends when it expires");
        return code;
      }
      case "status":
        return done(await sessions.status(a.id));
      case "note":
        return done(await sessions.note(a.text, {
          ...(a.id === undefined ? {} : { id: a.id }),
          ...(a.tokens === undefined ? {} : { tokens: a.tokens }),
          ...(a.transcript === undefined ? {} : { transcript: a.transcript }),
        }));
      case "finish":
      case "abandon": {
        const opts = { ...(a.id === undefined ? {} : { id: a.id }), ...(a.tokens === undefined ? {} : { tokens: a.tokens }) };
        return done(a.action === "finish" ? await sessions.finish(opts) : await sessions.abandon(opts));
      }
    }
  } finally {
    await parts.close();
  }
}
