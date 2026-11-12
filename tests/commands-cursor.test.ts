import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { migrateSqlite } from "../src/impl/store/sqlite/rehearse.js";
import { SqliteDriver } from "../src/impl/store/sqlite/sqlite-driver.js";
import { MIGRATIONS_TABLE } from "../src/state/index.js";

// Issue #467: the `commands` cursor starts from the old `intake:local` cursor once, by migration, instead of a
// fallback read on every tick. The inbound migration (SQLite).


type Row = Record<string, unknown>;
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
});
