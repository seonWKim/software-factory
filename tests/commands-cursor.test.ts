import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import step from "../migrations/mysql/0042-commands-cursor.js";
import type { Row, StepDb, Value } from "../migrations/step.js";
import { migrateSqlite } from "../src/impl/store/sqlite/rehearse.js";
import { SqliteDriver } from "../src/impl/store/sqlite/sqlite-driver.js";
import { MIGRATIONS_TABLE } from "../src/state/index.js";

// Issue #467: the `commands` cursor starts from the old `intake:local` cursor once, by migration, instead of a
// fallback read on every tick. SQLite: the inbound migration; MySQL: step 0042, driven here by a scripted StepDb.

const MIGRATION = "20261111T1200-inbound-commands-cursor";
const noSteps = { topicTables: async () => undefined, projectKeys: async () => 0 };

/** A SQLite file at the frozen baseline holding `cursors`; every timestamped migration is still pending. */
async function sqliteWith(cursors: Record<string, string>): Promise<string> {
  const file = join(mkdtempSync(join(tmpdir(), "sf-commands-cursor-")), "factory.db");
  const d = new SqliteDriver(file, { baselineOnly: true });
  await d.migrate();
  for (const [name, value] of Object.entries(cursors)) await d.run("INSERT INTO cursors (name, value) VALUES (?, ?)", [name, value]);
  await d.close();
  return file;
}

async function query(file: string, sql: string): Promise<Row[]> {
  const d = new SqliteDriver(file, { baselineOnly: true });
  try {
    return await d.all(sql);
  } finally {
    await d.close();
  }
}

const migrate = async (file: string) => expect(await migrateSqlite(file, "apply", noSteps, () => undefined)).toBe(0);
const sqliteCursors = (file: string) => query(file, "SELECT name, value FROM inbound_cursors ORDER BY name");

/**
 * A MySQL database as step 0042 sees it: a cursor table named `table` holding `cursors`. Answers only the three
 * statements the step sends, so a changed statement fails the test instead of passing unread.
 */
function scriptedDb(table: "inbound_cursors" | "cursors", cursors: Record<string, string>): StepDb & { cursors: Map<string, string> } {
  const state = new Map(Object.entries(cursors));
  const guarded = (sql: string, p: readonly Value[] | undefined, from: number) => {
    expect(sql).toContain(`FROM ${table} o WHERE o.name = ? AND NOT EXISTS (SELECT 1 FROM ${table} c WHERE c.name = ?)`);
    const [legacy, commands] = [p![from], p![from + 1]] as string[];
    return state.has(commands) || !state.has(legacy) ? [] : [{ value: state.get(legacy)! }];
  };
  return {
    cursors: state,
    async all(sql, params) {
      if (sql.includes("information_schema.tables")) return [{ t: table }, { t: "unrelated" }];
      if (sql.startsWith("SELECT o.value ")) return guarded(sql, params, 0);
      throw new Error(`unscripted query: ${sql}`);
    },
    async run(sql, params) {
      expect(sql.startsWith(`INSERT INTO ${table} (name, value) SELECT ?, o.value `)).toBe(true);
      const rows = guarded(sql, params, 1);
      for (const r of rows) state.set(String(params![0]), String(r.value));
      return rows.length;
    },
  };
}

describe("the commands cursor starts from intake:local, once", () => {
  it("SQLite: a store with only intake:local gets commands with the same value", async () => {
    const file = await sqliteWith({ "intake:local": "7", other: "x" });
    await migrate(file);
    expect(await sqliteCursors(file)).toEqual([
      { name: "commands", value: "7" },
      { name: "intake:local", value: "7" },
      { name: "other", value: "x" },
    ]);
  });

  it("SQLite: a store that already has commands keeps its value", async () => {
    const file = await sqliteWith({ "intake:local": "7", commands: "12" });
    await migrate(file);
    expect(await sqliteCursors(file)).toEqual([
      { name: "commands", value: "12" },
      { name: "intake:local", value: "7" },
    ]);
  });

  it("SQLite: a store with neither gets no commands cursor", async () => {
    const file = await sqliteWith({});
    await migrate(file);
    expect(await sqliteCursors(file)).toEqual([]);
  });

  it("SQLite: the migration runs once; a second migrate changes nothing", async () => {
    const file = await sqliteWith({ "intake:local": "7" });
    await migrate(file);
    await query(file, "UPDATE inbound_cursors SET value = '9' WHERE name = 'intake:local'");
    await query(file, "DELETE FROM inbound_cursors WHERE name = 'commands'");
    await migrate(file);
    expect(await sqliteCursors(file)).toEqual([{ name: "intake:local", value: "9" }]);
    expect(await query(file, `SELECT id FROM ${MIGRATIONS_TABLE} WHERE id = '${MIGRATION}'`)).toEqual([{ id: MIGRATION }]);
  });

  for (const table of ["inbound_cursors", "cursors"] as const) {
    it(`MySQL step 0042 on ${table}: plan lists the commands row, apply writes it, then plan is empty`, async () => {
      const db = scriptedDb(table, { "intake:local": "7", other: "x" });
      expect(await step.plan(db)).toEqual([{ table, name: "commands", value: "7" }]);
      expect(db.cursors.get("commands")).toBeUndefined();
      await step.apply(db);
      expect(Object.fromEntries(db.cursors)).toEqual({ "intake:local": "7", other: "x", commands: "7" });
      expect(await step.plan(db)).toEqual([]);
      await step.apply(db);
      expect(Object.fromEntries(db.cursors)).toEqual({ "intake:local": "7", other: "x", commands: "7" });
    });
  }

  it("MySQL step 0042: a store that already has commands keeps its value, and plan lists nothing", async () => {
    const db = scriptedDb("inbound_cursors", { "intake:local": "7", commands: "12" });
    expect(await step.plan(db)).toEqual([]);
    await step.apply(db);
    expect(Object.fromEntries(db.cursors)).toEqual({ "intake:local": "7", commands: "12" });
  });

  it("MySQL step 0042: refuses a database with no cursor table", async () => {
    const db: StepDb = { all: async () => [], run: async () => 0 };
    await expect(step.plan(db)).rejects.toThrow(/neither inbound_cursors nor cursors/);
  });
});
