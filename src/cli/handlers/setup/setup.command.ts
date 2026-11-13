import { type SecretName, secretName } from "../../../interfaces/secret-store.js";
import { defineCommand } from "../../command.js";
import { CONNECT_COMMANDS, connectSetup, guidedSetup } from "./guided.js";

const ROTATE: Readonly<Record<string, string>> = {
  "--rotate-github": "GITHUB_TOKEN",
  "--rotate-claude": "CLAUDE_CODE_OAUTH_TOKEN",
};

/** Every plugin's connect command, from the registry: `setup <kind> <command>`, one entry each. */
const connectUsage = CONNECT_COMMANDS.map(
  (c) => `\n  setup ${c.kind} ${c.command} [--disconnect]\n               connect the ${c.kind} plugin ${c.name}: sign in, store its secrets, list it in "${c.configKey}"
               after a diff, sync once; --disconnect removes its secrets and its entry`,
).join("");

export default defineCommand({
  names: ["setup"],
  usage: `  setup        guided setup; each step shows a title, why, its question with the default (Enter takes it)
               and a ✓/✗ line: plugins (local only; GitHub and Slack optional; written to
               factory.config.json after a diff), secret file, secrets (hidden input), database, you
               (display name), mode and auto_merge_max_tier, plugin setup, checks, canary. A run that stopped
               offers "Continue from step N?" (record: <state_dir>/setup-progress.json, no secret in it)
               --yes  take every default without reading the terminal; missing secrets are reported, not asked
               --rotate-github / --rotate-claude to replace a stored credential${connectUsage}`,
  async run(args, ctx) {
    const [kind, command, ...rest] = args;
    if (kind !== undefined && !kind.startsWith("-")) {
      const known = CONNECT_COMMANDS.some((c) => c.kind === kind && c.command === command);
      if (!known || rest.some((a) => a !== "--disconnect")) {
        console.error(`setup: unknown arguments ${JSON.stringify(args.join(" "))}\n${ctx.usage}`);
        return 1;
      }
      return connectSetup(ctx, { kind, command: command!, disconnect: rest.includes("--disconnect") });
    }
    const rotate: SecretName[] = [];
    for (const a of args) {
      if (a in ROTATE) rotate.push(secretName(ROTATE[a]!));
      else if (a !== "--yes" && a !== "-y") {
        console.error(`setup: unknown argument ${JSON.stringify(a)}\n${ctx.usage}`);
        return 1;
      }
    }
    return guidedSetup(ctx, { rotate, yes: args.includes("--yes") || args.includes("-y") });
  },
});
