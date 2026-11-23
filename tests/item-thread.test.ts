import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FakeClock } from "../src/impl/clock/fake-clock.js";
import { SqlFactoryStore } from "../src/impl/store/sql/sql-factory-store.js";
import { MIGRATIONS } from "../src/impl/store/sqlite/schema.js";
import { SqliteDriver } from "../src/impl/store/sqlite/sqlite-driver.js";

// One thread table for every item and one command inbox (issue #281): SQLite migration 24 copies
// `item_messages` and `cli_commands` into `item_thread` and `command_inbox`, keeping each row's seq.
// Never pin a step as the newest: a later migration would fail these checks from outside its allowed paths.
const STEP = 24;
const NEW_TABLES = ["command_inbox", "item_thread"];
const OLD_TABLES = ["cli_commands", "item_messages"];

type Exec = { all(sql: string, params?: unknown[]): Promise<Record<string, unknown>[]>; run(sql: string, params?: unknown[]): Promise<unknown> };

async function count(q: Exec, table: string): Promise<number> {
  const [r] = await q.all(`SELECT COUNT(*) AS n FROM ${table}`);
  return Number(r!.n);
}

function sqliteExec(driver: SqliteDriver): Exec {
  return { all: (s, p) => driver.all(s, p as never) as never, run: (s, p) => driver.run(s, p as never) };
}

describe("SQLite migration 24: item thread and command inbox", () => {
  it("migrate() on an empty database reaches the latest migration and creates both tables, empty", async () => {
    expect(MIGRATIONS.length).toBeGreaterThanOrEqual(STEP);
    const driver = new SqliteDriver(":memory:", { baselineOnly: true });
    const store = new SqlFactoryStore(driver, new FakeClock());
    await driver.migrate();
    expect(await driver.schemaVersion()).toEqual({ applied: MIGRATIONS.length, latest: MIGRATIONS.length });
    const names = await driver.all(
      `SELECT name FROM sqlite_master WHERE type = 'table' AND name IN (${[...NEW_TABLES, ...OLD_TABLES].map(() => "?").join(", ")}) ORDER BY name`,
      [...NEW_TABLES, ...OLD_TABLES],
    );
    expect(names.map((r) => r.name)).toEqual([...NEW_TABLES, ...OLD_TABLES].sort());
    for (const t of NEW_TABLES) expect(await count(sqliteExec(driver), t)).toBe(0);
    await store.close();
  });
});

describe("the store reads and writes only the new tables", () => {
  it("no SQL statement in the store names item_messages or cli_commands; the docs name the new tables", () => {
    // The class and local-items.ts, which holds its item thread and command inbox methods.
    const store = ["sql-factory-store.ts", "local-items.ts"].map((f) => readFileSync(join(process.cwd(), "src/impl/store/sql", f), "utf8")).join("\n");
    for (const t of OLD_TABLES) expect(store, t).not.toMatch(new RegExp(`\\b${t}\\b`));
    // Under their RFC 0015 names since the prefix migration.
    const STORE_TABLES = ["controller_item_thread", "inbound_commands"];
    for (const t of STORE_TABLES) expect(store, t).toMatch(new RegExp(`(?:INTO|FROM) ${t}\\b`));
    for (const doc of ["docs/design/05-sources.md", "docs/plugins/source-adapter.md"]) {
      const text = readFileSync(join(process.cwd(), doc), "utf8");
      for (const t of STORE_TABLES) expect(text, `${doc}: ${t}`).toContain(`\`${t}\``);
      for (const t of OLD_TABLES) expect(text, `${doc}: ${t}`).not.toContain(`\`${t}\``);
    }
  });
});
