// The Data page Ask's read-only query (design 09-dashboard-app): the statement checks, the read-only connection, the
// row cap and the time limit, on a SQLite file store (an in-memory one has no second connection).

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FakeClock } from "../src/impl/clock/fake-clock.js";
import { READ_ONLY_MAX_ROWS, READ_ONLY_TIME_LIMIT_MS, readOnlyQuery, statementProblem } from "../src/impl/store/sqlite/readonly-query.js";
import { openReadOnly, runReadOnly } from "../src/impl/store/sqlite/readonly-query-worker.js";
import { SqlFactoryStore } from "../src/impl/store/sql/sql-factory-store.js";
import { SqliteDriver } from "../src/impl/store/sqlite/sqlite-driver.js";

const open: SqlFactoryStore[] = [];

async function fileStore() {
  const path = join(mkdtempSync(join(tmpdir(), "sf-readonly-")), "factory.db");
  const driver = new SqliteDriver(path);
  const store = new SqlFactoryStore(driver, new FakeClock());
  await store.migrate();
  open.push(store);
  return { path, driver, store };
}

afterEach(async () => {
  for (const s of open.splice(0)) await s.close();
});

describe("statementProblem", () => {
  it("accepts one SELECT or WITH … SELECT, with or without a trailing semicolon", () => {
    expect(statementProblem("SELECT 1")).toBeNull();
    expect(statementProblem("  select count(*) from worker_runs; ")).toBeNull();
    expect(statementProblem("WITH x AS (SELECT 1 AS n) SELECT n FROM x")).toBeNull();
    // Words inside string literals and comments are data, not statements.
    expect(statementProblem("SELECT 'delete; drop' AS s -- update\n")).toBeNull();
    expect(statementProblem("SELECT replace('a', 'a', 'b')")).toBeNull();
  });

  it("refuses a non-SELECT with the reason", () => {
    expect(statementProblem("DELETE FROM worker_runs")).toMatch(/Only a SELECT \(or WITH … SELECT\) runs, and this statement begins with DELETE/);
    expect(statementProblem("WITH x AS (SELECT 1) DELETE FROM worker_runs")).toMatch(/DELETE is not allowed/);
    expect(statementProblem("WITH x AS (SELECT 1) REPLACE INTO t SELECT * FROM x")).toMatch(/REPLACE INTO is not allowed/);
    expect(statementProblem("")).toMatch(/no statement/);
  });

  it("refuses a second statement", () => {
    expect(statementProblem("SELECT 1; SELECT 2")).toMatch(/Only one statement runs/);
    expect(statementProblem("SELECT 1; DELETE FROM worker_runs;")).toMatch(/Only one statement runs/);
  });

  it("refuses ATTACH and PRAGMA, also inside a SELECT", () => {
    expect(statementProblem("ATTACH DATABASE 'x.db' AS x")).toMatch(/begins with ATTACH/);
    expect(statementProblem("PRAGMA table_info(worker_runs)")).toMatch(/begins with PRAGMA/);
    expect(statementProblem("SELECT * FROM pragma_table_info('worker_runs') WHERE 1 OR \"PRAGMA\"")).toMatch(/PRAGMA is not allowed/);
  });
});

describe("readOnlyQuery", () => {
  it("runs a SELECT through the store and gives columns and rows", async () => {
    const { store } = await fileStore();
    const r = await store.readOnlyQuery!("SELECT 1 AS one, 'two' AS two");
    expect(r).toEqual({ columns: ["one", "two"], rows: [[1, "two"]], truncated: false });
  });

  it("refuses before it runs: the statement checks", async () => {
    const { store } = await fileStore();
    expect(await store.readOnlyQuery!("SELECT 1; SELECT 2")).toEqual({ refused: expect.stringMatching(/Only one statement/) });
  });

  it("the connection is read-only: a write through it fails even with the checks bypassed", async () => {
    const { path, driver } = await fileStore();
    const db = openReadOnly(path);
    try {
      expect(() => db.exec("INSERT INTO worker_claim_locks (name) VALUES ('x')")).toThrow(/readonly|read-only|query_only|attempt to write/i);
      expect(() => db.exec("PRAGMA query_only = OFF; INSERT INTO worker_claim_locks (name) VALUES ('x')")).toThrow();
    } finally {
      db.close();
    }
    expect(await driver.all("SELECT name FROM worker_claim_locks WHERE name = 'x'")).toEqual([]);
  });

  it("the child's run refuses a write and ATTACH with the statement checks bypassed", async () => {
    const { path, driver } = await fileStore();
    await driver.run("INSERT INTO worker_claim_locks (name) VALUES ('kept')");
    for (const sql of ["DELETE FROM worker_claim_locks", "ATTACH DATABASE ':memory:' AS x", "PRAGMA query_only = OFF"]) {
      expect(runReadOnly({ path, sql, max_rows: 10, ignore: {} }), sql).toEqual({ refused: expect.stringMatching(/^SQLite refused the query: /) });
    }
    expect(await driver.all("SELECT name FROM worker_claim_locks WHERE name = 'kept'")).toEqual([{ name: "kept" }]);
  });

  it(`returns at most ${READ_ONLY_MAX_ROWS} rows and says the result was cut`, async () => {
    const { store } = await fileStore();
    const big = await store.readOnlyQuery!("WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM n WHERE x < 600) SELECT x FROM n");
    if ("refused" in big) throw new Error(big.refused);
    expect(big.rows).toHaveLength(READ_ONLY_MAX_ROWS);
    expect(big.rows[0]).toEqual([1]);
    expect(big.rows.at(-1)).toEqual([READ_ONLY_MAX_ROWS]);
    expect(big.truncated).toBe(true);
    const small = await store.readOnlyQuery!("WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM n WHERE x < 3) SELECT x FROM n");
    expect(small).toMatchObject({ truncated: false, rows: [[1], [2], [3]] });
  });

  it("stops a query past the time limit and says so", async () => {
    expect(READ_ONLY_TIME_LIMIT_MS).toBe(5000);
    const { path } = await fileStore();
    const started = Date.now();
    const r = await readOnlyQuery(path, "WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM n) SELECT count(*) FROM n", { time_limit_ms: 400 });
    expect(r).toEqual({ refused: "Stopped: the query ran past the time limit of 0.4 seconds." });
    expect(Date.now() - started).toBeLessThan(4000);
  });

  it("a read of an ignored column gives NULL", async () => {
    const { path, driver } = await fileStore();
    await driver.run("INSERT INTO worker_claim_locks (name) VALUES ('kept')");
    const sql = "SELECT count(*) AS n, max(name) AS top FROM worker_claim_locks";
    expect(await readOnlyQuery(path, sql)).toMatchObject({ rows: [[expect.any(Number), expect.any(String)]] });
    expect(await readOnlyQuery(path, sql, { ignore: { worker_claim_locks: ["name"] } })).toMatchObject({ columns: ["n", "top"], rows: [[expect.any(Number), null]] });
  });
});
