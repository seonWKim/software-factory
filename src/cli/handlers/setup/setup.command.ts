import { type SecretName, secretName } from "../../../interfaces/secret-store.js";
import { setup } from "../../../setup.js";
import { defineCommand } from "../../command.js";

export default defineCommand({
  names: ["setup"],
  usage: `  setup        one-time setup: secret file, tokens (hidden prompt), label, checks, canary
               --rotate-github / --rotate-claude / --rotate-mysql to replace a stored credential`,
  async run(args, ctx) {
    const rotate: SecretName[] = [];
    if (args.includes("--rotate-github")) rotate.push(secretName("GITHUB_TOKEN"));
    if (args.includes("--rotate-claude")) rotate.push(secretName("CLAUDE_CODE_OAUTH_TOKEN"));
    if (args.includes("--rotate-mysql")) rotate.push(secretName("MYSQL_PASSWORD"));
    return setup(await ctx.load(), { rotate });
  },
});
