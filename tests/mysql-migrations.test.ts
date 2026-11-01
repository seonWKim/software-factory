import { execFileSync, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import mysql from "mysql2/promise";
import { beforeAll, describe, expect, it } from "vitest";
import { FakeClock } from "../src/impl/clock/fake-clock.js";
import { BACKUP_REMINDER, SQLITE_MIGRATE_MESSAGE, parseMigrateArgs, runMigrate } from "../src/impl/store/mysql/migrate-command.js";
import { BASELINE_STATE, MysqlMigrations, type Queryable, pendingMessage } from "../src/impl/store/mysql/migrations.js";
import { MysqlDriver } from "../src/impl/store/mysql/mysql-driver.js";
import { BASELINE } from "../src/impl/store/mysql/schema.js";
import { SqlFactoryStore } from "../src/impl/store/sql/sql-factory-store.js";
import { MYSQL_URL, newEmptyMysqlDatabase, newStore } from "./helpers/store.js";

const REPO = process.cwd();

// --- no MySQL needed ------------------------------------------------------------------------------------

describe("npm run migrate: arguments", () => {
  it("--status, --dry-run, no flag; also as npm config (npm run migrate --status)", () => {
    expect(parseMigrateArgs([])).toBe("apply");
    expect(parseMigrateArgs(["--status"])).toBe("status");
    expect(parseMigrateArgs(["--dry-run"])).toBe("dry-run");
    expect(parseMigrateArgs([], { npm_config_status: "true" })).toBe("status");
    expect(parseMigrateArgs([], { npm_config_dry_run: "true" })).toBe("dry-run");
    expect(parseMigrateArgs(["--status", "--dry-run"])).toEqual({ error: expect.stringContaining("one of") });
    expect(parseMigrateArgs(["--down"])).toEqual({ error: expect.stringContaining("--down") });
  });

  it("the pending message names npm run migrate and fits doctor's 120 characters", () => {
    const msg = pendingMessage({ state: null, latest: 9999, pending: Array.from({ length: 999 }, () => ({ number: 1, label: "", kind: "sql" as const })), refusal: null });
    expect(msg).toContain("npm run migrate");
    expect(msg.length).toBeLessThanOrEqual(120);
  });
});

describe("SQLite behaves as before", () => {
  it("still builds the latest schema on open", async () => {
    const { store } = await newStore();
    const v = await store.schemaVersion();
    expect(v.applied).toBe(v.latest);
  });

  it("npm run migrate on a SQLite config runs no schema scripts, only the project-key data step", async () => {
    const app = await compiledApp();
    const work = workDir({ type: "sqlite" });
    const r = app.run(work, ["migrate"], {});
    expect(r.stdout).toContain(SQLITE_MIGRATE_MESSAGE);
    // An empty database has no owner/name rows, so GitHub is never asked (this work dir has no credentials).
    expect(r.stdout).toContain("project keys: nothing to rewrite");
    expect(r.status).toBe(0);
  }, 120_000);
});

// --- MySQL ------------------------------------------------------------------------------------------------

describe.skipIf(!MYSQL_URL)("npm run migrate on MySQL", () => {
  it("existing database at the current schema: creates schema_state, records 11, runs no schema or data statements", async () => {
    const db = await newEmptyMysqlDatabase();
    const c = await db.connect();
    await buildLegacy(c);
    await c.query("INSERT INTO cursors (name, value) VALUES ('x', 'y')");
    const before = await snapshot(c);
    const lines: string[] = [];
    expect(await runMigrate(c, "apply", (l) => lines.push(l), { dir: steps({}) })).toBe(0);
    expect(await state(c)).toBe(BASELINE_STATE);
    expect(await snapshot(c)).toEqual(before);
    expect(lines.join("\n")).toContain("no statements");
  });

  it("empty database: builds the state-11 baseline and records 11", async () => {
    const legacy = await newEmptyMysqlDatabase();
    const lc = await legacy.connect();
    await buildLegacy(lc);
    const db = await newEmptyMysqlDatabase();
    const c = await db.connect();
    expect(await runMigrate(c, "apply", () => undefined, { dir: steps({}) })).toBe(0);
    expect(await state(c)).toBe(BASELINE_STATE);
    expect(await snapshot(c)).toEqual(await snapshot(lc));
  });

  it("applies two pending steps in number order, recording the state after each", async () => {
    const c = await atBaseline();
    const dir = steps({
      "0012-note.sql": "-- a column\nALTER TABLE cursors ADD COLUMN note TEXT NULL;\n",
      "0013-fill.sql": "INSERT INTO cursors (name, value, note) VALUES ('a', 'b', 'filled');\n",
    });
    expect(await runMigrate(c, "apply", () => undefined, { dir })).toBe(0);
    expect(await state(c)).toBe(13);
    expect(await rows(c, "SELECT note FROM cursors WHERE name = 'a'")).toEqual([{ note: "filled" }]);
  });

  it("a failing second step leaves the state at the first step's number", async () => {
    const c = await atBaseline();
    const dir = steps({
      "0012-note.sql": "ALTER TABLE cursors ADD COLUMN note TEXT NULL;\n",
      "0013-broken.sql": "UPDATE no_such_table SET x = 1;\n",
    });
    const lines: string[] = [];
    expect(await runMigrate(c, "apply", (l) => lines.push(l), { dir })).toBe(1);
    expect(await state(c)).toBe(12);
    expect(lines.join("\n")).toContain("no_such_table");
  });

  it("refuses, and changes nothing, when the state is ahead of the newest step file", async () => {
    const c = await atBaseline();
    await c.query("UPDATE schema_state SET state = 15 WHERE id = 1");
    const dir = steps({ "0012-note.sql": "ALTER TABLE cursors ADD COLUMN note TEXT NULL;\n" });
    const before = await snapshot(c, true);
    const lines: string[] = [];
    expect(await runMigrate(c, "apply", (l) => lines.push(l), { dir })).toBe(1);
    expect(lines.join("\n")).toMatch(/refusing.*ahead/);
    expect(await snapshot(c, true)).toEqual(before);
    expect(await state(c)).toBe(15);
  });

  it("--status prints the state and the pending steps, and none when up to date", async () => {
    const c = await atBaseline();
    const dir = steps({ "0012-a.sql": "SELECT 1;\n", "0013-b.sql": "SELECT 2;\n" });
    let lines: string[] = [];
    expect(await runMigrate(c, "status", (l) => lines.push(l), { dir })).toBe(0);
    expect(lines).toEqual(["state: 11 (latest step: 13)", "pending:", "  0012  0012-a.sql", "  0013  0013-b.sql"]);
    await runMigrate(c, "apply", () => undefined, { dir });
    lines = [];
    expect(await runMigrate(c, "status", (l) => lines.push(l), { dir })).toBe(0);
    expect(lines).toEqual(["state: 13 (latest step: 13)", "pending: none (up to date)"]);
  });

  it("--dry-run prints the SQL of a .sql step and the rows a .ts step would change; state and schema unchanged", async () => {
    const c = await atBaseline();
    await c.query("INSERT INTO cursors (name, value) VALUES ('c1', 'old'), ('c2', 'keep')");
    const dir = steps({ "0012-note.sql": "ALTER TABLE cursors ADD COLUMN note TEXT NULL;\n", "0013-rename.ts": TS_STEP });
    const before = await snapshot(c, true);
    const lines: string[] = [];
    expect(await runMigrate(c, "dry-run", (l) => lines.push(l), { dir })).toBe(0);
    const out = lines.join("\n");
    expect(out).toContain("ALTER TABLE cursors ADD COLUMN note TEXT NULL;");
    expect(out).toContain("1 row would change");
    expect(out).toContain(JSON.stringify({ name: "c1" }));
    expect(out).not.toContain("c2");
    expect(await snapshot(c, true)).toEqual(before);
    expect(await state(c)).toBe(BASELINE_STATE);
  });

  it("a .ts step runs through apply in one transaction with the state", async () => {
    const c = await atBaseline();
    await c.query("INSERT INTO cursors (name, value) VALUES ('c1', 'old')");
    expect(await runMigrate(c, "apply", () => undefined, { dir: steps({ "0012-rename.ts": TS_STEP }) })).toBe(0);
    expect(await state(c)).toBe(12);
    expect(await rows(c, "SELECT value FROM cursors WHERE name = 'c1'")).toEqual([{ value: "new" }]);
  });

  it("a .ts step compiled by the migrations build (no source next to it) runs through npm run migrate", async () => {
    const c = await atBaseline();
    await c.query("INSERT INTO cursors (name, value) VALUES ('c1', 'old')");
    const root = mkdtempSync(join(tmpdir(), "sf-ts-step-"));
    const dir = join(root, "migrations", "mysql");
    mkdirSync(dir, { recursive: true });
    cpSync(join(REPO, "migrations", "step.d.ts"), join(root, "migrations", "step.d.ts"));
    writeFileSync(join(dir, "0012-rename.ts"), TS_STEP);
    writeFileSync(join(root, "package.json"), JSON.stringify({ type: "module" }));
    writeFileSync(
      join(root, "tsconfig.json"),
      JSON.stringify({ extends: join(REPO, "tsconfig.migrations.json"), compilerOptions: { rootDir: ".", outDir: "dist", types: [] }, include: ["migrations/**/*.ts"] }),
    );
    execFileSync(join(REPO, "node_modules", ".bin", "tsc"), ["-p", join(root, "tsconfig.json")], { stdio: "pipe" });
    // The compiled file is what loads: break the source so only dist/ can work.
    writeFileSync(join(dir, "0012-rename.ts"), "export default 42;\n");
    expect(await runMigrate(c, "apply", () => undefined, { dir })).toBe(0);
    expect(await rows(c, "SELECT value FROM cursors WHERE name = 'c1'")).toEqual([{ value: "new" }]);
  }, 60_000);

  it("running it twice applies nothing the second time and exits 0", async () => {
    const db = await newEmptyMysqlDatabase();
    const c = await db.connect();
    const dir = steps({ "0012-note.sql": "ALTER TABLE cursors ADD COLUMN note TEXT NULL;\n" });
    expect(await runMigrate(c, "apply", () => undefined, { dir })).toBe(0);
    const before = await snapshot(c, true);
    const lines: string[] = [];
    expect(await runMigrate(c, "apply", (l) => lines.push(l), { dir })).toBe(0);
    expect(lines).toEqual([BACKUP_REMINDER, "up to date at state 12: nothing to apply"]);
    expect(await snapshot(c, true)).toEqual(before);
  });

  it("opening the store on an outdated database changes nothing; migrate() and schemaVersion() refuse", async () => {
    const db = await newEmptyMysqlDatabase();
    const c = await db.connect();
    await buildLegacy(c); // the old auto-applied schema: no schema_state yet
    const before = await snapshot(c, true);
    const store = new SqlFactoryStore(new MysqlDriver({ ...db.options, stepsDir: steps({}) }), new FakeClock());
    db.onCleanup(() => store.close());
    await expect(store.migrate()).rejects.toThrow(/npm run migrate/);
    await expect(store.schemaVersion()).rejects.toThrow(/npm run migrate/);
    expect(await snapshot(c, true)).toEqual(before);

    // At state 11 with a pending step file: same refusal, and the step does not run.
    await new MysqlMigrations(c, { dir: steps({}) }).apply(() => undefined);
    const behind = new SqlFactoryStore(
      new MysqlDriver({ ...db.options, stepsDir: steps({ "0012-note.sql": "ALTER TABLE cursors ADD COLUMN note TEXT NULL;\n" }) }),
      new FakeClock(),
    );
    db.onCleanup(() => behind.close());
    const at11 = await snapshot(c, true);
    await expect(behind.migrate()).rejects.toThrow("1 schema step pending (state 11, latest 12): run `npm run migrate`");
    expect(await snapshot(c, true)).toEqual(at11);
  });

  it("a store on an up-to-date database starts", async () => {
    const db = await newEmptyMysqlDatabase();
    const dir = steps({});
    await new MysqlMigrations(await db.connect(), { dir }).apply(() => undefined);
    const store = new SqlFactoryStore(new MysqlDriver({ ...db.options, stepsDir: dir }), new FakeClock());
    db.onCleanup(() => store.close());
    await store.migrate();
    expect(await store.schemaVersion()).toEqual({ applied: BASELINE_STATE, latest: BASELINE_STATE });
  });

  describe("the commands, end to end on the built code", () => {
    let app: App;
    beforeAll(async () => {
      app = await compiledApp();
    }, 120_000);

    it("dev, worker, controller, status, ui and golden add exit non-zero with `npm run migrate`; doctor FAILs; nothing is applied", async () => {
      const db = await newEmptyMysqlDatabase();
      const c = await db.connect();
      await buildLegacy(c);
      const env = await mysqlEnv(db.database, db.onCleanup);
      const work = workDir(env.store);
      const before = await snapshot(c, true);
      for (const args of [["dev"], ["worker"], ["controller"], ["status"], ["ui"], ["golden", "add", "1"]]) {
        const r = app.run(work, args, env.vars);
        expect(r.status, args.join(" ")).not.toBe(0);
        expect(r.stdout + r.stderr, args.join(" ")).toContain("npm run migrate");
      }
      const doctor = app.run(work, ["doctor"], env.vars);
      expect(doctor.stdout).toMatch(/^FAIL {2}MySQL .*: 1 schema step pending \(state none, latest 11\): run `npm run migrate`$/m);
      expect(await snapshot(c, true)).toEqual(before);

      // npm run migrate itself, then the same commands get past the check (status prints and exits 0).
      expect(app.run(work, ["migrate", "--status"], env.vars).stdout).toContain("0011  baseline: record state 11");
      const migrated = app.run(work, ["migrate"], env.vars);
      expect(migrated.status).toBe(0);
      expect(migrated.stdout).toContain(BACKUP_REMINDER);
      expect(await state(c)).toBe(BASELINE_STATE);
      expect(app.run(work, ["migrate", "--status"], env.vars).stdout).toContain("pending: none (up to date)");
      // Past the schema check now: whatever status needs next, it no longer asks for npm run migrate.
      const status = app.run(work, ["status"], env.vars);
      expect(status.stdout + status.stderr).not.toContain("npm run migrate");
    }, 120_000);
  });
});

// --- helpers --------------------------------------------------------------------------------------------

const TS_STEP = `import type { DataStep } from "../step.js";

const step: DataStep = {
  async plan(db) {
    return db.all("SELECT name FROM cursors WHERE value = ?", ["old"]);
  },
  async apply(db) {
    await db.run("UPDATE cursors SET value = ? WHERE value = ?", ["new", "old"]);
  },
};

export default step;
`;

/** The schema exactly as the old driver built it on every open: the groups plus schema_migrations 1..11. */
async function buildLegacy(c: Queryable): Promise<void> {
  await c.query("CREATE TABLE schema_migrations (version INT NOT NULL PRIMARY KEY)");
  for (let v = 1; v <= BASELINE.length; v++) {
    for (const st of BASELINE[v - 1]!) await c.query(st);
    await c.query("INSERT INTO schema_migrations (version) VALUES (?)", [v]);
  }
}

async function atBaseline(): Promise<Queryable> {
  const db = await newEmptyMysqlDatabase();
  const c = await db.connect();
  await new MysqlMigrations(c, { dir: steps({}) }).apply(() => undefined);
  return c;
}

async function rows(c: Queryable, sql: string): Promise<unknown[]> {
  const [r] = await c.query(sql);
  return (r as Record<string, unknown>[]).map((x) => ({ ...x }));
}

async function state(c: Queryable): Promise<number> {
  const [r] = (await rows(c, "SELECT state FROM schema_state WHERE id = 1")) as { state: number }[];
  return Number(r!.state);
}

/** Tables, columns, indexes and every row, without schema_state unless `withState`. */
async function snapshot(c: Queryable, withState = false): Promise<unknown> {
  const skip = withState ? "" : " AND table_name <> 'schema_state'";
  const tables = (await rows(c, `SELECT table_name AS t FROM information_schema.tables WHERE table_schema = DATABASE()${skip} ORDER BY t`)) as { t: string }[];
  const data: Record<string, unknown> = {};
  for (const { t } of tables) data[t] = await rows(c, `SELECT * FROM \`${t}\` ORDER BY 1`);
  return {
    columns: await rows(
      c,
      `SELECT table_name AS t, column_name AS c, column_type AS type, is_nullable AS n, column_default AS d, extra AS e
       FROM information_schema.columns WHERE table_schema = DATABASE()${skip} ORDER BY t, ordinal_position`,
    ),
    indexes: await rows(
      c,
      `SELECT table_name AS t, index_name AS i, column_name AS c, seq_in_index AS s, non_unique AS u
       FROM information_schema.statistics WHERE table_schema = DATABASE()${skip} ORDER BY t, i, s`,
    ),
    data,
  };
}

/** A throwaway steps directory (…/migrations/mysql) holding `files`. */
function steps(files: Record<string, string>): string {
  const dir = join(mkdtempSync(join(tmpdir(), "sf-mysql-steps-")), "migrations", "mysql");
  mkdirSync(dir, { recursive: true });
  for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, name), body);
  return dir;
}

interface App {
  run(cwd: string, args: string[], env: Record<string, string>): { status: number | null; stdout: string; stderr: string };
}

let built: App | undefined;

/** src/ compiled to a throwaway root (its migrations/mysql is empty: latest state 11), run as `node dist/main.js`. */
async function compiledApp(): Promise<App> {
  if (built) return built;
  const root = mkdtempSync(join(tmpdir(), "sf-app-"));
  execFileSync(join(REPO, "node_modules", ".bin", "tsc"), ["-p", join(REPO, "tsconfig.json"), "--outDir", join(root, "dist")], { stdio: "pipe" });
  writeFileSync(join(root, "package.json"), JSON.stringify({ type: "module" }));
  symlinkSync(join(REPO, "node_modules"), join(root, "node_modules"));
  mkdirSync(join(root, "migrations", "mysql"), { recursive: true });
  built = {
    run: (cwd, args, env) => {
      const r = spawnSync(process.execPath, ["--disable-warning=ExperimentalWarning", join(root, "dist", "main.js"), ...args], {
        cwd,
        env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", SOFTWARE_FACTORY_SECRETS_FILE: join(cwd, "no-secrets.env"), ...env },
        encoding: "utf8",
        timeout: 30_000,
      });
      return { status: r.status, stdout: r.stdout, stderr: r.stderr };
    },
  };
  return built;
}

/** A working directory with the repo's config (store replaced, updater none) and prompts. */
function workDir(store: Record<string, unknown>): string {
  const dir = mkdtempSync(join(tmpdir(), "sf-work-"));
  const cfg = JSON.parse(readFileSync(join(REPO, "factory.config.json"), "utf8")) as Record<string, unknown> & { plugins: Record<string, string> };
  cfg.store = store;
  cfg.plugins = { ...cfg.plugins, updater: "none" };
  cfg.state_dir = ".state";
  writeFileSync(join(dir, "factory.config.json"), JSON.stringify(cfg));
  cpSync(join(REPO, "prompts"), join(dir, "prompts"), { recursive: true });
  return dir;
}

/** A MySQL user with a password (the store needs MYSQL_PASSWORD) and a secret file that names it. */
async function mysqlEnv(database: string, onCleanup: (f: () => Promise<void>) => void) {
  const u = new URL(MYSQL_URL!);
  const admin = await mysql.createConnection({ host: u.hostname, port: Number(u.port || 3306), user: decodeURIComponent(u.username), password: decodeURIComponent(u.password) });
  const user = `sf_e2e_${randomBytes(4).toString("hex")}`;
  const password = `Pw1!${randomBytes(12).toString("hex")}`;
  await admin.query(`CREATE USER '${user}'@'%' IDENTIFIED BY '${password}'`);
  await admin.query(`GRANT ALL ON ${database}.* TO '${user}'@'%'`);
  onCleanup(async () => {
    await admin.query(`DROP USER '${user}'@'%'`);
    await admin.end();
  });
  const file = join(mkdtempSync(join(tmpdir(), "sf-secrets-")), ".env");
  writeFileSync(file, `MYSQL_PASSWORD=${password}\n`);
  chmodSync(file, 0o600);
  return {
    store: { type: "mysql", host: u.hostname, port: Number(u.port || 3306), database, user },
    vars: { SOFTWARE_FACTORY_SECRETS_FILE: file },
  };
}
