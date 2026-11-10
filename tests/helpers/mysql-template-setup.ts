// Vitest global setup (vitest.config.ts): with SF_TEST_MYSQL_URL set, migrates one template database for the whole
// run, and every test file copies its tables (tests/helpers/store.ts, newMigratedMysqlDatabase). Before, each file
// migrated its own template and several tests migrated a fresh database each: ~60 steps, 8-23 s on a loaded CI
// runner, so the first MySQL test of a file came near the 20 s timeout and crossed it on a slower runner (718d322).
// vitest.config.ts loads it only with SF_TEST_MYSQL_URL set. This file runs in vitest's main process, so it imports no test-runtime API.

import { randomBytes } from "node:crypto";
import mysql from "mysql2/promise";
import type { TestProject } from "vitest/node";
import { MysqlMigrations } from "../../src/impl/store/mysql/migrations.js";
import type { MysqlOptions } from "../../src/impl/store/mysql/mysql-driver.js";

declare module "vitest" {
  export interface ProvidedContext {
    /** The run's migrated template database. */
    mysqlTemplate: string;
  }
}

export function mysqlOptions(url: string, database: string): MysqlOptions {
  const u = new URL(url);
  return {
    host: u.hostname,
    port: Number(u.port || 3306),
    user: decodeURIComponent(u.username),
    password: decodeURIComponent(u.password),
    database,
  };
}

export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  const url = process.env.SF_TEST_MYSQL_URL!;
  const database = `sf_test_tpl_${randomBytes(6).toString("hex")}`;
  const { database: _, ...server } = mysqlOptions(url, "");
  const admin = await mysql.createConnection(server);
  await admin.query(`CREATE DATABASE ${database}`);
  const c = await mysql.createConnection(mysqlOptions(url, database));
  try {
    await new MysqlMigrations(c).apply(() => undefined);
  } finally {
    await c.end();
  }
  project.provide("mysqlTemplate", database);
  return async () => {
    await admin.query(`DROP DATABASE ${database}`);
    await admin.end();
  };
}
