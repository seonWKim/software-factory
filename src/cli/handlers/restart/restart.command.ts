import { randomUUID } from "node:crypto";
import { requestRestart } from "../../../core/restart.js";
import { defineCommand } from "../../command.js";

export default defineCommand({
  names: ["restart"],
  usage: `  restart <id>
               restart the app on a merged item's code: stores the request the item page's Restart app button
               stores, as the CLI identity; the worker runs repo.restart_command in the repo's base checkout and
               the result (exit status and output tail) is posted in the item's thread. Needs repo.restart_command`,
  async run(args, ctx) {
    if (args.length !== 1) {
      console.error("restart needs one work item ID: factory restart <id>");
      return 1;
    }
    // An ID, never a display name: the CLI identity, the actor the controller's owner check asks about.
    const { user } = await ctx.identity();
    return ctx.withStore(async (store, loaded) => {
      // The page's own key form (src/ui/commands.ts), so the request is the button's in every way but its actor.
      const r = await requestRestart({ store, user, command: loaded.config.repo.restart_command, newKey: () => `app:${randomUUID()}` }, args[0]!);
      for (const line of r.lines) (r.code === 0 ? console.log : console.error)(line);
      return r.code;
    });
  },
});
