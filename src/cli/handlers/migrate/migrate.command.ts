import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { type Loaded, Plugins, resolveProject } from "../../../compose.js";
import { SQLITE_MIGRATE_MESSAGE, migrateCommand, parseMigrateArgs, pendingStepNames } from "../../../impl/store/mysql/migrate-command.js";
import { MysqlDriver } from "../../../impl/store/mysql/mysql-driver.js";
import { type ResolveRepo, countLegacyProjectRows, runProjectKeyStep } from "../../../impl/store/project-keys.js";
import { migrateSqlite, rehearseSqlite, sqlitePendingSteps } from "../../../impl/store/sqlite/rehearse.js";
import { SqliteDriver } from "../../../impl/store/sqlite/sqlite-driver.js";
import { DRAIN_MARGIN_MS } from "../../../impl/updater/git-worktree.js";
import { secretName } from "../../../interfaces/secret-store.js";
import { withDrain } from "../../../migrate-drain.js";
import { ensureDiscoveredTopicTables } from "../../../runtime/index.js";
import { applyMigrations, type SqlExecutor } from "../../../state/index.js";
import { defineCommand } from "../../command.js";

export default defineCommand({
  names: ["migrate"],
  usage: `  migrate [--status | --dry-run | --rehearse | --contract]
               MySQL schema steps (migrations/mysql/), then the project-key data step (owner/name →
               github:<host>:<repo id>, SQLite too): --status lists the state and pending steps,
               --dry-run prints what would run and each row it would change, --rehearse runs them on a
               copy and checks no row was lost, no flag applies them (back up first). The other commands
               refuse to start while steps or owner/name rows remain. --contract drops the legacy_* tables
               a rename left, 14 days after it, archiving their rows to db/backups first`,
  async run(argv, ctx) {
    const args = [...argv];
    // --json (with --status): one JSON line for the supervisor's check. --no-drain: apply without asking a
    // running `factory dev` to drain first (design: Self-update).
    const json = args.includes("--json");
    const noDrain = args.includes("--no-drain");
    const mode = parseMigrateArgs(args.filter((a) => a !== "--json" && a !== "--no-drain"), process.env);
    if (typeof mode !== "string" || (json && mode !== "status")) {
      console.log(typeof mode !== "string" ? mode.error : "--json goes with --status");
      return 1;
    }
    const loaded = await ctx.load();
    if (json) {
      console.log(JSON.stringify({ pending: await pendingMigrationNames(loaded) }));
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
      const db = loaded.store;
      if (mode === "contract") return contract(loaded, print);
      if (db.type !== "mysql") {
        const file = join(loaded.stateDir, "db", "factory.db");
        if (mode === "rehearse") return rehearseSqlite(file, print);
        print(SQLITE_MIGRATE_MESSAGE);
        await mkdir(join(loaded.stateDir, "db"), { recursive: true, mode: 0o700 });
        return migrateSqlite(file, mode, {
          topicTables: (driver) => ensureDiscoveredTopicTables("sqlite", driver),
          projectKeys: (driver, m) => runProjectKeyStep(driver, resolveRepo, m, print),
        }, print);
      }
      const password = await (await new Plugins(loaded).secrets()).get(secretName("MYSQL_PASSWORD"));
      if (!password) {
        print("MYSQL_PASSWORD missing from the secret file (run: npm run setup)");
        return 1;
      }
      const { host, port, database, user } = db;
      const options = { host, port, database, user, password: password.reveal() };
      const code = await migrateCommand(options, mode, print, join(loaded.stateDir, "db", "backups"));
      if (code !== 0 || mode === "rehearse") return code;
      // After the schema steps: the data step needs the tables they create.
      const driver = new MysqlDriver(options);
      try {
        // Throws while schema steps are pending (only after --status or --dry-run, which apply none).
        const ready = await driver.schemaVersion().then(() => true, () => false);
        if (!ready) {
          print("project keys: listed once the pending schema steps have run (npm run migrate, then --dry-run again)");
          return 0;
        }
        if (mode === "apply") await ensureDiscoveredTopicTables("mysql", driver);
        return await runProjectKeyStep(driver, resolveRepo, mode, print);
      } finally {
        await driver.close();
      }
    };
    if (mode !== "apply" || noDrain) return run();
    const clock = await new Plugins(loaded).clock();
    return withDrain({ stateDir: loaded.stateDir, clock, print, timeoutMs: loaded.config.run_timeout_ms + DRAIN_MARGIN_MS }, run);
  },
});

/** `--contract`: the contract migrations whose breaking migration is old enough (RFC 0015 §12 D2, D4). */
async function contract(loaded: Loaded, print: (line: string) => void): Promise<number> {
  const db = loaded.store;
  const clock = await new Plugins(loaded).clock();
  let driver: SqlExecutor & { close(): Promise<void> };
  if (db.type !== "mysql") driver = new SqliteDriver(join(loaded.stateDir, "db", "factory.db"));
  else {
    const password = await (await new Plugins(loaded).secrets()).get(secretName("MYSQL_PASSWORD"));
    if (!password) {
      print("MYSQL_PASSWORD missing from the secret file (run: npm run setup)");
      return 1;
    }
    driver = new MysqlDriver({ host: db.host, port: db.port, database: db.database, user: db.user, password: password.reveal() });
  }
  try {
    const dialect = db.type === "mysql" ? "mysql" : "sqlite";
    const done = await applyMigrations(
      { dialect, all: (s, p) => driver.all(s, p), run: (s, p) => driver.run(s, p) },
      { backupDir: join(loaded.stateDir, "db", "backups"), now: () => clock.now().toISOString(), print, contract: true },
    );
    print(done.length === 0 ? "contract: nothing to apply" : `contract: applied ${done.join(", ")}`);
    return 0;
  } finally {
    await driver.close();
  }
}

/**
 * The steps `npm run migrate` would apply, by name, read-only: pending MySQL schema step files, then
 * "project keys" while owner/name rows remain (checked only once the schema is current). SQLite applies
 * additive migrations on open, so there only breaking migrations and the data step are reported.
 */
async function pendingMigrationNames(loaded: Loaded): Promise<string[]> {
  const db = loaded.store;
  const legacy = async (driver: SqlExecutor & { close(): Promise<void> }): Promise<string[]> => {
    try {
      const n = await countLegacyProjectRows(driver);
      return n > 0 ? [`project keys (${n} row${n === 1 ? "" : "s"})`] : [];
    } catch {
      return [];
    } finally {
      await driver.close();
    }
  };
  if (db.type !== "mysql") return sqlitePendingSteps(join(loaded.stateDir, "db", "factory.db"));
  const password = await (await new Plugins(loaded).secrets()).get(secretName("MYSQL_PASSWORD"));
  if (!password) throw new Error("MYSQL_PASSWORD missing from the secret file (run: npm run setup)");
  const options = { host: db.host, port: db.port, database: db.database, user: db.user, password: password.reveal() };
  const schema = await pendingStepNames(options);
  return schema.length > 0 ? schema : legacy(new MysqlDriver(options));
}
