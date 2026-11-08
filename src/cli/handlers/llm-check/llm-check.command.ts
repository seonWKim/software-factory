import { Plugins } from "../../../compose.js";
import { llmCheckFromPlugins, parseLlmCheckArgs } from "../../../llm-check.js";
import { defineCommand } from "../../command.js";

export default defineCommand({
  names: ["llm-check"],
  usage: `  llm-check [--model cheap|standard|strong]
               two small real calls to the configured LLM provider (plugins.llm), one plain and one
               with an output schema; default --model cheap; every line is egress-scanned first`,
  async run(args, ctx) {
    const parsed = parseLlmCheckArgs([...args]);
    if ("error" in parsed) {
      console.log(parsed.error);
      return 1;
    }
    const r = await llmCheckFromPlugins(new Plugins(await ctx.load()), parsed.model, (line) => console.log(line));
    return r.ok ? 0 : 1;
  },
});
