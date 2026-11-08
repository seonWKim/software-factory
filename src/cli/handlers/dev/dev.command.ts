import { build } from "../../../compose.js";
import { ConsoleLogger } from "../../../impl/log/console-logger.js";
import { SUPERVISED_ENV, processChannel, runDev, runDevChild } from "../../../supervisor.js";
import { defineCommand } from "../../command.js";
import { runLoops } from "../../support.js";

export default defineCommand({
  names: ["dev"],
  usage: `  dev          controller + worker in one process (Phase 1 default); under the git-worktree updater
               it runs them from a built copy of origin/<base_branch> (with no GitHub plugin: the local
               <base_branch>) and restarts on new commits`,
  async run(_args, ctx) {
    const loaded = await ctx.load();
    if (process.env[SUPERVISED_ENV] === "1" && process.send) {
      // Child of the supervisor: a drain (IPC) stops the controller and claiming; SIGTERM stays the hard stop.
      const channel = processChannel();
      const stop = new AbortController();
      for (const sig of ["SIGINT", "SIGTERM"] as const) process.once(sig, () => stop.abort());
      process.once("disconnect", () => stop.abort()); // the supervisor is gone: never run as an orphan
      const app = await build(loaded, { signal: stop.signal });
      await runDevChild(app, channel, stop.signal, new ConsoleLogger(app.clock, "controller"));
      await app.close();
      return 0;
    }
    return runDev(loaded, (signal) => runLoops(loaded, "dev", signal));
  },
});
