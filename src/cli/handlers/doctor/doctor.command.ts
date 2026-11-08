import type { Loaded } from "../../../compose.js";
import { configFailLines } from "../../../config-keys.js";
import { doctor } from "../../../setup.js";
import { defineCommand } from "../../command.js";

export default defineCommand({
  names: ["doctor"],
  usage: `  doctor [--llm]
               checks setup without printing any secret; --llm adds one line that runs llm-check`,
  async run(args, ctx) {
    // A config that does not load is a doctor finding: one FAIL line per problem, no stack, exit 1.
    let loaded: Loaded;
    try {
      loaded = await ctx.load();
    } catch (err) {
      for (const line of configFailLines(err)) console.log(line);
      return 1;
    }
    return doctor(loaded, { llm: args.includes("--llm") });
  },
});
