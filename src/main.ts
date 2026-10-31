#!/usr/bin/env node
import { build, loadConfig } from "./compose.js";
import { runCanary } from "./canary.js";
import type { WorkItemId } from "./core/types.js";
import type { SecretName } from "./interfaces/secret-store.js";
import { doctor, setup } from "./setup.js";

const USAGE = `factory <command>

  setup        one-time setup: secret file, tokens (hidden prompt), label, checks, canary
               --rotate-github / --rotate-claude / --rotate-mysql to replace a stored credential
  dev          controller + worker in one process (Phase 1 default)
  controller   intake, run outcomes, reaper
  worker       claims and executes agent runs
  status [id]  work items, or one item's state_changes trail
  doctor       checks setup without printing any secret
  canary       G6: a real agent tries to find a planted canary secret`;

async function main(cmd: string | undefined, args: string[]): Promise<number> {
  const loaded = await loadConfig();
  switch (cmd) {
    case "dev":
    case "controller":
    case "worker": {
      const app = await build(loaded);
      const stop = new AbortController();
      for (const sig of ["SIGINT", "SIGTERM"] as const) process.once(sig, () => stop.abort());
      const loops = [];
      if (cmd !== "worker") loops.push(app.controller.run(stop.signal));
      if (cmd !== "controller") loops.push(app.worker.run(stop.signal));
      await Promise.all(loops);
      await app.close();
      return 0;
    }
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
    case "setup": {
      const rotate: SecretName[] = [];
      if (args.includes("--rotate-github")) rotate.push("GITHUB_TOKEN");
      if (args.includes("--rotate-claude")) rotate.push("CLAUDE_CODE_OAUTH_TOKEN");
      if (args.includes("--rotate-mysql")) rotate.push("MYSQL_PASSWORD");
      return setup(loaded, { rotate });
    }
    case "doctor":
      return doctor(loaded);
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

main(process.argv[2], process.argv.slice(3)).then(
  (code) => process.exit(code),
  (err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  },
);
