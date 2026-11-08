import { userInfo } from "node:os";
import { Plugins, buildStatsStore } from "../../../compose.js";
import { ConsoleLogger } from "../../../impl/log/console-logger.js";
import { RESUME_USAGE, parseResumeArgs, runResume } from "../../../resume-cmd.js";
import { defineCommand } from "../../command.js";

export default defineCommand({
  names: ["resume"],
  usage: `  resume [name | --all]
               end a claim pause now: rate_limit (no name), forge_auth, preflight_access or model_stall, or
               --all for every one; prints what it ended or "no pause in effect". Logged with your local:<login>`,
  async run(args, ctx) {
    // The pauses live in the store (design §5 Restarts); an unknown name is refused before the store opens.
    const action = parseResumeArgs([...args]);
    if ("error" in action) {
      console.log(`${action.error}\n${RESUME_USAGE}`);
      return 1;
    }
    const loaded = await ctx.load();
    const store = await buildStatsStore(loaded);
    try {
      await store.migrate();
      const clock = await new Plugins(loaded).clock();
      // An ID, never a display name: the OS login of the local owner.
      const r = await runResume({ store, actor: `local:${userInfo().username}`, log: new ConsoleLogger(clock, "resume") }, action);
      for (const line of r.lines) console.log(line);
      return r.code;
    } finally {
      await store.close();
    }
  },
});
