import { buildStatsStore } from "../../../compose.js";
import { collectStats, formatStatsText } from "../../../core/stats.js";
import { defineCommand } from "../../command.js";

export default defineCommand({
  names: ["stats"],
  usage: `  stats        per-tier counts of closed items, feedback rate, /reject, /retry, token_cost (read-only)
               --json for one JSON object`,
  async run(args, ctx) {
    const loaded = await ctx.load();
    // Read-only: no build() (it migrates), no transition. Changes no dial.
    const store = await buildStatsStore(loaded);
    try {
      const report = await collectStats(store, loaded.stats);
      console.log(args.includes("--json") ? JSON.stringify(report, null, 2) : formatStatsText(report));
    } finally {
      await store.close();
    }
    return 0;
  },
});
