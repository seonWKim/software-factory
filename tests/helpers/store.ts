import { randomBytes } from "node:crypto";
import mysql from "mysql2/promise";
import { onTestFinished } from "vitest";
import type { Actor, UserId, WorkerId } from "../../src/core/types.js";
import type { Clock } from "../../src/interfaces/clock.js";
import type { FactoryStore, NewWorkItem } from "../../src/interfaces/factory-store.js";
import { FakeClock } from "../../src/impl/clock/fake-clock.js";
import { MysqlMigrations } from "../../src/impl/store/mysql/migrations.js";
import { MysqlDriver, type MysqlOptions } from "../../src/impl/store/mysql/mysql-driver.js";
import { SqlFactoryStore } from "../../src/impl/store/sql/sql-factory-store.js";
import { SqliteDriver } from "../../src/impl/store/sqlite/sqlite-driver.js";

/** The project key test items carry (the configured repo o/r, see PROJECT in fakes.ts). */
export const PROJECT_KEY = "github:github.com:R_kgDOrepo1";
/** Another repository's key, for tests that need two projects. */
export const OTHER_PROJECT_KEY = "github:github.com:R_kgDOrepo2";

export async function newStore(clock = new FakeClock()) {
  const store = new SqlFactoryStore(new SqliteDriver(":memory:"), clock);
  await store.migrate();
  return { store, clock };
}

/**
 * A MySQL server for tests, e.g. SF_TEST_MYSQL_URL=mysql://root@127.0.0.1:3306. Each store gets its own
 * throwaway database, dropped when the test finishes. Unset: MySQL tests are skipped.
 */
export const MYSQL_URL = process.env.SF_TEST_MYSQL_URL;

function mysqlOptions(url: string, database: string): MysqlOptions {
  const u = new URL(url);
  return {
    host: u.hostname,
    port: Number(u.port || 3306),
    user: decodeURIComponent(u.username),
    password: decodeURIComponent(u.password),
    database,
  };
}

/**
 * An empty throwaway MySQL database, dropped when the test finishes. `connect` opens one connection to it
 * (closed at the end too); `options` is what a MysqlDriver needs.
 */
export async function newEmptyMysqlDatabase() {
  const database = `sf_test_${randomBytes(6).toString("hex")}`;
  const { database: _, ...server } = mysqlOptions(MYSQL_URL!, "");
  const admin = await mysql.createConnection(server);
  await admin.query(`CREATE DATABASE ${database}`);
  const options = mysqlOptions(MYSQL_URL!, database);
  const connections: mysql.Connection[] = [];
  const cleanups: (() => Promise<void>)[] = [];
  const connect = async () => {
    const c = await mysql.createConnection(options);
    connections.push(c);
    return c;
  };
  onTestFinished(async () => {
    for (const f of cleanups) await f();
    await Promise.all(connections.map((c) => c.end()));
    await admin.query(`DROP DATABASE ${database}`);
    await admin.end();
  });
  return { database, options, connect, onCleanup: (f: () => Promise<void>) => cleanups.push(f) };
}

/**
 * A fresh MySQL database brought up to date through `npm run migrate`'s path (MysqlMigrations.apply),
 * not through the store: opening a store never applies a step. Every store returned by `open` points at it.
 */
export async function newMysqlDatabase(clock: Clock = new FakeClock()) {
  const db = await newEmptyMysqlDatabase();
  await new MysqlMigrations(await db.connect()).apply(() => undefined);
  const stores: SqlFactoryStore[] = [];
  const open = () => {
    const s = new SqlFactoryStore(new MysqlDriver(db.options), clock);
    stores.push(s);
    return s;
  };
  db.onCleanup(async () => {
    await Promise.all(stores.map((s) => s.close()));
  });
  const store = open();
  await store.migrate(); // a check on MySQL: throws if a step were still pending
  return { store, open };
}

export interface Backend {
  name: string;
  make(clock?: FakeClock): Promise<{ store: FactoryStore; clock: FakeClock }>;
}

export const BACKENDS: Backend[] = [
  { name: "sqlite", make: newStore },
  ...(MYSQL_URL
    ? [
        {
          name: "mysql",
          make: async (clock = new FakeClock()) => ({ store: (await newMysqlDatabase(clock)).store, clock }),
        },
      ]
    : []),
];

export const system: Actor = { kind: "system", id: "system:test" };
export const human: Actor = { kind: "user", id: "github:1" as UserId };
export const w1 = "worker-1" as WorkerId;
export const w2 = "worker-2" as WorkerId;

export function issue(n: number): NewWorkItem {
  return {
    source: { type: "github_issue", id: `o/r#${n}`, link: `https://github.com/o/r/issues/${n}` },
    requester_id: "github:1" as UserId,
    project: PROJECT_KEY,
    problem: `problem ${n}`,
    resources: [],
  };
}
