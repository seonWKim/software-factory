import { build } from "../../../compose.js";
import { enqueueImprove } from "../../../core/improver.js";
import { defineCommand } from "../../command.js";

export default defineCommand({
  names: ["improve"],
  usage: `  improve      queue one improve run now: groups the failed runs of the last 24 hours into one stored report
               (design §7); no model, nothing filed. The controller also queues one each UTC day`,
  async run(_args, ctx) {
    // The same enqueue as the controller's daily step, with a key of its own (design §7); a worker runs it.
    const app = await build(await ctx.load());
    try {
      const { run } = await enqueueImprove(app, app.project.key, "manual");
      console.log(`improve run ${run.id} queued (window ${run.input?.improve?.window_start} to ${run.input?.improve?.window_end})`);
    } finally {
      await app.close();
    }
    return 0;
  },
});
