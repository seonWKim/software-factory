import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { type Loaded, Plugins, resolveProject } from "../../../compose.js";
import { SQLITE_MIGRATE_MESSAGE, parseMigrateArgs } from "../../../impl/store/mysql/migrate-command.js";
import { type ResolveRepo, runProjectKeyStep } from "../../../impl/store/project-keys.js";
import { migrateSqlite, rehearseSqlite, sqlitePendingSteps } from "../../../impl/store/sqlite/rehearse.js";
import { SqliteDriver } from "../../../impl/store/sqlite/sqlite-driver.js";
import { DRAIN_MARGIN_MS } from "../../../impl/updater/git-worktree.js";
import { withDrain } from "../../../migrate-drain.js";
import { ensureDiscoveredTopicTables } from "../../../runtime/index.js";
import { applyMigrations } from "../../../state/index.js";
import { defineCommand } from "../../command.js";

export default defineCommand({
  names: ["migrate"],
  usage: `  migrate [--status | --dry-run | --rehearse | --contract]
               SQLite: the breaking migrations, then the project-key data step (owner/name →
               github:<host>:<repo id>): --status lists the state and pending steps,
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
