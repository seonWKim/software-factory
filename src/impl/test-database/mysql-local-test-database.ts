import mysql from "mysql2/promise";
import type { TestDatabase, TestDatabaseLease } from "../../interfaces/test-database.js";

/** The env name the check commands read (tests/helpers/store.ts). */
export const TEST_MYSQL_URL_ENV = "SF_TEST_MYSQL_URL";

/** Every database this plugin creates or drops starts with this; it refuses any other name. */
export const TEST_DATABASE_PREFIX = "sf_test_";

/** MySQL's limit on a database name. */
const MAX_NAME = 64;

/** The part of a MySQL connection this plugin uses. */
export interface AdminConnection {
  query(sql: string): Promise<unknown>;
  end(): Promise<void>;
}

/** Opens a connection to the server (no database selected). Injected so tests need no MySQL server. */
export type AdminConnect = (server: { host: string; port: number; user: string; password: string }) => Promise<AdminConnection>;

export const mysqlConnect: AdminConnect = (server) => mysql.createConnection(server);

/** `sf_test_<run id>`, with anything but letters, digits and `_` turned into `_`, so a later sweep can find it. */
export function testDatabaseName(runId: string): string {
  return `${TEST_DATABASE_PREFIX}${runId.replace(/[^A-Za-z0-9_]/g, "_")}`.slice(0, MAX_NAME);
}

/** Throws unless `name` is `sf_test_` followed by letters, digits and `_` only, at most 64 characters. */
export function assertTestDatabaseName(name: string): void {
  if (!name.startsWith(TEST_DATABASE_PREFIX) || !/^[A-Za-z0-9_]+$/.test(name) || name.length > MAX_NAME || name === TEST_DATABASE_PREFIX) {
    throw new Error(`refusing database ${JSON.stringify(name)}: the test database plugin only touches ${TEST_DATABASE_PREFIX}* databases`);
  }
}

/**
 * A local, test-only MySQL server (SET_UP.md). The admin URL (`mysql://user:password@host:port`) comes from the
 * secret file. Per run: CREATE DATABASE `sf_test_<run id>`, and the check commands get SF_TEST_MYSQL_URL, the
 * same user's URL with that database as its path. release() drops it. Only `sf_test_*` names are ever created
 * or dropped, so a wrong name can never reach the factory's own data.
 */
export class MysqlLocalTestDatabase implements TestDatabase {
  constructor(
    /** The admin URL, revealed only here, at the point of use. */
    private readonly adminUrl: () => string,
    private readonly connect: AdminConnect = mysqlConnect,
  ) {}

  async create(run_id: string): Promise<TestDatabaseLease> {
    const name = testDatabaseName(run_id);
    const admin = parseAdminUrl(this.adminUrl());
    await this.createDatabase(name);
    const url = new URL(admin.url.href);
    url.pathname = `/${name}`;
    const password = admin.server.password;
    const redact = [url.href, admin.url.href, url.password, password, encodeURIComponent(password)].filter((v) => v !== "");
    let released = false;
    return {
      env: { [TEST_MYSQL_URL_ENV]: url.href },
      redact: [...new Set(redact)].sort((a, b) => b.length - a.length),
      skipped: null,
      release: async () => {
        if (released) return;
        released = true;
        await this.dropDatabase(name);
      },
    };
  }

  /** CREATE DATABASE for an `sf_test_*` name; any other name throws before a connection is opened. */
  async createDatabase(name: string): Promise<void> {
    assertTestDatabaseName(name);
    await this.withAdmin((c) => c.query(`CREATE DATABASE \`${name}\``));
  }

  /** DROP DATABASE IF EXISTS for an `sf_test_*` name; any other name throws before a connection is opened. */
  async dropDatabase(name: string): Promise<void> {
    assertTestDatabaseName(name);
    await this.withAdmin((c) => c.query(`DROP DATABASE IF EXISTS \`${name}\``));
  }

  private async withAdmin(fn: (c: AdminConnection) => Promise<unknown>): Promise<void> {
    const c = await this.connect(parseAdminUrl(this.adminUrl()).server);
    try {
      await fn(c);
    } finally {
      await c.end().catch(() => undefined);
    }
  }
}

/** Checks the admin URL's shape. The error never includes the URL, which holds the password. */
export function parseAdminUrl(raw: string): { url: URL; server: { host: string; port: number; user: string; password: string } } {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new Error("TEST_MYSQL_URL is not a URL; expected mysql://user:password@host:port (SET_UP.md)");
  }
  if (url.protocol !== "mysql:" || !url.hostname || !url.username) {
    throw new Error("TEST_MYSQL_URL must look like mysql://user:password@host:port (SET_UP.md)");
  }
  url.pathname = "";
  return {
    url,
    server: {
      host: url.hostname,
      port: Number(url.port || 3306),
      user: decodeURIComponent(url.username),
      password: decodeURIComponent(url.password),
    },
  };
}
