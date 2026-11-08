import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { UserId, WorkItemId } from "../src/core/types.js";
import { FakeClock } from "../src/impl/clock/fake-clock.js";
import { INLINE_STEPS, MysqlMigrations, STEPS_DIR, readSteps } from "../src/impl/store/mysql/migrations.js";
import { MysqlDriver } from "../src/impl/store/mysql/mysql-driver.js";
import { SqlFactoryStore } from "../src/impl/store/sql/sql-factory-store.js";
import { MIGRATIONS } from "../src/impl/store/sqlite/schema.js";
import { SqliteDriver } from "../src/impl/store/sqlite/sqlite-driver.js";
import type { NewWorkItem } from "../src/interfaces/factory-store.js";
import { BACKENDS, MYSQL_URL, PROJECT_KEY, issue, mysqlStepsUpTo, newEmptyMysqlDatabase, system } from "./helpers/store.js";

// Local work items (issue #198, phase 1): the "local" source type, the messages the controller would post as
// comments, and the CLI command log. Types and tables only: nothing outside the store calls these yet.

/** The MySQL step and SQLite migration that add both tables. */
// Never pin a step as the newest (a length, `at(-1)` equal to it, or "pending alone"): a later migration would
// fail these checks from outside its allowed paths. Compare with `>=`, read MIGRATIONS.length, or use mysqlStepsUpTo.
const STEP = 21;
const STEP_FILE = "0021-local-items.sql";
const TABLES = ["cli_commands", "item_messages"];

/** The MySQL step and SQLite migration that add the app command request table (issue #244). */
const COMMANDS_STEP = 22;
const COMMANDS_STEP_FILE = "0022-app-commands.sql";
const COMMANDS_TABLE = "app_command_requests";
/** The MySQL step and SQLite migration that add the handled and refusal columns (issue #245): the last step. */
const HANDLING_STEP = 23;
const HANDLING_STEP_FILE = "0023-app-command-handling.sql";

function localItem(n: number): NewWorkItem {
  return {
    source: { type: "local", id: `local-${n}`, link: `local:local-${n}` },
    requester_id: "local:owner" as UserId,
    project: PROJECT_KEY,
    problem: `problem ${n}`,
    resources: [],
  };
}

for (const b of BACKENDS) {
  describe(`${b.name}: local work items`, () => {
    it('a work item with source type "local" is found by its source, same type and id', async () => {
      const { store } = await b.make();
      const { item } = await store.createWorkItem(localItem(1), system);
      const found = await store.getWorkItemBySource("local", "local-1");
      expect(found?.id).toBe(item.id);
      expect(found?.source).toMatchObject({ type: "local", id: "local-1" });
      expect(await store.getWorkItemBySource("github_issue", "local-1")).toBeNull();
    });
  });

  describe(`${b.name}: item messages`, () => {
    it("lists an item's messages oldest first, and only that item's", async () => {
      const { store, clock } = await b.make();
      const a = (await store.createWorkItem(localItem(1), system)).item;
      const other = (await store.createWorkItem(issue(2), system)).item;
      const first = await store.recordItemMessage({ work_item_id: a.id, marker: "m1", body: "first" });
      clock.advance(1000);
      await store.recordItemMessage({ work_item_id: other.id, marker: "m1", body: "elsewhere" });
      const second = await store.recordItemMessage({ work_item_id: a.id, marker: "m2", body: "second" });
      expect(first).toMatchObject({ created: true, message: { work_item_id: a.id, marker: "m1", body: "first" } });
      expect(second.created).toBe(true);
      expect(second.message.seq).toBeGreaterThan(first.message.seq);

      const listed = await store.listItemMessages(a.id);
      expect(listed.map((m) => m.body)).toEqual(["first", "second"]);
      expect(listed[0]).toEqual(first.message);
      expect((await store.listItemMessages(other.id)).map((m) => m.body)).toEqual(["elsewhere"]);
      expect(await store.listItemMessages("wi_none" as WorkItemId)).toEqual([]);
    });

    it("the same marker on the same item stores one message; the second call reports created: false", async () => {
      const { store } = await b.make();
      const a = (await store.createWorkItem(localItem(1), system)).item;
      const first = await store.recordItemMessage({ work_item_id: a.id, marker: "m1", body: "first" });
      const again = await store.recordItemMessage({ work_item_id: a.id, marker: "m1", body: "changed" });
      expect(again).toEqual({ created: false, message: first.message });
      expect(await store.listItemMessages(a.id)).toEqual([first.message]);
    });
  });

  describe(`${b.name}: CLI commands`, () => {
    it("append returns each command with an increasing sequence number", async () => {
      const { store } = await b.make();
      const one = await store.appendCliCommand({ key: "k1", actor: "local:owner", command: "approve", args: { item: "wi_1" } });
      const two = await store.appendCliCommand({ key: "k2", actor: "local:owner", command: "reject", args: {} });
      expect(one).toMatchObject({ created: true, command: { key: "k1", actor: "local:owner", command: "approve", args: { item: "wi_1" } } });
      expect(two.created).toBe(true);
      expect(two.command.seq).toBeGreaterThan(one.command.seq);
    });

    it("lists commands after a sequence number, in sequence order, at most limit", async () => {
      const { store } = await b.make();
      const seqs: number[] = [];
      for (let i = 1; i <= 4; i++) {
        seqs.push((await store.appendCliCommand({ key: `k${i}`, actor: "local:owner", command: "c", args: { i } })).command.seq);
      }
      expect((await store.listCliCommandsAfter(0, 10)).map((c) => c.key)).toEqual(["k1", "k2", "k3", "k4"]);
      expect((await store.listCliCommandsAfter(seqs[0]!, 2)).map((c) => c.key)).toEqual(["k2", "k3"]);
      expect((await store.listCliCommandsAfter(seqs[3]!, 10))).toEqual([]);
      const [c3] = await store.listCliCommandsAfter(seqs[1]!, 1);
      expect(c3).toMatchObject({ seq: seqs[2], key: "k3", command: "c", args: { i: 3 } });
    });

    it("appending twice with the same key stores one command", async () => {
      const { store } = await b.make();
      const first = await store.appendCliCommand({ key: "k1", actor: "local:owner", command: "approve", args: {} });
      const again = await store.appendCliCommand({ key: "k1", actor: "local:owner", command: "reject", args: { x: 1 } });
      expect(again).toEqual({ created: false, command: first.command });
      expect(await store.listCliCommandsAfter(0, 10)).toEqual([first.command]);
    });
  });
}

describe("SQLite migration 21: local item tables", () => {
  it("is followed by migration 22, and migrate() on a fresh database creates both tables", async () => {
    expect(MIGRATIONS.length).toBeGreaterThanOrEqual(COMMANDS_STEP);
    const driver = new SqliteDriver(":memory:", { baselineOnly: true });
    const store = new SqlFactoryStore(driver, new FakeClock());
    await driver.migrate();
    const rows = await driver.all(
      `SELECT name FROM sqlite_master WHERE type = 'table' AND name IN (${TABLES.map(() => "?").join(", ")}) ORDER BY name`,
      TABLES,
    );
    expect(rows.map((r) => r.name)).toEqual(TABLES);
    await store.close();
  });
});

describe("MySQL step 0021: local item tables", () => {
  it("is a .sql file step after 0020 that creates both tables", () => {
    const step = readSteps(STEPS_DIR, INLINE_STEPS).find((s) => s.name === "local-items")!;
    expect(step).toMatchObject({ number: STEP, from: STEP - 1, kind: "sql", file: STEP_FILE });
    expect(readSteps(STEPS_DIR, INLINE_STEPS).at(-1)!.number).toBeGreaterThanOrEqual(COMMANDS_STEP);
  });
});

describe.skipIf(!MYSQL_URL)("MySQL step 0021 on MySQL", () => {
  it("pending at state 20: --status lists it; after npm run migrate both tables exist", async () => {
    const db = await newEmptyMysqlDatabase();
    const c = await db.connect();
    await new MysqlMigrations(c, { dir: mysqlStepsUpTo(STEP - 1) }).apply(() => undefined);

    // Steps up to 21 only: step 0022 is pending too, and has its own test below.
    const status = await new MysqlMigrations(c, { dir: mysqlStepsUpTo(STEP) }).status();
    expect(status.state).toBe(STEP - 1);
    expect(status.pending.map((p) => p.label)).toEqual([STEP_FILE]);
    const store = new SqlFactoryStore(new MysqlDriver(db.options), new FakeClock());
    db.onCleanup(() => store.close());
    await expect(store.migrate()).rejects.toThrow(/schema steps? pending \(state 20, latest \d+\): run `npm run migrate`/);

    await new MysqlMigrations(c).apply(() => undefined);
    // RFC 0015 M1 archives both tables as legacy_<name>.
    const legacy = TABLES.map((t) => `legacy_${t}`);
    const [tables] = await c.query(
      "SELECT table_name AS name FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name IN (?, ?) ORDER BY 1",
      legacy,
    );
    expect((tables as { name: string }[]).map((t) => t.name)).toEqual(legacy);
    await store.migrate();
    const r = await store.appendCliCommand({ key: "k1", actor: "local:owner", command: "c", args: {} });
    expect(r.created).toBe(true);
  });
});

async function sqliteHasCommandsTable(driver: SqliteDriver): Promise<boolean> {
  const rows = await driver.all("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?", [COMMANDS_TABLE]);
  return rows.length === 1;
}

describe("SQLite migration 22: app command requests", () => {
  // Later migrations may follow; nothing here pins 22 as the newest (a new migration needs no edit here).
  it("migrate() on a fresh database reaches the latest migration and creates the table", async () => {
    const LATEST = MIGRATIONS.length;
    expect(LATEST).toBeGreaterThanOrEqual(COMMANDS_STEP);
    const driver = new SqliteDriver(":memory:", { baselineOnly: true });
    const store = new SqlFactoryStore(driver, new FakeClock());
    await driver.migrate();
    expect(await driver.schemaVersion()).toEqual({ applied: LATEST, latest: LATEST });
    expect(await sqliteHasCommandsTable(driver)).toBe(true);
    const cols = await driver.all(`SELECT name, type, "notnull" AS nn, pk FROM pragma_table_info('${COMMANDS_TABLE}') ORDER BY cid`);
    expect(cols.slice(0, 6)).toEqual([
      { name: "seq", type: "INTEGER", nn: 0, pk: 1 },
      { name: "request_key", type: "TEXT", nn: 1, pk: 0 },
      { name: "actor", type: "TEXT", nn: 1, pk: 0 },
      { name: "command", type: "TEXT", nn: 1, pk: 0 },
      { name: "args", type: "TEXT", nn: 1, pk: 0 },
      { name: "created_at", type: "TEXT", nn: 1, pk: 0 },
    ]);
    const insert = `INSERT INTO ${COMMANDS_TABLE} (request_key, actor, command, args, created_at) VALUES (?, 'local:owner', 'c', '{}', 't')`;
    await driver.run(insert, ["k1"]);
    await expect(driver.run(insert, ["k1"])).rejects.toThrow(/UNIQUE/);
    await store.close();
  });

  it("a database recorded at version 21 reaches the latest after migrate() and has the table", async () => {
    const LATEST = MIGRATIONS.length;
    const driver = new SqliteDriver(":memory:", { baselineOnly: true });
    const store = new SqlFactoryStore(driver, new FakeClock());
    await driver.migrate();
    await driver.run(`DROP TABLE ${COMMANDS_TABLE}`);
    await driver.run("DELETE FROM schema_migrations WHERE version > ?", [STEP]);
    expect(await driver.schemaVersion()).toEqual({ applied: STEP, latest: LATEST });
    expect(await sqliteHasCommandsTable(driver)).toBe(false);

    await driver.migrate();
    expect(await driver.schemaVersion()).toEqual({ applied: LATEST, latest: LATEST });
    expect(await sqliteHasCommandsTable(driver)).toBe(true);
    await store.close();
  });
});

describe("MySQL step 0022: app command requests", () => {
  it("is a .sql file step after 0021, with CREATE TABLE IF NOT EXISTS", () => {
    const steps = readSteps(STEPS_DIR, INLINE_STEPS);
    const step = steps.find((s) => s.name === "app-commands")!;
    expect(step).toMatchObject({ number: COMMANDS_STEP, from: STEP, kind: "sql", file: COMMANDS_STEP_FILE });
    expect(steps.at(-1)!.number).toBeGreaterThanOrEqual(COMMANDS_STEP);
    expect(steps.filter((s) => s.number === 20).map((s) => s.file)).toEqual(["0020-run-attempts.sql"]);
    expect(readFileSync(join(STEPS_DIR, COMMANDS_STEP_FILE), "utf8")).toMatch(new RegExp(`CREATE TABLE IF NOT EXISTS ${COMMANDS_TABLE} \\(`));
  });
});

describe.skipIf(!MYSQL_URL)("MySQL step 0022 on MySQL", () => {
  it("pending at state 21; after npm run migrate the table exists with a unique request_key", async () => {
    const db = await newEmptyMysqlDatabase();
    const c = await db.connect();
    await new MysqlMigrations(c, { dir: mysqlStepsUpTo(STEP) }).apply(() => undefined);

    // Steps up to 22 only: later steps are pending too and have their own tests.
    const status = await new MysqlMigrations(c, { dir: mysqlStepsUpTo(COMMANDS_STEP) }).status();
    expect(status.state).toBe(STEP);
    expect(status.pending.map((p) => p.label)).toEqual([COMMANDS_STEP_FILE]);

    await new MysqlMigrations(c, { dir: mysqlStepsUpTo(COMMANDS_STEP) }).apply(() => undefined);
    expect((await new MysqlMigrations(c, { dir: mysqlStepsUpTo(COMMANDS_STEP) }).status()).pending).toEqual([]);
    const [cols] = await c.query(
      "SELECT column_name AS name FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = ? ORDER BY ordinal_position",
      [COMMANDS_TABLE],
    );
    expect((cols as { name: string }[]).map((r) => r.name)).toEqual(["seq", "request_key", "actor", "command", "args", "created_at"]);
    const insert = `INSERT INTO ${COMMANDS_TABLE} (request_key, actor, command, args, created_at) VALUES ('k1', 'local:owner', 'c', '{}', 't')`;
    await c.query(insert);
    await expect(c.query(insert)).rejects.toThrow(/Duplicate/);
  });
});

async function sqliteColumns(driver: SqliteDriver): Promise<{ name: string; type: string; nn: number }[]> {
  return (await driver.all(`SELECT name, type, "notnull" AS nn FROM pragma_table_info('${COMMANDS_TABLE}') ORDER BY cid`)) as never;
}

describe("SQLite migration 23: app command request handling", () => {
  it("migrate() on a fresh database reaches the latest migration, with nullable handled_at and refusal", async () => {
    expect(MIGRATIONS.length).toBeGreaterThanOrEqual(HANDLING_STEP);
    const driver = new SqliteDriver(":memory:", { baselineOnly: true });
    const store = new SqlFactoryStore(driver, new FakeClock());
    await driver.migrate();
    expect(await driver.schemaVersion()).toEqual({ applied: MIGRATIONS.length, latest: MIGRATIONS.length });
    expect((await sqliteColumns(driver)).slice(6)).toEqual([
      { name: "handled_at", type: "TEXT", nn: 0 },
      { name: "refusal", type: "TEXT", nn: 0 },
    ]);
    await store.close();
  });

});

describe("MySQL step 0023: app command request handling", () => {
  it("is a .sql file step after 0022 that adds handled_at and refusal", () => {
    const steps = readSteps(STEPS_DIR, INLINE_STEPS);
    const step = steps.find((s) => s.name === "app-command-handling")!;
    expect(step).toMatchObject({ number: HANDLING_STEP, from: COMMANDS_STEP, kind: "sql", file: HANDLING_STEP_FILE });
    expect(steps.at(-1)!.number).toBeGreaterThanOrEqual(HANDLING_STEP);
    const sql = readFileSync(join(STEPS_DIR, HANDLING_STEP_FILE), "utf8");
    expect(sql).toMatch(new RegExp(`ALTER TABLE ${COMMANDS_TABLE} ADD COLUMN handled_at .*ADD COLUMN refusal `));
  });
});

describe.skipIf(!MYSQL_URL)("MySQL step 0023 on MySQL", () => {
  it("pending at state 22; after npm run migrate the table has handled_at and refusal, and old rows stay pending", async () => {
    const db = await newEmptyMysqlDatabase();
    const c = await db.connect();
    await new MysqlMigrations(c, { dir: mysqlStepsUpTo(COMMANDS_STEP) }).apply(() => undefined);
    await c.query(`INSERT INTO ${COMMANDS_TABLE} (request_key, actor, command, args, created_at) VALUES ('old', 'local:owner', 'approve', '{}', 't')`);

    // Steps up to 23 only: later steps are pending too and have their own tests.
    const status = await new MysqlMigrations(c, { dir: mysqlStepsUpTo(HANDLING_STEP) }).status();
    expect(status.state).toBe(COMMANDS_STEP);
    expect(status.pending.map((p) => p.label)).toEqual([HANDLING_STEP_FILE]);

    await new MysqlMigrations(c).apply(() => undefined);
    expect((await new MysqlMigrations(c).status()).pending).toEqual([]);
    // RFC 0015 M1 copies the table to its new name; M4 merges it into inbound_commands and keeps it as legacy_.
    const [cols] = await c.query(
      "SELECT column_name AS name, is_nullable AS nullable FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = ? ORDER BY ordinal_position",
      ["legacy_inbound_app_requests"],
    );
    expect((cols as { name: string; nullable: string }[]).slice(6)).toEqual([
      { name: "handled_at", nullable: "YES" },
      { name: "refusal", nullable: "YES" },
    ]);
    const store = new SqlFactoryStore(new MysqlDriver(db.options), new FakeClock());
    db.onCleanup(() => store.close());
    await store.migrate();
    expect(await store.getAppCommandRequest(1)).toMatchObject({ key: "old", handled_at: null, refusal: null });
  });
});
