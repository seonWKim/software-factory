import { build } from "../../../compose.js";
import type { WorkItemId } from "../../../core/types.js";
import { modelStallLine } from "../../../ui/factory-status.js";
import { defineCommand } from "../../command.js";

export default defineCommand({
  names: ["status"],
  usage: `  status [id]  work items, or one item's state_changes trail`,
  async run(args, ctx) {
    const app = await build(await ctx.load());
    if (args[0]) {
      const id = args[0] as WorkItemId;
      console.log(JSON.stringify({ item: await app.store.getWorkItem(id), runs: await app.store.listRuns(id), state_changes: await app.store.listStateChanges(id) }, null, 2));
    } else {
      // While a stall pause is in effect (design §5 Restarts), say so above the table.
      const stall = await modelStallLine(app.store);
      if (stall) console.log(stall);
      const items = await app.store.listWorkItems(50);
      console.table(items.map(({ id, source, stage, blocked_on, blocked_reason, tier, loop_count, change_ref, version }) =>
        ({ id, source: source.id, stage, blocked_on, blocked_reason, tier, loop_count, change_ref, version })));
    }
    await app.close();
    return 0;
  },
});
