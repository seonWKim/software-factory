import { buildSessionParts } from "../../../compose.js";
import { SESSION_USAGE, parseSessionArgs, runSession, sessionDeps } from "../../../session-cmd.js";
import { defineCommand } from "../../command.js";
import { stopOnSignals } from "../../support.js";

export default defineCommand({
  names: ["session"],
  usage: `  session start | status | note | finish | abandon
               your own LLM session on a work item, as an interactive run: a worker's gates at finish (SET_UP.md)`,
  async run(args, ctx) {
    const action = parseSessionArgs([...args]);
    if ("error" in action) {
      console.log(`${action.error}\n${SESSION_USAGE}`);
      return 1;
    }
    const loaded = await ctx.load();
    const parts = await buildSessionParts(loaded);
    try {
      return await runSession(sessionDeps(parts, loaded.stateDir, stopOnSignals()), action);
    } finally {
      await parts.close();
    }
  },
});
