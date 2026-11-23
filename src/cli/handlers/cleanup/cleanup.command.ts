import { defineCommand } from "../../command.js";
import { runCleanup } from "../../support.js";

const FLAGS = ["--dry-run"];

export default defineCommand({
  names: ["cleanup"],
  usage: `  cleanup [--dry-run]
               removes this host's leftovers of closed items now: their run folders, merged local branches and the
               processes still running in those folders, once cleanup.keep_hours passed since the close; prints what
               it removed and what it kept, with why. The controller runs the same sweep daily.
               --dry-run  print what would go and what stays, change nothing`,
  async run(args, ctx) {
    const unknown = args.find((a) => !FLAGS.includes(a));
    if (unknown !== undefined) {
      console.error(`cleanup: unknown argument ${JSON.stringify(unknown)}\n${ctx.usage}`);
      return 1;
    }
    return ctx.withStore((store, loaded) => runCleanup(loaded, store, args.includes("--dry-run"), (line) => console.log(line)));
  },
});
