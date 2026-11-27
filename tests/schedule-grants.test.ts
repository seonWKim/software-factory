// Feedback schedule grants (design 08-schedules): browser, notes, repo and shell, each checked and handed out by the
// ScheduleGrantBroker (a ToolBroker). No test reaches the network or a real repo; the deps are fakes, except one test
// that runs the real sqlite3 binary (skipped when sqlite3 is not on PATH).

import { execFile, execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import {
  type GrantBrokerDeps, SCHEDULE_SHELL_COMMAND, SQLITE_TOOL, ScheduleGrantBroker, grantWords, grantsOfWords, notesFolder, scheduleGrantTools, scheduleIdProblem, storedGrants, storedScheduleGrants,
  SCHEDULE_PASSPORT_KIND, withSchedulePassports,
} from "../src/core/schedule-grants.js";
import type { ToolBroker } from "../src/interfaces/tool-broker.js";
import { type ToolContext, guardPolicy } from "../src/core/tools/index.js";
import { READ_TOOLS } from "../src/worker/index.js";
import { PassportService, REVOCATIONS_TICK, secretKeyring } from "../src/identity/index.js";
import { PassportToolBroker } from "../src/impl/broker/passport-broker.js";
import { SqliteDriver } from "../src/impl/store/sqlite/sqlite-driver.js";
import { ManualTickGenerator } from "../src/shared/ticks/plugins/manual/manual-tick-generator.js";
import { RunPassports } from "../src/worker/passports/run-passports.js";

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

  it("a notes grant on an ID that is no plain folder name is refused before any folder is made", async () => {
    expect(notesFolder("daily-review")).toBe(".factory/notes/daily-review/");
    for (const id of ["../..", "..", ".", "a/b", "a b", "", ".hidden", "-x", "A1", "x".repeat(65)]) {
      expect(scheduleIdProblem(id)).not.toBeNull();
      expect(() => notesFolder(id)).toThrow(/schedule ID/);
      const { d, made } = deps();
      await expect(new ScheduleGrantBroker(id, [{ kind: "notes" }], d).handOut(base)).rejects.toThrow(/schedule ID/);
      expect(made).toEqual([]);
    }
  });

  it("a repo grant runs in the named repo; one that is no git repo or lies in the state folder is refused", async () => {
    const run = await new ScheduleGrantBroker("s1", [{ kind: "repo", path: "/src/other", base_ref: "dev" }], deps().d).handOut(base);
    expect(run).toMatchObject({ repo: "/src/other", base_ref: "dev" });
    await expect(new ScheduleGrantBroker("s1", [{ kind: "repo", path: "/src/other", base_ref: "dev" }], deps({ exists: () => false }).d).handOut(base)).rejects.toThrow(/no git repo/);
    await expect(new ScheduleGrantBroker("s1", [{ kind: "repo", path: "/factory/.factory/x", base_ref: "main" }], deps().d).handOut(base)).rejects.toThrow(/state folder/);
  });

  it("a shell grant hands out the broker tool, which runs sqlite3 -safe -readonly through the broker's call, and nothing else", async () => {
    const { d, ran } = deps();
    const broker = new ScheduleGrantBroker("s1", [{ kind: "shell", command: SCHEDULE_SHELL_COMMAND, db: "/data/app.db" }], d);
    expect(broker.listTools([SQLITE_TOOL]).map((t) => [t.name, t.read_only])).toEqual([[SQLITE_TOOL, true]]);
    const run = await broker.handOut(base);
    expect(run.tool_grants).toEqual([SQLITE_TOOL]);
    expect(run.tools.map((t) => t.name)).toEqual(["Read", "Glob", "Grep"]);
    expect(await broker.call(ctxCall, SQLITE_TOOL, { sql: "select 1" })).toEqual({ ok: true, content: "1|ok\n" });
    expect(ran).toEqual([{ file: "sqlite3", args: ["-safe", "-readonly", "/data/app.db", "select 1"] }]);
    for (const sql of [".shell rm -rf /", "select writefile('/x', 'y')", "attach '/other.db' as o", "select load_extension('x')", "vacuum into '/any/dir/out.db'", "VACUUM main INTO '/x.db'", "-version", "  -A x", "-unsafe-testing",
      "select data from fsdir('/x')", "select name, data from FSDIR ('/Users/o/.config/software-factory/.env')", "select * from \"fsdir\"('/x')",
      "select * from zipfile('/x.zip')", "select sqlar_uncompress(data, 1) from t", "select sqlar_compress('x')", "select lsmode(1)", "select readfile('/x')",
      "with x as (select 1) select data from fsdir('/x')", "select 1; delete from t", "update t set a = 1", "create table t (a)", "pragma writable_schema = 1", "/* c */ select 1", "select 1\n.shell id"]) {
      expect(await broker.call(ctxCall, SQLITE_TOOL, { sql })).toMatchObject({ ok: false, error_code: "refused" });
    }
    for (const sql of ["with t as (select 1) select * from t;", "EXPLAIN select 1", "pragma table_info(t)"]) {
      expect(await broker.call(ctxCall, SQLITE_TOOL, { sql })).toMatchObject({ ok: true });
    }
    expect(await new ScheduleGrantBroker("s1", [], d).call(ctxCall, SQLITE_TOOL, { sql: "select 1" })).toMatchObject({ ok: false, error_code: "not_granted" });
    expect(ran).toHaveLength(4);
  });
});

describe("scheduleGrantTools: the runner's broker with the shell grant's tool", () => {
  const inner: ToolBroker = {
    listTools: (g) => (g.includes("forge.read") ? [{ name: "forge.read", description: "", input_schema: {}, read_only: true }] : []),
    allTools: () => [{ name: "forge.read", description: "", input_schema: {}, read_only: true }],
    call: async (_c, name) => ({ ok: true, content: `inner ${name}` }),
  };
  const shell = { kind: "shell", command: SCHEDULE_SHELL_COMMAND, db: "/data/app.db" } as const;

  it("lists the tool only when granted, and serves it from the run's schedule's stored grants", async () => {
    const { d, ran } = deps();
    const asked: string[] = [];
    const broker = scheduleGrantTools(inner, async (id) => (asked.push(id), id === "s1" ? [shell] : []), d);
    expect(broker.listTools(["forge.read"]).map((t) => t.name)).toEqual(["forge.read"]);
    expect(broker.listTools(["forge.read", SQLITE_TOOL]).map((t) => t.name)).toEqual(["forge.read", SQLITE_TOOL]);
    expect(await broker.call({ ...ctxCall, work_item_id: "schedule:s1" as never }, SQLITE_TOOL, { sql: "select 1" })).toEqual({ ok: true, content: "1|ok\n" });
    expect(ran).toEqual([{ file: "sqlite3", args: ["-safe", "-readonly", "/data/app.db", "select 1"] }]);
    expect(await broker.call({ ...ctxCall, work_item_id: "schedule:s2" as never }, SQLITE_TOOL, { sql: "select 1" })).toMatchObject({ ok: false, error_code: "not_granted" });
    expect(await broker.call({ ...ctxCall, work_item_id: "wi_1" as never }, SQLITE_TOOL, { sql: "select 1" })).toMatchObject({ ok: false, error_code: "not_granted" });
    expect(asked).toEqual(["s1", "s2"]);
    expect(await broker.call(ctxCall, "forge.read", {})).toEqual({ ok: true, content: "inner forge.read" });
  });

  it("reads the grants of the feedback schedule with the ID from the store, none for another kind", async () => {
    const store = { listSchedules: async () => [
      { id: "s1", action: { kind: "feedback", settings: { prompt: "p", grants: [shell] } } },
      { id: "s2", action: { kind: "agent", settings: { prompt: "p", grants: [shell] } } },
    ] as never };
    expect(await storedScheduleGrants(store)("s1")).toEqual([shell]);
    expect(await storedScheduleGrants(store)("s2")).toEqual([]);
    expect(await storedScheduleGrants(store)("s3")).toEqual([]);
  });

  it("refuses the call when the schedule's stored grants are refused", async () => {
    const broker = scheduleGrantTools(inner, async () => { throw new Error("the schedule's grant is refused: unknown grant"); }, deps().d);
    expect(await broker.call({ ...ctxCall, work_item_id: "schedule:s1" as never }, SQLITE_TOOL, { sql: "select 1" })).toMatchObject({ ok: false, error_code: "not_granted" });
  });
});

describe("the shell grant's tool inside the G2 guard", () => {
  const shell = { kind: "shell", command: SCHEDULE_SHELL_COMMAND, db: "/data/app.db" } as const;

  async function setup() {
    const db = new SqliteDriver(":memory:");
    await db.migrate();
    const ticks = new ManualTickGenerator();
    let n = 0;
    const identity = new PassportService({ db, keys: secretKeyring({ get: async () => ({ reveal: () => "k".repeat(40) }) }, { current: "K" }), providers: [], ticks, newId: () => `pp_${++n}` });
    await ticks.tick(REVOCATIONS_TICK, Date.parse("2026-11-25T12:00:00.000Z"));
    const passports = new RunPassports(identity);
    const { d, ran } = deps();
    const inner: ToolBroker = { listTools: () => [], allTools: () => [], call: async (_c, name) => ({ ok: true, content: name }) };
    const broker = new PassportToolBroker(scheduleGrantTools(inner, async (id) => (id === "s1" || id === "s2" ? [shell] : []), d), { checker: identity, passportOf: (run) => passports.passportOf(run) });
    const audit = () => db.all("SELECT action, decision, reason FROM authz_audit ORDER BY seq");
    return { identity, passports, broker, ran, audit };
  }
  const spec = (id: string, tool_grants: string[]) => ({ run_id: `schedule_${id}_x`, work_item_id: `schedule:${id}`, lease_token: 0, tool_grants }) as never;
  const ctxOf = (id: string) => ({ run_id: `schedule_${id}_x` as never, work_item_id: `schedule:${id}` as never, lease_token: 0 });

  it("passes a schedule run's own granted call, audited, with the passport minted for the run and dropped after it", async () => {
    const t = await setup();
    let during: unknown;
    const runner = withSchedulePassports({ run: async () => {
      during = await t.broker.call(ctxOf("s1"), SQLITE_TOOL, { sql: "select 1" });
      return {} as never;
    } }, t.passports, "proj");
    await runner.run(spec("s1", [SQLITE_TOOL]));
    expect(during).toEqual({ ok: true, content: "1|ok\n" });
    expect(t.ran).toHaveLength(1);
    expect(await t.audit()).toEqual([{ action: "use_tool", decision: "allow", reason: "allowed" }]);
    expect(t.passports.passportOf("schedule_s1_x")).toBeNull();
  });

  it("refuses and audits a sqlite_readonly call without a matching passport, and refuses one with none", async () => {
    const t = await setup();
    expect(await t.broker.call(ctxOf("s1"), SQLITE_TOOL, { sql: "select 1" })).toMatchObject({ ok: false, error_code: "passport_missing" });
    // A passport minted for schedule s2's run, presented for s1's: its runs and items do not match.
    await t.passports.begin({ run: "schedule_s2_x", lease_token: 0, kind: SCHEDULE_PASSPORT_KIND, item: "schedule:s2", project: "proj", branch: "schedule/schedule_s2_x", grants: [SQLITE_TOOL] });
    const s2 = t.passports.passportOf("schedule_s2_x");
    const borrowed = new PassportToolBroker(scheduleGrantTools({ listTools: () => [], allTools: () => [], call: async () => ({ ok: true, content: "" }) }, async () => [shell], deps().d),
      { checker: t.identity, passportOf: () => s2 });
    expect(await borrowed.call(ctxOf("s1"), SQLITE_TOOL, { sql: "select 1" })).toMatchObject({ ok: false, error_code: "passport_denied" });
    // A schedule run whose passport does not name the tool.
    await t.passports.begin({ run: "schedule_s1_x", lease_token: 0, kind: SCHEDULE_PASSPORT_KIND, item: "schedule:s1", project: "proj", branch: "schedule/schedule_s1_x", grants: ["forge.read"] });
    expect(await t.broker.call(ctxOf("s1"), SQLITE_TOOL, { sql: "select 1" })).toMatchObject({ ok: false, error_code: "passport_denied", message: `${SQLITE_TOOL}: outside_tools` });
    expect(t.ran).toEqual([]);
    const rows = await t.audit() as { decision: string }[];
    expect(rows.filter((r) => r.decision === "deny")).toHaveLength(2);
    expect(rows.some((r) => r.decision === "allow")).toBe(false);
  });

  it("mints no passport for a run with no broker tools or another item", async () => {
    const begun: string[] = [];
    const runner = withSchedulePassports({ run: async () => ({}) as never }, { begin: async (r) => void begun.push(r.run), end: () => {} }, "proj");
    await runner.run(spec("s1", []));
    await runner.run({ run_id: "run_1", work_item_id: "wi_1", lease_token: 1, tool_grants: [SQLITE_TOOL] } as never);
    expect(begun).toEqual([]);
  });
});

describe.skipIf(!sqlite3OnPath())("the shell grant on the real sqlite3 binary", () => {
  it("runs -safe -readonly: a SELECT answers; fsdir('/etc/hosts') and VACUUM INTO are refused and no file is made", async () => {
    const dir = mkdtempSync(join(tmpdir(), "grant-sqlite-"));
    try {
      const db = join(dir, "app.db");
      execFileSync("sqlite3", [db, "create table t (a); insert into t values (7);"]);
      const exec: GrantBrokerDeps["exec"] = async (file, args) => (await promisify(execFile)(file, [...args])).stdout;
      const broker = new ScheduleGrantBroker("s1", [{ kind: "shell", command: SCHEDULE_SHELL_COMMAND, db }], { exists: existsSync, mkdir: async () => {}, exec });
      expect(await broker.call(ctxCall, SQLITE_TOOL, { sql: "select a from t" })).toEqual({ ok: true, content: "7\n" });
      const out = join(dir, "out.db");
      expect(await broker.call(ctxCall, SQLITE_TOOL, { sql: "select name, data from fsdir('/etc/hosts')" })).toMatchObject({ ok: false });
      expect(await broker.call(ctxCall, SQLITE_TOOL, { sql: `vacuum into '${out}'` })).toMatchObject({ ok: false });
      expect(existsSync(out)).toBe(false);
      expect(readdirSync(dir)).toEqual(["app.db"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

function sqlite3OnPath(): boolean {
  try {
    execFileSync("sqlite3", ["-version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}
