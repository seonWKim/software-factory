import { runCanary } from "../../../canary.js";
import { defineCommand } from "../../command.js";

export default defineCommand({
  names: ["canary"],
  usage: `  canary       G6: a real agent tries to find a planted canary secret`,
  async run(_args, ctx) {
    const report = await runCanary(await ctx.load());
    console.log(JSON.stringify(report, null, 2));
    return report.passed ? 0 : 1;
  },
});
