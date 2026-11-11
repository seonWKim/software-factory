import { teardown } from "../../../teardown.js";
import { defineCommand } from "../../command.js";

const FLAGS = ["--yes", "-y", "--dry-run", "--stop", "--secrets"];

export default defineCommand({
  names: ["teardown"],
  usage: `  teardown [--dry-run] [--yes] [--stop] [--secrets]
               undoes setup on this machine: removes the state folder (a SQLite store is copied out first), the
               factory's clean worktrees, its merged branches and refs/factory/* refs; keeps and lists the rest.
               Asks you to type "teardown" first. Never touches GitHub, Slack or the config file.
               --dry-run  print what would go, change nothing
               --yes      do not ask (the --secrets question is still asked)
               --stop     drain and stop a factory running on this machine first, instead of refusing
               --secrets  also remove the factory's entries from the secret file (asks again)`,
  async run(args, ctx) {
    const unknown = args.find((a) => !FLAGS.includes(a));
    if (unknown !== undefined) {
      console.error(`teardown: unknown argument ${JSON.stringify(unknown)}\n${ctx.usage}`);
      return 1;
    }
    return teardown(await ctx.load(), {
      yes: args.includes("--yes") || args.includes("-y"),
      dryRun: args.includes("--dry-run"),
      stop: args.includes("--stop"),
      secrets: args.includes("--secrets"),
    });
  },
});
