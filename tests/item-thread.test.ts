import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { UserId, WorkItemId } from "../src/core/types.js";
import { FakeClock } from "../src/impl/clock/fake-clock.js";
import { SqlFactoryStore } from "../src/impl/store/sql/sql-factory-store.js";
import { MIGRATIONS } from "../src/impl/store/sqlite/schema.js";
import { SqliteDriver } from "../src/impl/store/sqlite/sqlite-driver.js";
import type { NewWorkItem } from "../src/interfaces/factory-store.js";
import { PROJECT_KEY, system } from "./helpers/store.js";

// One thread table for every item and one command inbox (issue #281): SQLite migration 24 copies
// `item_messages` and `cli_commands` into `item_thread` and `command_inbox`, keeping each row's seq.
// Never pin a step as the newest: a later migration would fail these checks from outside its allowed paths.
const STEP = 24;
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
    // The old table's columns only: a later migration may add columns to the new table (e.g. the mirror mark).
    const cols = Object.keys(before[from]![0]!);
    const copied = (await allRows(q, to)).map((r) => Object.fromEntries(cols.map((c) => [c, r[c]])));
    expect(copied, to).toEqual(before[from]);
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
  const driver = new SqliteDriver(":memory:", { baselineOnly: true });
  const store = new SqlFactoryStore(driver, new FakeClock());
  await driver.migrate();
  const items = [(await store.createWorkItem(localItem(1), system)).item.id, (await store.createWorkItem(localItem(2), system)).item.id];
  for (const t of NEW_TABLES) await driver.run(`DROP TABLE ${t}`);
  await driver.run("DELETE FROM schema_migrations WHERE version > ?", [STEP - 1]);
  await seedOldTables(sqliteExec(driver), items);
  return { driver, store, items };
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
    const store = readFileSync(join(process.cwd(), "src/impl/store/sql/sql-factory-store.ts"), "utf8");
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
