import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { type Loaded, Plugins, resolveProject } from "../../../compose.js";
import { type CopyFromMysql, SQLITE_MIGRATE_MESSAGE, copyFromMysqlCommand, parseMigrateArgs } from "../../../impl/store/mysql/migrate-command.js";
import { type ResolveRepo, runProjectKeyStep } from "../../../impl/store/project-keys.js";
import { migrateSqlite, rehearseSqlite, sqlitePendingSteps } from "../../../impl/store/sqlite/rehearse.js";
import { SqliteDriver } from "../../../impl/store/sqlite/sqlite-driver.js";
import { DRAIN_MARGIN_MS } from "../../../impl/updater/git-worktree.js";
import { secretName } from "../../../interfaces/secret-store.js";
import { withDrain } from "../../../migrate-drain.js";
import { ensureDiscoveredTopicTables } from "../../../runtime/index.js";
import { applyMigrations } from "../../../state/index.js";
import { defineCommand } from "../../command.js";

export default defineCommand({
  names: ["migrate"],
  usage: `  migrate [--status | --dry-run | --rehearse | --contract | --copy-from-mysql [--dry-run] [--replace] [--mysql-host <h>] [--mysql-port <n>] [--mysql-database <d>] [--mysql-user <u>]]
               SQLite: the breaking migrations, then the project-key data step (owner/name →
               github:<host>:<repo id>): --status lists the state and pending steps,
               --dry-run prints what would run and each row it would change, --rehearse runs them on a
               copy and checks no row was lost, no flag applies them (back up first). The other commands
               refuse to start while steps or owner/name rows remain. --contract drops the legacy_* tables
               a rename left, 14 days after it, archiving their rows to db/backups first. --copy-from-mysql
               copies every table of a MySQL store into <state_dir>/db/factory.db (only while the factory
               is stopped; checked per table by row count and primary-key checksum); --dry-run lists the
               tables and row counts, --replace backs an existing file up to db/backups and replaces it.
               The connection comes from --mysql-host (localhost), --mysql-port (3306), --mysql-database
               (software_factory) and --mysql-user (factory); the password is MYSQL_PASSWORD in the secret file`,
  async run(argv, ctx) {
    const args = [...argv];
    // --json (with --status): one JSON line for the supervisor's check. --no-drain: apply without asking a
    // running `factory dev` to drain first (design: Self-update).
    const json = args.includes("--json");
    const noDrain = args.includes("--no-drain");
    const conn = takeMysqlFlags(args.filter((a) => a !== "--json" && a !== "--no-drain"));
    if ("error" in conn) {
      console.log(conn.error);
      return 1;
    }
    const mode = parseMigrateArgs(conn.rest, process.env);
    if (typeof mode === "object" && "error" in mode) {
      console.log(mode.error);
      return 1;
    }
    if (conn.given && typeof mode !== "object") {
      console.log("--mysql-host, --mysql-port, --mysql-database and --mysql-user go with --copy-from-mysql");
      return 1;
    }
    if (json && mode !== "status") {
      console.log("--json goes with --status");
      return 1;
    }
    const loaded = await ctx.load();
    if (typeof mode === "object") return copyFromMysql(loaded, mode, conn.mysql);
    const file = join(loaded.stateDir, "db", "factory.db");
    if (json) {
      // SQLite applies additive migrations on open: only breaking migrations and the data step are pending.
      console.log(JSON.stringify({ pending: await sqlitePendingSteps(file) }));
      return 0;
    }
    const print = (line: string) => console.log(line);
    const run = async (): Promise<number> => {
      // The project-key data step (design 2026-11-01) asks GitHub only when owner/name rows are left.
      const resolveRepo = async (): Promise<ResolveRepo> => {
        const github = await new Plugins(loaded).githubApi();
        return (ownerName) => {
          const [owner = "", name = ""] = ownerName.split("/");
          return resolveProject(github, { owner, name });
        };
      };
      if (mode === "contract") return contract(loaded, file, print);
      if (mode === "rehearse") return rehearseSqlite(file, print);
      print(SQLITE_MIGRATE_MESSAGE);
      await mkdir(join(loaded.stateDir, "db"), { recursive: true, mode: 0o700 });
      return migrateSqlite(file, mode, {
        topicTables: (driver) => ensureDiscoveredTopicTables("sqlite", driver),
        projectKeys: (driver, m) => runProjectKeyStep(driver, resolveRepo, m, print),
      }, print);
    };
    if (mode !== "apply" || noDrain) return run();
    const clock = await new Plugins(loaded).clock();
    return withDrain({ stateDir: loaded.stateDir, clock, print, timeoutMs: loaded.config.run_timeout_ms + DRAIN_MARGIN_MS }, run);
  },
});

const NO_PASSWORD = "MYSQL_PASSWORD missing from the secret file (add the MySQL store's password there for the copy)";

/** The MySQL connection of `--copy-from-mysql`, without the password; each flag has the default setup used to create. */
type MysqlConnection = Pick<Parameters<typeof copyFromMysqlCommand>[0], "host" | "port" | "database" | "user">;

const MYSQL_FLAGS = { "--mysql-host": "host", "--mysql-port": "port", "--mysql-database": "database", "--mysql-user": "user" } as const;

/** Takes the `--mysql-*` flags (`--mysql-host <h>` or `--mysql-host=<h>`) out of `args`; the rest go to parseMigrateArgs. */
function takeMysqlFlags(args: readonly string[]): { mysql: MysqlConnection; given: boolean; rest: string[] } | { error: string } {
  const mysql: MysqlConnection = { host: "localhost", port: 3306, database: "software_factory", user: "factory" };
  const rest: string[] = [];
  let given = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    const eq = arg.indexOf("=");
    const name = eq < 0 ? arg : arg.slice(0, eq);
    if (!(name in MYSQL_FLAGS)) {
      rest.push(arg);
      continue;
    }
    const value = eq < 0 ? args[++i] : arg.slice(eq + 1);
    if (value === undefined || value === "" || value.startsWith("--")) return { error: `${name} needs a value` };
    const key = MYSQL_FLAGS[name as keyof typeof MYSQL_FLAGS];
    if (key === "port") {
      const port = Number(value);
      if (!Number.isInteger(port) || port < 1 || port > 65535) return { error: `${name} needs a port number, got ${value}` };
      mysql.port = port;
    } else mysql[key] = value;
    given = true;
  }
  return { mysql, given, rest };
}

/**
 * `--copy-from-mysql`: reads the MySQL store named by the `--mysql-*` flags; factory.config.json is left as it is.
 * The one place MYSQL_PASSWORD is read from the secret file: the copy is the way off MySQL and goes with the plugin.
 */
async function copyFromMysql(loaded: Loaded, args: CopyFromMysql, conn: MysqlConnection): Promise<number> {
  const print = (line: string) => console.log(line);
  const password = await (await new Plugins(loaded).secrets()).get(secretName("MYSQL_PASSWORD"));
  if (!password) {
    print(NO_PASSWORD);
    return 1;
  }
  const clock = await new Plugins(loaded).clock();
  return copyFromMysqlCommand({ ...conn, password: password.reveal() }, {
    stateDir: loaded.stateDir,
    dryRun: args.dryRun,
    replace: args.replace,
    schema: (driver) => ensureDiscoveredTopicTables("sqlite", driver),
    now: () => clock.now(),
    print,
  });
}

/** `--contract`: the contract migrations whose breaking migration is old enough (RFC 0015 §12 D2, D4). */
async function contract(loaded: Loaded, file: string, print: (line: string) => void): Promise<number> {
  const clock = await new Plugins(loaded).clock();
  const driver = new SqliteDriver(file);
  try {
    const done = await applyMigrations(
      { dialect: "sqlite", all: (s, p) => driver.all(s, p), run: (s, p) => driver.run(s, p) },
      { backupDir: join(loaded.stateDir, "db", "backups"), now: () => clock.now().toISOString(), print, contract: true },
    );
    print(done.length === 0 ? "contract: nothing to apply" : `contract: applied ${done.join(", ")}`);
    return 0;
  } finally {
    await driver.close();
  }
}
