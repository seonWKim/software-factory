import { Plugins } from "../../../compose.js";
import { ISSUE_USAGE, issueDeps, parseIssueArgs, runIssue } from "../../../issue-cmd.js";
import { defineCommand } from "../../command.js";

export default defineCommand({
  names: ["issue"],
  usage: `  issue        create / comment / edit <number> --body-file <path> / title / sub-issue through the factory's
               GitHub login (the bot with github_auth "app")`,
  async run(args, ctx) {
    const action = parseIssueArgs([...args]);
    if (!action) {
      console.error(ISSUE_USAGE);
      return 1;
    }
    console.log(await runIssue(await issueDeps(new Plugins(await ctx.load())), action));
    return 0;
  },
});
