// Table docs (design 09-dashboard-app, Data page): every table of a freshly migrated SQLite store has a one-line
// description and an owning component, kept in the table-docs.ts beside that component's migrations; no line names
// a table or column the store does not have.

import { describe, expect, it } from "vitest";
import { FakeClock } from "../src/impl/clock/fake-clock.js";
import { SqlFactoryStore } from "../src/impl/store/sql/sql-factory-store.js";
import { SqliteDriver } from "../src/impl/store/sqlite/sqlite-driver.js";
import type { StoreTable } from "../src/interfaces/factory-store.js";
import { TABLE_DOCS, tableDoc } from "../src/ui/data.js";

async function catalog(): Promise<StoreTable[]> {
  const store = new SqlFactoryStore(new SqliteDriver(":memory:"), new FakeClock());
  await store.migrate();
  try {
    return await store.listTables();
  } finally {
    await store.close();
  }
}

/** Tables with no description, and lines whose table or column is not in `tables`. */
function docProblems(tables: readonly StoreTable[], docs: typeof TABLE_DOCS): { undescribed: string[]; unknown: string[] } {
  const described = new Set(Object.values(docs).flatMap((d) => Object.keys(d).filter((k) => !k.includes("."))));
  const columns = new Map(tables.map((t) => [t.name, t.columns]));
  const unknown = Object.values(docs).flatMap((d) =>
    Object.keys(d).filter((k) => {
      const [table, column] = k.split(".");
      return !columns.has(table!) || (column !== undefined && !columns.get(table!)!.includes(column));
    }),
  );
  return { undescribed: tables.map((t) => t.name).filter((n) => !described.has(n)), unknown };
}

describe("table docs", () => {
  it("every table on a freshly migrated store has a one-line description and an owner", async () => {
    const tables = await catalog();
    expect(docProblems(tables, TABLE_DOCS).undescribed).toEqual([]);
    for (const t of tables) {
      const doc = tableDoc(t.name)!;
      expect(doc.owner, t.name).toMatch(/^[a-z]+$/);
      expect(doc.description, t.name).toMatch(/^\S.*\.$/);
      expect(doc.description, t.name).not.toContain("\n");
    }
  });

  it("no line names a table or a column the store does not have", async () => {
    expect(docProblems(await catalog(), TABLE_DOCS).unknown).toEqual([]);
  });

  it("each table is described by one component only", () => {
    const seen = new Map<string, string>();
    const twice: string[] = [];
    for (const [owner, docs] of Object.entries(TABLE_DOCS)) {
      for (const k of Object.keys(docs)) {
        if (seen.has(k)) twice.push(`${k}: ${seen.get(k)} and ${owner}`);
        seen.set(k, owner);
      }
    }
    expect(twice).toEqual([]);
  });

  it("the check fails on a table with no description and on a line for a table that does not exist", async () => {
    const tables = await catalog();
    const { controller_work_items: _dropped, ...rest } = TABLE_DOCS.controller!;
    const docs = { ...TABLE_DOCS, controller: { ...rest, controller_ghosts: "A table no migration makes.", "worker_runs.ghost": "No such column." } };
    const p = docProblems(tables, docs);
    expect(p.undescribed).toContain("controller_work_items");
    expect(p.unknown).toEqual(expect.arrayContaining(["controller_ghosts", "worker_runs.ghost"]));
  });

  it("gives a column its meaning, and a bus topic's table its line by suffix", () => {
    expect(tableDoc("worker_runs")).toMatchObject({ owner: "worker", columns: { kind: expect.stringContaining("implement") } });
    expect(tableDoc("bus_controller_commands_dead_letters")).toMatchObject({ owner: "bus", description: expect.stringContaining("failed every retry") });
    expect(tableDoc("no_such_table")).toBeNull();
  });
});
