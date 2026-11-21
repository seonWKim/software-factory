import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { SessionParts } from "../src/compose.js";
import { StoredLearnedSettings } from "../src/core/learned-settings.js";
import { settingValues } from "../src/core/settings.js";
import { splitThresholds } from "../src/core/split.js";
import type { Timestamp, UserId } from "../src/core/types.js";
import { FakeClock } from "../src/impl/clock/fake-clock.js";
import type { FactoryStore } from "../src/interfaces/factory-store.js";
import { SESSION_USAGE, type SessionWho, runSession, sessionDeps } from "../src/session-cmd.js";
import { FakeAuth, FakeSandbox } from "./helpers/fakes/runner.js";
import { FakeBroker } from "./helpers/fakes/broker.js";
import { PROJECT, cleanScanner, config } from "./helpers/fakes/config.js";
import { newStore } from "./helpers/store.js";

// A session built through sessionDeps reads the learned layer (design 08-settings) as a run does.

/** A spec of 100 lines in one file: under the split threshold of the default limit, over the one of a learned limit of 100. */
const SPEC = {
  in_short: "AS-IS: nothing.\nTO-BE: something.", problem: "Fix the widget", done_criteria: ["the widget works"], desired_output: "a PR",
  scope: "the widget only", allowed_paths: ["src/a/"], files_to_change: ["src/a/x.ts"], tier: 2, tier_reason: "small", estimated_lines: 100, estimated_files: 1,
};

async function parts(store: FactoryStore, clock: FakeClock): Promise<{ parts: SessionParts; learned: StoredLearnedSettings }> {
  const learned = new StoredLearnedSettings(store);
  await learned.refresh();
  // GitHub knows the person and no issue: a start that passes the spec check stops at the issue lookup.
  const github = { request: async <T>(_m: string, path: string) => (path.startsWith("/users/") ? { id: 1 } : {}) as T } as unknown as SessionParts["github"];
  const broker = new FakeBroker();
  const sandbox = new FakeSandbox();
  return {
    learned,
    parts: {
      clock, store, scanner: cleanScanner, sandbox, broker, auth: new FakeAuth(), github, config, local: { broker, sandbox } as unknown as SessionParts["local"],
      learned, close: async () => {},
    },
  };
}

/** No cli_user, git and the OS name nobody, the GitHub source off. */
const NOBODY: SessionWho = { cliUser: null, env: { gitEmail: null, osUser: null }, githubSource: false };

async function start(p: SessionParts): Promise<string[]> {
  const lines: string[] = [];
  const d = { ...sessionDeps(p, mkdtempSync(join(tmpdir(), "session-cmd-")), new AbortController().signal, { ...NOBODY, cliUser: "github:1" as UserId }), readSpec: async () => JSON.stringify(SPEC), print: (l: string) => lines.push(l) };
  await runSession(d, { cmd: "start", target: "7", spec: "spec.json" });
  return lines;
}

describe("factory session through sessionDeps", () => {
  it("a session gets the learned max_diff_lines for its project, as a run does", async () => {
    const clock = new FakeClock();
    const { store } = await newStore(clock);
    await store.setLearnedSetting({
      project: PROJECT.key, key: "max_diff_lines", expected: null, value: "100", evidence_run_ids: [], window_end: "2026-03-05T00:00:00.000Z" as Timestamp, actor: "improver",
    });
    const { parts: p, learned } = await parts(store, clock);
    const limits = settingValues(PROJECT.key, config.settings, learned);
    expect(limits.max_diff_lines).toBe(100);
    const lines = (await start(p)).join("\n");
    expect(lines).toContain("refused: the --spec file is not a valid spec");
    expect(lines).toContain(`(${splitThresholds(limits).lines} lines or`);
  });

  it("with no learned value the project's limit applies and the same spec passes the split check", async () => {
    const clock = new FakeClock();
    const { store } = await newStore(clock);
    const { parts: p } = await parts(store, clock);
    expect((await start(p)).join("\n")).not.toContain("phases");
  });

  it("an interactive task on a local item gets the local route (its broker and sandbox), so local tasks are not refused", async () => {
    const clock = new FakeClock();
    const { store } = await newStore(clock);
    const { parts: p } = await parts(store, clock);
    const deps = sessionDeps(p, mkdtempSync(join(tmpdir(), "session-cmd-")), new AbortController().signal, NOBODY);
    // Without it, Sessions.forgeForLocal refuses every local item (a local item is committed only through the local broker).
    expect((deps.sessions as unknown as { d: { local?: unknown } }).d.local).toBe(p.local);
  });

  it("the CLI takes `interactive` and keeps `session` as the same command, and its help names interactive tasks", async () => {
    const { default: command } = await import("../src/cli/handlers/session/session.command.js");
    expect(command.names).toEqual(["interactive", "session"]);
    expect(SESSION_USAGE).toMatch(/^factory interactive start/);
    expect(SESSION_USAGE).toContain("an interactive task");
  });
});

/** A start through sessionDeps whose Sessions only records the person; `users` are the GitHub accounts by login. */
async function startAs(who: SessionWho, as?: string, users: Record<string, number> = {}) {
  const { parts: p } = await parts((await newStore(new FakeClock())).store, new FakeClock());
  const requests: string[] = [];
  const github = {
    request: async <T>(_m: string, path: string): Promise<T> => {
      requests.push(path);
      const login = path.replace(/^\/users\//, "");
      return login in users ? ({ id: users[login] } as T) : Promise.reject(new Error("network_unavailable"));
    },
  } as unknown as SessionParts["github"];
  const persons: unknown[] = [];
  const lines: string[] = [];
  const d = {
    ...sessionDeps({ ...p, github }, mkdtempSync(join(tmpdir(), "session-cmd-")), new AbortController().signal, who),
    sessions: { start: async (o: { person: unknown }) => (persons.push(o.person), { ok: true, lines: [] }) } as never, print: (l: string) => lines.push(l),
  };
  const code = await runSession(d, { cmd: "start", target: "7", ...(as === undefined ? {} : { as }) });
  return { code, person: persons[0], requests, text: lines.join("\n") };
}

describe("the person a session start acts as", () => {
  const env = { gitEmail: "Me@Example.com", osUser: "me" };

  it("with no --as and the GitHub source off, starts as the CLI identity with no GitHub request", async () => {
    expect(await startAs({ ...NOBODY, env })).toEqual({ code: 0, person: { provider: "local", subject: "me@example.com" }, requests: [], text: "" });
  });

  it("with no --as and the GitHub source on, still makes no GitHub request: a github: cli_user is that account", async () => {
    const r = await startAs({ cliUser: "github:42" as UserId, env, githubSource: true });
    expect([r.code, r.person, r.requests]).toEqual([0, { provider: "github", subject: "42" }, []]);
  });

  it("takes cli_user, else git user.email, else the OS user, else anonymous", async () => {
    expect((await startAs({ ...NOBODY, cliUser: "local:boss" as UserId, env })).person).toEqual({ provider: "local", subject: "boss" });
    expect((await startAs({ ...NOBODY, env })).person).toEqual({ provider: "local", subject: "me@example.com" });
    expect((await startAs({ ...NOBODY, env: { gitEmail: null, osUser: "me" } })).person).toEqual({ provider: "local", subject: "me" });
    expect((await startAs(NOBODY)).person).toEqual({ provider: "local", subject: "anonymous" });
  });

  it("with --as and the GitHub source on, looks the login up and uses its numeric id; an unknown login is refused with the fix", async () => {
    const found = await startAs({ ...NOBODY, env, githubSource: true }, "alice", { alice: 7 });
    expect([found.code, found.person, found.requests]).toEqual([0, { provider: "github", subject: "7", login: "alice" }, ["/users/alice"]]);
    const missing = await startAs({ ...NOBODY, env, githubSource: true }, "nobody");
    expect([missing.code, missing.person, missing.requests]).toEqual([1, undefined, ["/users/nobody"]]);
    expect(missing.text).toMatch(/^refused: .*"nobody".*check the login, or start without --as/);
  });

  it("with --as and the GitHub source off, is refused naming the fix, with no GitHub request", async () => {
    const r = await startAs({ ...NOBODY, env }, "alice", { alice: 7 });
    expect([r.code, r.person, r.requests]).toEqual([1, undefined, []]);
    expect(r.text).toMatch(/^refused: .*turn it on .*github-issues.*plugins\.source.*or start without --as/);
  });

  it("the usage names the CLI identity and what --as needs", () => {
    expect(SESSION_USAGE).toContain("you act as the CLI identity");
    expect(SESSION_USAGE).toContain("--as <login>");
  });
});
