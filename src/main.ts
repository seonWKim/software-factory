#!/usr/bin/env node
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { CODE_ROOT_ENV, type Loaded, Plugins, build, buildStatsStore, buildUiParts, loadConfig, resolveProject, uiPort } from "./compose.js";
import { runCanary } from "./canary.js";
import { configFailLines } from "./config-keys.js";
import { collectStats, formatStatsText } from "./core/stats.js";
import { addCase, buildGoldenRunDeps, formatReport, parseAddArgs, parseRunArgs, runCases } from "./golden.js";
import { llmCheckFromPlugins, parseLlmCheckArgs } from "./llm-check.js";
import { GitHubClient } from "./impl/github/github-client.js";
import type { WorkItemId } from "./core/types.js";
import { type SecretName, secretName } from "./interfaces/secret-store.js";
import { doctor, doctorChecks, setup } from "./setup.js";
import { SUPERVISED_ENV, processChannel, runDev, runDevChild } from "./supervisor.js";
import { HealthMonitor } from "./ui/health.js";
import { startUi } from "./ui/server.js";
import { readFactoryStatus } from "./ui/factory-status.js";
import { CHILD_ERROR_MESSAGE, SUPERVISOR_STATUS_FILE } from "./interfaces/updater.js";
import { ISSUE_USAGE, parseIssueArgs, runIssue } from "./issue-cmd.js";
import { SQLITE_MIGRATE_MESSAGE, migrateCommand, parseMigrateArgs } from "./impl/store/mysql/migrate-command.js";
import { MysqlDriver } from "./impl/store/mysql/mysql-driver.js";
import { type ResolveRepo, runProjectKeyStep } from "./impl/store/project-keys.js";
import { SqliteDriver } from "./impl/store/sqlite/sqlite-driver.js";

const USAGE = `factory <command>

  setup        one-time setup: secret file, tokens (hidden prompt), label, checks, canary
               --rotate-github / --rotate-claude / --rotate-mysql to replace a stored credential
  dev          controller + worker in one process (Phase 1 default); under the git-worktree updater
               it runs them from a built copy of origin/<base_branch> and restarts on new commits
  controller   intake, run outcomes, reaper
  worker       claims and executes agent runs
  status [id]  work items, or one item's state_changes trail
  stats        per-tier counts of closed items, feedback rate, /reject, /retry, token_cost (read-only)
               --json for one JSON object
  ui           read-only status page at http://127.0.0.1:<ui.port>/ (default 4310); no controller or worker
  migrate [--status | --dry-run]
               MySQL schema steps (migrations/mysql/), then the project-key data step (owner/name →
               github:<host>:<repo id>, SQLite too): --status lists the state and pending steps,
               --dry-run prints what would run and each row it would change, no flag applies them
               (back up first). The other commands refuse to start while steps or owner/name rows remain
  doctor [--llm]
               checks setup without printing any secret; --llm adds one line that runs llm-check
  llm-check [--model cheap|strong]
               two small real calls to the configured LLM provider (plugins.llm), one plain and one
               with an output schema; default --model cheap; every line is egress-scanned first
  canary       G6: a real agent tries to find a planted canary secret
  issue        create / comment / title / sub-issue through the factory's GitHub login (the bot with github_auth "app")
  golden add <pr> [--expect should_flag|should_pass] [--force]
               writes golden/cases/<pr>/ (diff.patch, spec.md, case.json) from a factory PR's record;
               egress-scanned first, nothing written on a finding; a clean merge needs --expect should_pass
  golden run --agent reviewer
               replays every golden case through the reviewer (no push, no GitHub writes), prints
               catch_rate and false_alarm_rate, writes <state_dir>/golden/results/<timestamp>.json.
               With the noop sandbox the agent runs as the host user: test environment only (design §5)`;

/** Controller and/or worker in this process until `signal` aborts. */
async function runLoops(loaded: Loaded, cmd: "dev" | "controller" | "worker", signal: AbortSignal): Promise<void> {
  const app = await build(loaded);
  const loops = [];
  if (cmd !== "worker") loops.push(app.controller.run(signal));
  if (cmd !== "controller") loops.push(app.worker.run(signal));
  await Promise.all(loops);
  await app.close();
}

function stopOnSignals(): AbortSignal {
  const stop = new AbortController();
  for (const sig of ["SIGINT", "SIGTERM"] as const) process.once(sig, () => stop.abort());
  return stop.signal;
}

async function main(cmd: string | undefined, args: string[]): Promise<number> {
  // The supervisor sets the code root (its runtime copy) for its child; state stays in the cwd (main checkout).
  const load = () => loadConfig(process.cwd(), { codeRoot: process.env[CODE_ROOT_ENV] });
  if (cmd === "doctor") {
    // A config that does not load is a doctor finding: one FAIL line per problem, no stack, exit 1.
    let loaded: Loaded;
    try {
      loaded = await load();
    } catch (err) {
      for (const line of configFailLines(err)) console.log(line);
      return 1;
    }
    return doctor(loaded, { llm: args.includes("--llm") });
  }
  const loaded = await load();
  switch (cmd) {
    case "dev": {
      if (process.env[SUPERVISED_ENV] === "1" && process.send) {
        // Child of the supervisor: a drain (IPC) stops claiming; SIGTERM stays the hard stop.
        const channel = processChannel();
        const stop = new AbortController();
        for (const sig of ["SIGINT", "SIGTERM"] as const) process.once(sig, () => stop.abort());
        process.once("disconnect", () => stop.abort()); // the supervisor is gone: never run as an orphan
        const app = await build(loaded);
        await runDevChild(app, channel, stop.signal);
        await app.close();
        return 0;
      }
      return runDev(loaded, (signal) => runLoops(loaded, "dev", signal));
    }
    case "controller":
    case "worker":
      await runLoops(loaded, cmd, stopOnSignals());
      return 0;
    case "status": {
      const app = await build(loaded);
      if (args[0]) {
        const id = args[0] as WorkItemId;
        console.log(JSON.stringify({ item: await app.store.getWorkItem(id), runs: await app.store.listRuns(id), state_changes: await app.store.listStateChanges(id) }, null, 2));
      } else {
        const items = await app.store.listWorkItems(50);
        console.table(items.map(({ id, source, stage, blocked_on, blocked_reason, tier, loop_count, pr_number, version }) =>
          ({ id, source: source.id, stage, blocked_on, blocked_reason, tier, loop_count, pr_number, version })));
      }
      await app.close();
      return 0;
    }
    case "stats": {
      // Read-only: no build() (it migrates), no transition. Changes no dial.
      const store = await buildStatsStore(loaded);
      try {
        const report = await collectStats(store, loaded.stats);
        console.log(args.includes("--json") ? JSON.stringify(report, null, 2) : formatStatsText(report));
      } finally {
        await store.close();
      }
      return 0;
    }
    case "ui": {
      const parts = await buildUiParts(loaded);
      const ui = await startUi(
        {
          store: parts.store,
          scanner: parts.scanner,
          clock: parts.clock,
          lease_ms: loaded.config.lease_ms,
          // `label` is the stored project label (github.com/owner/name), never the key.
          prUrl: (label, n) => `https://${label}/pull/${n}`,
          // The same checks as `factory doctor` (without --llm: opening the page makes no model call).
          health: new HealthMonitor(() => doctorChecks(loaded), parts.clock),
          // What the supervisor (`factory dev`) is doing: the banner explains drains and when settings apply.
          factoryStatus: () => readFactoryStatus(join(loaded.stateDir, SUPERVISOR_STATUS_FILE), loaded.config.workers),
        },
        uiPort(loaded.file.ui),
      );
      console.log(`status page: http://${ui.address}:${ui.port}/ (read-only; Ctrl-C to stop)`);
      const signal = stopOnSignals();
      await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
      await ui.close();
      await parts.close();
      return 0;
    }
    case "migrate": {
      const mode = parseMigrateArgs(args, process.env);
      if (typeof mode !== "string") {
        console.log(mode.error);
        return 1;
      }
      const print = (line: string) => console.log(line);
      // The project-key data step (design 2026-11-01) asks GitHub only when owner/name rows are left.
      const resolveRepo = async (): Promise<ResolveRepo> => {
        const p = new Plugins(loaded);
        const github = new GitHubClient(await p.githubCredentials(await p.secrets(), await p.clock()));
        return (ownerName) => {
          const [owner = "", name = ""] = ownerName.split("/");
          return resolveProject(github, { owner, name });
        };
      };
      const db = loaded.store;
      if (db.type !== "mysql") {
        print(SQLITE_MIGRATE_MESSAGE);
        await mkdir(join(loaded.stateDir, "db"), { recursive: true, mode: 0o700 });
        const driver = new SqliteDriver(join(loaded.stateDir, "db", "factory.db"));
        try {
          await driver.migrate();
          return await runProjectKeyStep(driver, resolveRepo, mode, print);
        } finally {
          await driver.close();
        }
      }
      const password = await (await new Plugins(loaded).secrets()).get(secretName("MYSQL_PASSWORD"));
      if (!password) {
        console.log("MYSQL_PASSWORD missing from the secret file (run: npm run setup)");
        return 1;
      }
      const { host, port, database, user } = db;
      const options = { host, port, database, user, password: password.reveal() };
      const code = await migrateCommand(options, mode, print);
      if (code !== 0) return code;
      // After the schema steps: the data step needs the tables they create.
      const driver = new MysqlDriver(options);
      try {
        // Throws while schema steps are pending (only after --status or --dry-run, which apply none).
        const ready = await driver.schemaVersion().then(() => true, () => false);
        if (!ready) {
          print("project keys: listed once the pending schema steps have run (npm run migrate, then --dry-run again)");
          return 0;
        }
        return await runProjectKeyStep(driver, resolveRepo, mode, print);
      } finally {
        await driver.close();
      }
    }
    case "setup": {
      const rotate: SecretName[] = [];
      if (args.includes("--rotate-github")) rotate.push(secretName("GITHUB_TOKEN"));
      if (args.includes("--rotate-claude")) rotate.push(secretName("CLAUDE_CODE_OAUTH_TOKEN"));
      if (args.includes("--rotate-mysql")) rotate.push(secretName("MYSQL_PASSWORD"));
      return setup(loaded, { rotate });
    }
    case "llm-check": {
      const parsed = parseLlmCheckArgs(args);
      if ("error" in parsed) {
        console.log(parsed.error);
        return 1;
      }
      const r = await llmCheckFromPlugins(new Plugins(loaded), parsed.model, (line) => console.log(line));
      return r.ok ? 0 : 1;
    }
    case "golden":
      return golden(loaded, args[0], args.slice(1));
    case "issue": {
      const action = parseIssueArgs(args);
      if (!action) {
        console.error(ISSUE_USAGE);
        return 1;
      }
      const p = new Plugins(loaded);
      const secrets = await p.secrets();
      const client = new GitHubClient(await p.githubCredentials(secrets, await p.clock()));
      const { owner, name } = loaded.config.repo;
      console.log(await runIssue({ client, repo: { owner, name }, scanner: await p.scanner(secrets) }, action));
      return 0;
    }
    case "canary": {
      const report = await runCanary(loaded);
      console.log(JSON.stringify(report, null, 2));
      return report.passed ? 0 : 1;
    }
    default:
      console.log(USAGE);
      return cmd ? 1 : 0;
  }
}

/** `golden add` reads the store and GitHub (read-only); `golden run` opens neither. */
async function golden(loaded: Loaded, sub: string | undefined, args: string[]): Promise<number> {
  const p = new Plugins(loaded);
  if (sub === "add") {
    const opts = parseAddArgs(args);
    await mkdir(join(loaded.stateDir, "db"), { recursive: true, mode: 0o700 });
    const secrets = await p.secrets();
    const store = await p.store(secrets, await p.clock());
    try {
      await store.migrate();
      const { owner, name } = loaded.config.repo;
      const github = new GitHubClient(await p.githubCredentials(secrets, await p.clock()));
      const r = await addCase(
        {
          store,
          project: await resolveProject(github, { owner, name }),
          github: { pullDiff: (pr) => github.pullDiff({ owner, name }, pr) },
          scanner: await p.scanner(secrets),
          casesDir: join(loaded.root, "golden", "cases"),
        },
        opts,
      );
      console.log(`wrote ${r.dir} (${r.case.expect}, ${r.case.outcome})`);
      return 0;
    } finally {
      await store.close();
    }
  }
  if (sub === "run") {
    const opts = parseRunArgs(args);
    const report = await runCases(await buildGoldenRunDeps(p, loaded), opts);
    console.log(formatReport(report));
    return 0;
  }
  console.log(USAGE);
  return 1;
}

main(process.argv[2], process.argv.slice(3)).then(
  (code) => process.exit(code),
  (err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    console.error(message);
    // A supervised child tells the supervisor why, so the status page can show it; then exits.
    if (process.env[SUPERVISED_ENV] === "1" && process.send && process.connected) {
      process.send({ type: CHILD_ERROR_MESSAGE, error: message }, undefined, {}, () => process.exit(1));
    } else process.exit(1);
  },
);
