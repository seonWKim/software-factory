import { Plugins, ownerRefusal } from "../../../compose.js";
import { ConsoleLogger } from "../../../impl/log/console-logger.js";
import { RESUME_USAGE, parseResumeArgs, runResume, runStop } from "../../../resume-cmd.js";
import { defineCommand } from "../../command.js";

export default defineCommand({
  // `stop` starts the owner pause that `resume owner` ends (design 05-restart-pauses), so both live here.
  names: ["resume", "stop"],
  usage: `  resume [name | --all]
               end a pause now: rate_limit (no name), forge_auth, preflight_access, model_stall, owner (what
               \`factory stop\` started; also clears every \`workers pause\`), or --all for every one; prints what
               it ended or "no pause in effect". Needs approve_spec (the owner check, as the dashboard's Resume
               now); logged with the CLI identity
  stop
               stop every agent: no worker claims a run, and implement and review runs go back to the queue within one
               tick with their attempt, folder and commits kept; other runs finish first. Interactive tasks and the
               factory process keep running. Undo with \`factory resume owner\`. Needs approve_spec (the owner check,
               as the dashboard's Stop all agents); logged with the CLI identity`,
  async run(args, ctx) {
    const stop = ctx.name === "stop";
    // The pauses live in the store (design §5 Restarts); an unknown name is refused before the store opens.
    const action = stop ? (args.length === 0 ? null : { error: "factory stop takes no arguments" }) : parseResumeArgs([...args]);
    if (action !== null && "error" in action) {
      console.log(`${action.error}\n${stop ? "usage: factory stop" : RESUME_USAGE}`);
      return 1;
    }
    // An ID, never a display name: the CLI identity, the one the owner check asks about.
    const { user } = await ctx.identity();
    return ctx.withStore(async (store, loaded) => {
      const log = new ConsoleLogger(await new Plugins(loaded).clock(), ctx.name);
      const d = { store, actor: user, log, refusal: ownerRefusal(loaded, store, user, "approve_spec") };
      const r = action === null ? await runStop(d) : await runResume(d, action);
      for (const line of r.lines) (r.code === 0 ? console.log : console.error)(line);
      return r.code;
    });
  },
});
