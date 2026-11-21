import { Plugins, ownerRefusal } from "../../../compose.js";
import { ConsoleLogger } from "../../../impl/log/console-logger.js";
import { runStop } from "../../../resume-cmd.js";
import { defineCommand } from "../../command.js";

export default defineCommand({
  names: ["stop"],
  usage: `  stop
               stop every agent: no worker claims a run, and implement and review runs go back to the queue within one
               tick with their attempt, folder and commits kept; other runs finish first. Interactive tasks and the
               factory process keep running. Undo with \`factory resume owner\`. Needs approve_spec (the owner check,
               as the dashboard's Stop all agents); logged with the CLI identity`,
  async run(args, ctx) {
    if (args.length > 0) {
      console.log("usage: factory stop (it takes no arguments)");
      return 1;
    }
    // An ID, never a display name: the CLI identity, the one the owner check asks about.
    const { user } = await ctx.identity();
    return ctx.withStore(async (store, loaded) => {
      const log = new ConsoleLogger(await new Plugins(loaded).clock(), "stop");
      const r = await runStop({ store, actor: user, log, refusal: ownerRefusal(loaded, store, user, "approve_spec") });
      for (const line of r.lines) (r.code === 0 ? console.log : console.error)(line);
      return r.code;
    });
  },
});
