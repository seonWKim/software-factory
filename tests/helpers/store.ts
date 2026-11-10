import { randomBytes } from "node:crypto";
import { copyFileSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import mysql from "mysql2/promise";
import { onTestFinished } from "vitest";
import type { Actor, UserId, WorkerId } from "../../src/core/types.js";
import type { Clock } from "../../src/interfaces/clock.js";
import type { FactoryStore, NewWorkItem } from "../../src/interfaces/factory-store.js";
import { FakeClock } from "../../src/impl/clock/fake-clock.js";
import { INLINE_STEPS, MysqlMigrations, STEPS_DIR, inlineStepName } from "../../src/impl/store/mysql/migrations.js";
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
 * The repo's MySQL schema steps numbered up to `state` (step files and INLINE_STEPS), as files in a fresh dir.
 * A database migrated with it stops at `state`, as one from before the later steps; a step's upgrade test then
 * runs `MysqlMigrations` with the repo's own steps, so a later step never breaks it.
 */
export function mysqlStepsUpTo(state: number): string {
  const dir = mkdtempSync(join(tmpdir(), "sf-mysql-steps-"));
  for (const f of readdirSync(STEPS_DIR)) {
    const n = /^(\d{4})-/.exec(f);
    if (n && Number(n[1]) <= state) copyFileSync(join(STEPS_DIR, f), join(dir, f));
  }
  for (const st of INLINE_STEPS) if (st.number <= state) writeFileSync(join(dir, inlineStepName(st)), st.sql);
  return dir;
}

/** One table of the migrated template: its DDL and its rows (schema_state, the applied migrations, seed rows). */
interface TemplateTable {
  ddl: string;
  rows: Record<string, unknown>[];
}

let template: Promise<TemplateTable[]> | null = null;

/**
 * The schema `npm run migrate`'s path (MysqlMigrations.apply) builds on an empty database, captured once per test
 * file (module scope) from a throwaway database: every table's DDL and rows. Migrating ~60 steps and migrations per test took
 * ~2.5 s locally and ~4.5 s on CI, so a test that opens several databases came near the 20 s timeout.
 */
function migratedTemplate(): Promise<TemplateTable[]> {
  template ??= (async () => {
    const database = `sf_test_tpl_${randomBytes(6).toString("hex")}`;
    const { database: _, ...server } = mysqlOptions(MYSQL_URL!, "");
    const admin = await mysql.createConnection(server);
    await admin.query(`CREATE DATABASE ${database}`);
    try {
      const c = await mysql.createConnection(mysqlOptions(MYSQL_URL!, database));
      try {
        await new MysqlMigrations(c).apply(() => undefined);
        const [names] = await c.query("SELECT table_name AS name FROM information_schema.tables WHERE table_schema = DATABASE() AND table_type = 'BASE TABLE' ORDER BY table_name");
        const out: TemplateTable[] = [];
        for (const { name } of names as { name: string }[]) {
          const [[show]] = (await c.query(`SHOW CREATE TABLE \`${name}\``)) as unknown as [[Record<string, string>]];
          const [rows] = await c.query(`SELECT * FROM \`${name}\``);
          out.push({ ddl: show!["Create Table"]!, rows: rows as Record<string, unknown>[] });
        }
        return out;
      } finally {
        await c.end();
      }
    } finally {
      await admin.query(`DROP DATABASE ${database}`);
      await admin.end();
    }
  })();
  return template;
}

/**
 * A fresh MySQL database holding exactly what `npm run migrate`'s path (MysqlMigrations.apply) builds, not
 * what the store builds: opening a store never applies a step. It is a copy of the migrated template
 * (same DDL, keys, foreign keys and rows), so the store check below still refuses if a step were pending.
 * Every store returned by `open` points at it.
 */
export async function newMysqlDatabase(clock: Clock = new FakeClock()) {
  const tables = await migratedTemplate();
  const db = await newEmptyMysqlDatabase();
  const c = await db.connect();
  await c.query("SET FOREIGN_KEY_CHECKS = 0");
  for (const t of tables) {
    await c.query(t.ddl);
    if (t.rows.length === 0) continue;
    const cols = Object.keys(t.rows[0]!);
    const name = /^CREATE TABLE `(\w+)`/.exec(t.ddl)![1];
    await c.query(`INSERT INTO \`${name}\` (${cols.map((k) => `\`${k}\``).join(", ")}) VALUES ?`, [t.rows.map((r) => cols.map((k) => r[k]))]);
  }
  await c.query("SET FOREIGN_KEY_CHECKS = 1");
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
  return { store, open, connect: db.connect };
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
