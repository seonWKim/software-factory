#!/usr/bin/env node
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { CODE_ROOT_ENV, type Loaded, Plugins, build, buildUiParts, loadConfig, uiPort } from "./compose.js";
import { runCanary } from "./canary.js";
import { addCase, buildGoldenRunDeps, formatReport, parseAddArgs, parseRunArgs, runCases } from "./golden.js";
import { GitHubClient } from "./impl/github/github-client.js";
import type { WorkItemId } from "./core/types.js";
import type { SecretName } from "./interfaces/secret-store.js";
import { doctor, setup } from "./setup.js";
import { SUPERVISED_ENV, processChannel, runDev, runDevChild } from "./supervisor.js";
import { startUi } from "./ui/server.js";

const USAGE = `factory <command>

  setup        one-time setup: secret file, tokens (hidden prompt), label, checks, canary
               --rotate-github / --rotate-claude / --rotate-mysql to replace a stored credential
  dev          controller + worker in one process (Phase 1 default); under the git-worktree updater
               it runs them from a built copy of origin/<base_branch> and restarts on new commits
  controller   intake, run outcomes, reaper
  worker       claims and executes agent runs
  status [id]  work items, or one item's state_changes trail
  ui           read-only status page at http://127.0.0.1:<ui.port>/ (default 4310); no controller or worker
  doctor       checks setup without printing any secret
  canary       G6: a real agent tries to find a planted canary secret
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
  const loaded = await loadConfig(process.cwd(), { codeRoot: process.env[CODE_ROOT_ENV] });
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
    case "ui": {
      const parts = await buildUiParts(loaded);
      const { owner, name } = loaded.config.repo;
      const ui = await startUi(
        {
          store: parts.store,
          scanner: parts.scanner,
          clock: parts.clock,
          lease_ms: loaded.config.lease_ms,
          prUrl: (project, n) => `https://github.com/${project || `${owner}/${name}`}/pull/${n}`,
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
    case "setup": {
      const rotate: SecretName[] = [];
      if (args.includes("--rotate-github")) rotate.push("GITHUB_TOKEN");
      if (args.includes("--rotate-claude")) rotate.push("CLAUDE_CODE_OAUTH_TOKEN");
      if (args.includes("--rotate-mysql")) rotate.push("MYSQL_PASSWORD");
      return setup(loaded, { rotate });
    }
    case "doctor":
      return doctor(loaded);
    case "golden":
      return golden(loaded, args[0], args.slice(1));
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
      const github = new GitHubClient(secrets);
      const r = await addCase(
        {
          store,
          project: `${owner}/${name}`,
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
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  },
);
