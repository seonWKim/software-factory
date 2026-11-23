import { randomUUID } from "node:crypto";
import { defineCommand } from "../../command.js";

/** The app request's command: RUN_NEXT_COMMAND (src/controller/units/commands/run-next.ts), the item page's Run next. */
const COMMAND = "run-next";

export default defineCommand({
  names: [COMMAND],
  usage: `  run-next <id>
               move the item's queued run to queue position 1 (design 05-coordination): stores the request the item
               page's Run next button stores, as the CLI identity; the controller checks the owner, moves the run and
               answers in the item's thread. It starts nothing a busy item, a dependency, a coordination hold, paused
               claims or a rate limit keeps queued. Not in chat`,
  async run(args, ctx) {
    if (args.length !== 1) {
      console.error("run-next needs one work item ID: factory run-next <id>");
      return 1;
    }
    // An ID, never a display name: the CLI identity, the actor the controller's owner check asks about.
    const { user } = await ctx.identity();
    return ctx.withStore(async (store) => {
      const item = await store.getWorkItem(args[0] as Parameters<typeof store.getWorkItem>[0]);
      if (!item) {
        console.error(`no work item ${args[0]}`);
        return 1;
      }
      // The page's own key form (src/ui/commands.ts), so the request is the button's in every way but its actor.
      const { request } = await store.recordAppCommandRequest({ key: `app:${randomUUID()}`, actor: user, command: COMMAND, args: { work_item_id: item.id } });
      console.log(`stored \`factory run-next\` for ${item.id} as ${user} (request ${request.seq}); the controller moves its queued run to position 1 and answers in the item's thread`);
      return 0;
    });
  },
});
