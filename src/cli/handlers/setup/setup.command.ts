import { type SecretName, secretName } from "../../../interfaces/secret-store.js";
import { defineCommand } from "../../command.js";
import { guidedSetup } from "./guided.js";

const ROTATE: Readonly<Record<string, string>> = {
  "--rotate-github": "GITHUB_TOKEN",
  "--rotate-claude": "CLAUDE_CODE_OAUTH_TOKEN",
};

export default defineCommand({
  names: ["setup"],
  usage: `  setup        guided setup; each step shows a title, why, its question with the default (Enter takes it)
               and a ✓/✗ line: plugins (local only; GitHub and Slack optional; written to
               factory.config.json after a diff), secret file, secrets (hidden input), database, you
               (display name), mode and auto_merge_max_tier, plugin setup, checks, canary. A run that stopped
               offers "Continue from step N?" (record: <state_dir>/setup-progress.json, no secret in it)
               --yes  take every default without reading the terminal; missing secrets are reported, not asked
               --me   only register yourself: your ID and display name, nothing shared (later team members)
               --rotate-github / --rotate-claude to replace a stored credential`,
  async run(args, ctx) {
    const rotate: SecretName[] = [];
    for (const a of args) {
      if (a in ROTATE) rotate.push(secretName(ROTATE[a]!));
      else if (a !== "--yes" && a !== "-y" && a !== "--me") {
        console.error(`setup: unknown argument ${JSON.stringify(a)}\n${ctx.usage}`);
        return 1;
      }
    }
    return guidedSetup(ctx, { rotate, yes: args.includes("--yes") || args.includes("-y"), me: args.includes("--me") });
  },
});
