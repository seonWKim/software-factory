import { defineCommand } from "../../command.js";
import { runLoops, stopOnSignals } from "../../support.js";

export default defineCommand({
  names: ["controller", "worker"],
  usage: `  controller   intake, run outcomes, reaper
  worker       claims and executes agent runs`,
  async run(_args, ctx) {
    await runLoops(await ctx.load(), ctx.name as "controller" | "worker", stopOnSignals());
    return 0;
  },
});
