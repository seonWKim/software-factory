import { Plugins, ownerRefusal } from "../../../compose.js";
import { ConsoleLogger } from "../../../impl/log/console-logger.js";
import { RESUME_USAGE, parseResumeArgs, runResume } from "../../../resume-cmd.js";
import { defineCommand } from "../../command.js";

export default defineCommand({
  names: ["resume"],
  usage: `  resume [name | --all]
               end a claim pause now: rate_limit (no name), forge_auth, preflight_access or model_stall, or
               --all for every one; prints what it ended or "no pause in effect". Needs approve_spec (the owner
               check, as the dashboard's Resume now); logged with the CLI identity`,
  async run(args, ctx) {
    // The pauses live in the store (design §5 Restarts); an unknown name is refused before the store opens.
    const action = parseResumeArgs([...args]);
    if ("error" in action) {
      console.log(`${action.error}\n${RESUME_USAGE}`);
      return 1;
    }
    // An ID, never a display name: the CLI identity, the one the owner check asks about.
    const { user } = await ctx.identity();
    return ctx.withStore(async (store, loaded) => {
      const log = new ConsoleLogger(await new Plugins(loaded).clock(), "resume");
      const r = await runResume({ store, actor: user, log, refusal: ownerRefusal(loaded, store, user, "approve_spec") }, action);
      for (const line of r.lines) (r.code === 0 ? console.log : console.error)(line);
      return r.code;
    });
  },
});
