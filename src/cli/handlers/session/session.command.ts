import { buildSessionParts } from "../../../compose.js";
import { SESSION_USAGE, parseSessionArgs, runSession, sessionDeps, sessionWho } from "../../../session-cmd.js";
import { defineCommand } from "../../command.js";
import { cliEnvironment, stopOnSignals } from "../../support.js";

export default defineCommand({
  names: ["interactive", "session"],
  usage: `  interactive start | status | note | finish | abandon
               an interactive task: you handle a work item in your own LLM session; a worker's gates at finish (SET_UP.md).
               \`session\` is the same command`,
  async run(args, ctx) {
    const action = parseSessionArgs([...args]);
    if ("error" in action) {
      console.log(`${action.error}\n${SESSION_USAGE}`);
      return 1;
    }
    const loaded = await ctx.load();
    const who = sessionWho(loaded, await cliEnvironment(loaded.root));
    const parts = await buildSessionParts(loaded);
    try {
      return await runSession(sessionDeps(parts, loaded.stateDir, stopOnSignals(), who), action);
    } finally {
      await parts.close();
    }
  },
});
