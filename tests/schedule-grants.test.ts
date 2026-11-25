// Feedback schedule grants (design 08-schedules): browser, notes, repo and shell, each checked and handed out by the
// ScheduleGrantBroker (a ToolBroker). No test reaches the network, a real repo or a real sqlite3: the deps are fakes.

import { describe, expect, it } from "vitest";
import {
  type GrantBrokerDeps, SCHEDULE_SHELL_COMMAND, SQLITE_TOOL, ScheduleGrantBroker, grantWords, grantsOfWords, notesFolder, storedGrants,
} from "../src/core/schedule-grants.js";
import { type ToolContext, guardPolicy } from "../src/core/tools/index.js";
import { READ_TOOLS } from "../src/worker/index.js";

const base = { tools: READ_TOOLS, repo: "/factory", base_ref: "main" };
const ctxCall = { run_id: "r" as never, work_item_id: "w" as never, lease_token: 0 };

function deps(over: Partial<GrantBrokerDeps> = {}) {
  const made: string[] = [], ran: { file: string; args: readonly string[] }[] = [];
  const d: GrantBrokerDeps = {
    exists: () => true,
    mkdir: async (p) => void made.push(p),
    exec: async (file, args) => (ran.push({ file, args }), "1|ok\n"),
    ...over,
  };
  return { d, made, ran };
}

const toolCtx = (fetch?: ToolContext["fetch"]): ToolContext => ({
  sandbox: {} as never, handle: {} as never,
  policy: guardPolicy({ workdir: "/run", deny_paths: [], writable_paths: [], env_allowlist: {} }),
  ...(fetch ? { fetch } : {}),
});

describe("grant words", () => {
  it("parses each grant, and none clears them", () => {
    expect(grantsOfWords(["browser=http://localhost:5173/", "notes", "repo=/src/other#dev", "shell=/data/app.db"])).toEqual([
      { kind: "browser", url: "http://localhost:5173/" },
      { kind: "notes" },
      { kind: "repo", path: "/src/other", base_ref: "dev" },
      { kind: "shell", command: SCHEDULE_SHELL_COMMAND, db: "/data/app.db" },
    ]);
    expect(grantsOfWords(["repo=/src/other"])).toEqual([{ kind: "repo", path: "/src/other", base_ref: "main" }]);
    expect(grantsOfWords(["none"])).toEqual([]);
  });

  it("refuses a URL off the sandbox, a repo in the state folder, a relative path, a twice-given kind and an unknown word", () => {
    expect(grantsOfWords(["browser=https://example.com/"])).toMatchObject({ problem: expect.stringContaining("sandbox URL") });
    expect(grantsOfWords(["browser=http://u:p@localhost/"])).toMatchObject({ problem: expect.stringContaining("credentials") });
    expect(grantsOfWords(["repo=/home/me/app/.factory/x"])).toMatchObject({ problem: expect.stringContaining("state folder") });
    expect(grantsOfWords(["repo=other"])).toMatchObject({ problem: expect.stringContaining("absolute") });
    expect(grantsOfWords(["notes", "notes"])).toMatchObject({ problem: expect.stringContaining("one notes grant") });
    expect(grantsOfWords(["bash=ls"])).toMatchObject({ problem: expect.stringContaining("unknown grant") });
  });

  it("refuses a stored shell grant with any command but sqlite3 -readonly", () => {
    expect(() => storedGrants({ grants: [{ kind: "shell", command: "sqlite3", db: "/d.db" }] })).toThrow(/only sqlite3 -readonly/);
    expect(storedGrants({})).toEqual([]);
  });

  it("says each grant in plain words", () => {
    expect(grantWords({ kind: "browser", url: "http://localhost:5173/" }, "s1")).toBe("browser: Browse may read only http://localhost:5173/");
    expect(grantWords({ kind: "notes" }, "s1")).toBe("notes: may write only in .factory/notes/s1/");
    expect(grantWords({ kind: "repo", path: "/src/other", base_ref: "main" }, "s1")).toBe("repo: its agent runs in /src/other (main) and no other");
    expect(grantWords({ kind: "shell", command: SCHEDULE_SHELL_COMMAND, db: "/d.db" }, "s1")).toBe("shell: only sqlite3 -readonly /d.db");
  });
});

describe("ScheduleGrantBroker.handOut", () => {
  it("hands out only the read-only tools with no grant: no Browse", async () => {
    const run = await new ScheduleGrantBroker("s1", [], deps().d).handOut(base);
    expect(run.tools.map((t) => t.name)).toEqual(["Read", "Glob", "Grep"]);
    expect(run).toMatchObject({ repo: "/factory", base_ref: "main", writable_paths: [] });
  });

  it("a browser grant adds Browse, which fetches the sandbox URL only", async () => {
    const run = await new ScheduleGrantBroker("s1", [{ kind: "browser", url: "http://localhost:5173/" }], deps().d).handOut(base);
    const browse = run.tools.find((t) => t.name === "Browse")!;
    const fetched: string[] = [];
    const fetch = async (url: string) => (fetched.push(url), new Response("page"));
    expect(await browse.run({}, toolCtx(fetch))).toMatchObject({ ok: true, content: "page" });
    expect(await browse.run({ url: "http://evil.example/" }, toolCtx(fetch))).toMatchObject({ ok: false });
    expect(fetched).toEqual(["http://localhost:5173/"]);
  });

  it("a notes grant creates .factory/notes/<id>/ and writes only inside it", async () => {
    const { d, made } = deps();
    const run = await new ScheduleGrantBroker("s1", [{ kind: "notes" }], d).handOut(base);
    const folder = `/factory/${notesFolder("s1")}`.replace(/\/$/, "");
    expect(made).toEqual([folder]);
    expect(run.writable_paths).toEqual([folder]);
    const write = run.tools.find((t) => t.name === "Write")!, edit = run.tools.find((t) => t.name === "Edit")!;
    for (const tool of [write, edit]) {
      expect(await tool.run({ file_path: "/run/src/x.ts", content: "x", old_string: "a", new_string: "b" }, toolCtx())).toMatchObject({ ok: false, error: expect.stringContaining("only inside the notes folder") });
      expect(await tool.run({ file_path: "/factory/.factory/notes/s2/x.md", content: "x", old_string: "a", new_string: "b" }, toolCtx())).toMatchObject({ ok: false, error: expect.stringContaining("only inside the notes folder") });
    }
  });

  it("a repo grant runs in the named repo; one that is no git repo or lies in the state folder is refused", async () => {
    const run = await new ScheduleGrantBroker("s1", [{ kind: "repo", path: "/src/other", base_ref: "dev" }], deps().d).handOut(base);
    expect(run).toMatchObject({ repo: "/src/other", base_ref: "dev" });
    await expect(new ScheduleGrantBroker("s1", [{ kind: "repo", path: "/src/other", base_ref: "dev" }], deps({ exists: () => false }).d).handOut(base)).rejects.toThrow(/no git repo/);
    await expect(new ScheduleGrantBroker("s1", [{ kind: "repo", path: "/factory/.factory/x", base_ref: "main" }], deps().d).handOut(base)).rejects.toThrow(/state folder/);
  });

  it("a shell grant runs sqlite3 -readonly through the broker's call, and nothing else", async () => {
    const { d, ran } = deps();
    const broker = new ScheduleGrantBroker("s1", [{ kind: "shell", command: SCHEDULE_SHELL_COMMAND, db: "/data/app.db" }], d);
    expect(broker.listTools([SQLITE_TOOL]).map((t) => [t.name, t.read_only])).toEqual([[SQLITE_TOOL, true]]);
    const tool = (await broker.handOut(base)).tools.find((t) => t.name === "SqliteReadonly")!;
    expect(await tool.run({ sql: "select 1" }, toolCtx())).toEqual({ ok: true, content: "1|ok\n" });
    expect(ran).toEqual([{ file: "sqlite3", args: ["-readonly", "/data/app.db", "select 1"] }]);
    for (const sql of [".shell rm -rf /", "select writefile('/x', 'y')", "attach '/other.db' as o", "select load_extension('x')"]) {
      expect(await broker.call(ctxCall, SQLITE_TOOL, { sql })).toMatchObject({ ok: false, error_code: "refused" });
    }
    expect(await new ScheduleGrantBroker("s1", [], d).call(ctxCall, SQLITE_TOOL, { sql: "select 1" })).toMatchObject({ ok: false, error_code: "not_granted" });
    expect(ran).toHaveLength(1);
  });
});
