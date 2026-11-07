import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { UserId, WorkItemId } from "../src/core/types.js";
import { FakeClock } from "../src/impl/clock/fake-clock.js";
import { INLINE_STEPS, MysqlMigrations, type Queryable, STEPS_DIR, readSteps } from "../src/impl/store/mysql/migrations.js";
import { MysqlDriver } from "../src/impl/store/mysql/mysql-driver.js";
import { SqlFactoryStore } from "../src/impl/store/sql/sql-factory-store.js";
import { MIGRATIONS } from "../src/impl/store/sqlite/schema.js";
import { SqliteDriver } from "../src/impl/store/sqlite/sqlite-driver.js";
import type { NewWorkItem } from "../src/interfaces/factory-store.js";
import { MYSQL_URL, PROJECT_KEY, mysqlStepsUpTo, newEmptyMysqlDatabase, system } from "./helpers/store.js";

// One thread table for every item and one command inbox (issue #281): SQLite migration 24 and MySQL step 0024 copy
// `item_messages` and `cli_commands` into `item_thread` and `command_inbox`, keeping each row's seq.
// Never pin a step as the newest: a later migration would fail these checks from outside its allowed paths.
const STEP = 24;
const STEP_FILE = "0024-item-thread.sql";
const NEW_TABLES = ["command_inbox", "item_thread"];
const OLD_TABLES = ["cli_commands", "item_messages"];
/** Copy pairs: old table → new table. */
const PAIRS = [
  ["item_messages", "item_thread"],
  ["cli_commands", "command_inbox"],
] as const;

function localItem(n: number): NewWorkItem {
  return {
    source: { type: "local", id: `local-${n}`, link: `local:local-${n}` },
    requester_id: "local:owner" as UserId,
    project: PROJECT_KEY,
    problem: `problem ${n}`,
    resources: [],
  };
}

type Exec = { all(sql: string, params?: unknown[]): Promise<Record<string, unknown>[]>; run(sql: string, params?: unknown[]): Promise<unknown> };

/** Rows written straight into the old tables, as a database from before migration 24 holds them. Seqs have gaps. */
async function seedOldTables(q: Exec, items: WorkItemId[]): Promise<void> {
  const msg = "INSERT INTO item_messages (seq, work_item_id, marker, body, created_at) VALUES (?, ?, ?, ?, ?)";
  await q.run(msg, [3, items[0], "m1", "first", "2026-01-01T00:00:01.000Z"]);
  await q.run(msg, [7, items[1], "m1", "other item", "2026-01-01T00:00:02.000Z"]);
  await q.run(msg, [9, items[0], "m2", "second", "2026-01-01T00:00:03.000Z"]);
  const cmd = "INSERT INTO cli_commands (seq, command_key, actor, command, args, created_at) VALUES (?, ?, ?, ?, ?, ?)";
  await q.run(cmd, [2, "k1", "local:owner", "approve", JSON.stringify({ item: items[0] }), "2026-01-01T00:00:04.000Z"]);
  await q.run(cmd, [5, "k2", "local:owner", "revise", JSON.stringify({ item: items[0], text: "more" }), "2026-01-01T00:00:05.000Z"]);
  await q.run(cmd, [6, "k3", "local:other", "reject", JSON.stringify({ item: items[1] }), "2026-01-01T00:00:06.000Z"]);
}

async function count(q: Exec, table: string): Promise<number> {
  const [r] = await q.all(`SELECT COUNT(*) AS n FROM ${table}`);
  return Number(r!.n);
}

async function allRows(q: Exec, table: string): Promise<Record<string, unknown>[]> {
  return (await q.all(`SELECT * FROM ${table} ORDER BY seq`)).map((r) => ({ ...r, seq: Number(r.seq) }));
}

/** What a cursor saved before the migration read next: the command after `seq` in the old table. */
async function nextOldCommandKey(q: Exec, seq: number): Promise<string | undefined> {
  const [r] = await q.all("SELECT command_key FROM cli_commands WHERE seq > ? ORDER BY seq LIMIT 1", [seq]);
  return r?.command_key as string | undefined;
}

/** Checks the copy: same counts, same rows (seq, content, timestamps), and the store reads them through its methods. */
async function expectCopied(q: Exec, store: SqlFactoryStore, before: Record<string, Record<string, unknown>[]>, items: WorkItemId[]) {
  for (const [from, to] of PAIRS) {
    expect(await count(q, to), to).toBe(await count(q, from));
    expect(await count(q, to), to).toBe(before[from]!.length);
    expect(await allRows(q, to), to).toEqual(before[from]);
  }
  expect((await store.listItemMessages(items[0]!)).map((m) => [m.seq, m.marker, m.body, m.created_at])).toEqual([
    [3, "m1", "first", "2026-01-01T00:00:01.000Z"],
    [9, "m2", "second", "2026-01-01T00:00:03.000Z"],
  ]);
  const cmds = await store.listCliCommandsAfter(0, 10);
  expect(cmds.map((c) => [c.seq, c.key, c.created_at])).toEqual([
    [2, "k1", "2026-01-01T00:00:04.000Z"],
    [5, "k2", "2026-01-01T00:00:05.000Z"],
    [6, "k3", "2026-01-01T00:00:06.000Z"],
  ]);
  expect(cmds[1]).toMatchObject({ actor: "local:owner", command: "revise", args: { item: items[0], text: "more" } });
}

function sqliteExec(driver: SqliteDriver): Exec {
  return { all: (s, p) => driver.all(s, p as never) as never, run: (s, p) => driver.run(s, p as never) };
}

/** A SQLite database as it was at version 23: no new tables, rows in the old ones. */
async function sqliteAt23(): Promise<{ driver: SqliteDriver; store: SqlFactoryStore; items: WorkItemId[] }> {
  const driver = new SqliteDriver(":memory:");
  const store = new SqlFactoryStore(driver, new FakeClock());
  await store.migrate();
  const items = [(await store.createWorkItem(localItem(1), system)).item.id, (await store.createWorkItem(localItem(2), system)).item.id];
  for (const t of NEW_TABLES) await driver.run(`DROP TABLE ${t}`);
  await driver.run("DELETE FROM schema_migrations WHERE version > ?", [STEP - 1]);
  await seedOldTables(sqliteExec(driver), items);
  return { driver, store, items };
}

describe("SQLite migration 24: item thread and command inbox", () => {
  it("migrate() on an empty database reaches the latest migration and creates both tables, empty", async () => {
    expect(MIGRATIONS.length).toBeGreaterThanOrEqual(STEP);
    const driver = new SqliteDriver(":memory:");
    const store = new SqlFactoryStore(driver, new FakeClock());
    await store.migrate();
    expect(await driver.schemaVersion()).toEqual({ applied: MIGRATIONS.length, latest: MIGRATIONS.length });
    const names = await driver.all(
      `SELECT name FROM sqlite_master WHERE type = 'table' AND name IN (${[...NEW_TABLES, ...OLD_TABLES].map(() => "?").join(", ")}) ORDER BY name`,
      [...NEW_TABLES, ...OLD_TABLES],
    );
    expect(names.map((r) => r.name)).toEqual([...NEW_TABLES, ...OLD_TABLES].sort());
    for (const t of NEW_TABLES) expect(await count(sqliteExec(driver), t)).toBe(0);
    await store.close();
  });

  it("a database at version 23 with rows: the copy keeps every row, its seq, content and timestamps", async () => {
    const { driver, store, items } = await sqliteAt23();
    const q = sqliteExec(driver);
    const before = { item_messages: await allRows(q, "item_messages"), cli_commands: await allRows(q, "cli_commands") };
    const cursor = 2; // saved before the migration: the last command read was seq 2
    const nextBefore = await nextOldCommandKey(q, cursor);

    await store.migrate();
    expect(await driver.schemaVersion()).toEqual({ applied: MIGRATIONS.length, latest: MIGRATIONS.length });
    await expectCopied(q, store, before, items);
    const [next] = await store.listCliCommandsAfter(cursor, 1);
    expect(next?.key).toBe(nextBefore);
    expect(next).toMatchObject({ seq: 5, key: "k2" });
    await store.close();
  });

  it("after the copy the store writes only the new tables; a new command's seq follows the copied ones", async () => {
    const { driver, store, items } = await sqliteAt23();
    await store.migrate();
    const q = sqliteExec(driver);
    const oldCounts = await Promise.all(OLD_TABLES.map((t) => count(q, t)));
    const { command } = await store.appendCliCommand({ key: "k4", actor: "local:owner", command: "approve", args: {} });
    expect(command.seq).toBeGreaterThan(6);
    expect(await store.appendCliCommand({ key: "k1", actor: "local:owner", command: "x", args: {} })).toMatchObject({ created: false, command: { seq: 2 } });
    expect((await store.recordItemMessage({ work_item_id: items[0]!, marker: "m1", body: "again" })).created).toBe(false);
    expect((await store.recordItemMessage({ work_item_id: items[0]!, marker: "m3", body: "third" })).message.seq).toBeGreaterThan(9);
    expect(await Promise.all(OLD_TABLES.map((t) => count(q, t)))).toEqual(oldCounts);
    expect((await store.listCliCommandsAfter(6, 10)).map((c) => c.key)).toEqual(["k4"]);
    await store.close();
  });

  it("is safe to run again after the recorded version is set back: no row is copied twice", async () => {
    const { driver, store, items } = await sqliteAt23();
    const q = sqliteExec(driver);
    const before = { item_messages: await allRows(q, "item_messages"), cli_commands: await allRows(q, "cli_commands") };
    await store.migrate();
    await driver.run("DELETE FROM schema_migrations WHERE version > ?", [STEP - 1]);
    await store.migrate();
    expect(await driver.schemaVersion()).toEqual({ applied: MIGRATIONS.length, latest: MIGRATIONS.length });
    await expectCopied(q, store, before, items);
    await store.close();
  });
});

describe("the store reads and writes only the new tables", () => {
  it("no SQL statement in the store names item_messages or cli_commands; the docs name the new tables", () => {
    const store = readFileSync(join(process.cwd(), "src/impl/store/sql/sql-factory-store.ts"), "utf8");
    for (const t of OLD_TABLES) expect(store, t).not.toMatch(new RegExp(`\\b${t}\\b`));
    for (const t of NEW_TABLES) expect(store, t).toMatch(new RegExp(`(?:INTO|FROM) ${t}\\b`));
    for (const doc of ["docs/design/05-sources.md", "docs/plugins/source-adapter.md"]) {
      const text = readFileSync(join(process.cwd(), doc), "utf8");
      for (const t of NEW_TABLES) expect(text, `${doc}: ${t}`).toContain(`\`${t}\``);
      for (const t of OLD_TABLES) expect(text, `${doc}: ${t}`).not.toContain(`\`${t}\``);
    }
  });
});

describe("MySQL step 0024: item thread and command inbox", () => {
  const sql = () => readFileSync(join(STEPS_DIR, STEP_FILE), "utf8");

  it("is a .sql file step after 0023, with CREATE TABLE IF NOT EXISTS for both tables", () => {
    const steps = readSteps(STEPS_DIR, INLINE_STEPS);
    expect(steps.find((s) => s.name === "item-thread")).toMatchObject({ number: STEP, from: STEP - 1, kind: "sql", file: STEP_FILE });
    expect(steps.at(-1)!.number).toBeGreaterThanOrEqual(STEP);
    for (const t of NEW_TABLES) expect(sql()).toContain(`CREATE TABLE IF NOT EXISTS ${t} (`);
  });

  it("creates the same columns as SQLite migration 24", () => {
    const columns = (text: string, table: string) => {
      const body = new RegExp(`CREATE TABLE IF NOT EXISTS ${table} \\(([\\s\\S]*?)\\n\\s*\\)`).exec(text)![1]!;
      return [...body.matchAll(/^\s+([a-z_]+)\s+(?:TEXT|INTEGER|VARCHAR|BIGINT|MEDIUMTEXT|CHAR)/gm)].map((m) => m[1]);
    };
    const sqlite = MIGRATIONS[STEP - 1]!;
    expect(columns(sqlite, "item_thread")).toEqual(["seq", "work_item_id", "marker", "body", "created_at"]);
    expect(columns(sqlite, "command_inbox")).toEqual(["seq", "command_key", "actor", "command", "args", "created_at"]);
    for (const t of NEW_TABLES) expect(columns(sql(), t), t).toEqual(columns(sqlite, t));
  });
});

function mysqlExec(c: Queryable): Exec {
  return {
    all: async (s, p) => {
      const [r] = await c.query(s, p);
      return r as Record<string, unknown>[];
    },
    run: (s, p) => c.query(s, p),
  };
}

describe.skipIf(!MYSQL_URL)("MySQL step 0024 on MySQL", () => {
  it("on an empty database at state 23 it creates both tables, empty", async () => {
    const db = await newEmptyMysqlDatabase();
    const c = await db.connect();
    await new MysqlMigrations(c, { dir: mysqlStepsUpTo(STEP - 1) }).apply(() => undefined);
    const status = await new MysqlMigrations(c, { dir: mysqlStepsUpTo(STEP) }).status();
    expect(status.state).toBe(STEP - 1);
    expect(status.pending.map((p) => p.label)).toEqual([STEP_FILE]);
    await new MysqlMigrations(c, { dir: mysqlStepsUpTo(STEP) }).apply(() => undefined);
    for (const t of NEW_TABLES) expect(await count(mysqlExec(c), t)).toBe(0);
  });

  it("with rows: the copy keeps every row, its seq, content and timestamps, and the saved cursor; rerun copies nothing twice", async () => {
    const db = await newEmptyMysqlDatabase();
    const c = await db.connect();
    await new MysqlMigrations(c).apply(() => undefined);
    const latest = (await new MysqlMigrations(c).status()).state!;
    const store = new SqlFactoryStore(new MysqlDriver(db.options), new FakeClock());
    db.onCleanup(() => store.close());
    await store.migrate();
    const items = [(await store.createWorkItem(localItem(1), system)).item.id, (await store.createWorkItem(localItem(2), system)).item.id];
    // Back to state 23: no new tables, rows in the old ones.
    const q = mysqlExec(c);
    await c.query("DROP TABLE thread_outbox"); // step 0029 references item_thread, so it goes first
    for (const t of NEW_TABLES) await c.query(`DROP TABLE ${t}`);
    await c.query("UPDATE schema_state SET state = ? WHERE id = 1", [STEP - 1]);
    await seedOldTables(q, items);
    const before = { item_messages: await allRows(q, "item_messages"), cli_commands: await allRows(q, "cli_commands") };
    const nextBefore = await nextOldCommandKey(q, 2);

    await new MysqlMigrations(c, { dir: mysqlStepsUpTo(STEP) }).apply(() => undefined);
    await expectCopied(q, store, before, items);
    expect((await store.listCliCommandsAfter(2, 1))[0]?.key).toBe(nextBefore);

    // Set back and run again.
    await c.query("UPDATE schema_state SET state = ? WHERE id = 1", [STEP - 1]);
    await new MysqlMigrations(c, { dir: mysqlStepsUpTo(STEP) }).apply(() => undefined);
    await expectCopied(q, store, before, items);
    await c.query("UPDATE schema_state SET state = ? WHERE id = 1", [latest]);
    const { command } = await store.appendCliCommand({ key: "k4", actor: "local:owner", command: "approve", args: {} });
    expect(command.seq).toBeGreaterThan(6);
    expect(await count(q, "cli_commands")).toBe(before.cli_commands.length);
  });
});
