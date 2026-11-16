import { ownerRefusal } from "../../../compose.js";
import { parseWorkersArgs, runWorkersCommand } from "../../../worker/index.js";
import { defineCommand } from "../../command.js";

export default defineCommand({
  names: ["workers"],
  usage: `  workers pause <n> | pause --all | resume | status
               pause n workers (those whose runs started most recently) or every loop: their implement and
               review runs go back to the queue within one tick with their WIP committed locally, nothing
               pushed; other runs finish first. resume clears every pause. Stored, so it survives a restart.
               pause and resume need approve_spec (the owner check) and are recorded as the CLI identity`,
  async run(args, ctx) {
    // The pause lives in the store (design §5 Pause): every running worker, on any host, reads it each tick.
    const action = parseWorkersArgs([...args]);
    if ("error" in action) {
      console.log(action.error);
      return 1;
    }
    const { user } = await ctx.identity();
    return ctx.withStore(async (store, loaded) => {
      const r = await runWorkersCommand({ store, actor: user, refusal: ownerRefusal(loaded, store, user, "approve_spec") }, action);
      for (const line of r.lines) (r.code === 0 ? console.log : console.error)(line);
      return r.code;
    });
  },
});
