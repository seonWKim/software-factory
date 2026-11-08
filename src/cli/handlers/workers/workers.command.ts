import { buildStatsStore } from "../../../compose.js";
import { parseWorkersArgs, runWorkersCommand } from "../../../core/worker-pool.js";
import { defineCommand } from "../../command.js";

export default defineCommand({
  names: ["workers"],
  usage: `  workers pause <n> | pause --all | resume | status   [--by <user id>]
               pause n workers (those whose runs started most recently) or every loop: their implement and
               review runs go back to the queue within one tick with their WIP committed locally, nothing
               pushed; other runs finish first. resume clears every pause. Stored, so it survives a restart`,
  async run(args, ctx) {
    // The pause lives in the store (design §5 Pause): every running worker, on any host, reads it each tick.
    const action = parseWorkersArgs([...args]);
    if ("error" in action) {
      console.log(action.error);
      return 1;
    }
    const store = await buildStatsStore(await ctx.load());
    try {
      await store.migrate();
      for (const line of await runWorkersCommand(store, action)) console.log(line);
    } finally {
      await store.close();
    }
    return 0;
  },
});
