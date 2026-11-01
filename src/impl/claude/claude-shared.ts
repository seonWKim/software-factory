// Shared by the claude-code runner and the claude-cli LLM provider descriptors: where the claude CLI keeps
// its config and per-run homes, and the model credential both read. Not a plugin descriptor itself.

import { join } from "node:path";
import { secretName } from "../../interfaces/secret-store.js";
import type { BaseContext, SecretDeclaration } from "../../plugin-api.js";

/** The model credential for the Claude Code CLI: the subscription token, or an API key instead. */
export const MODEL_CREDENTIAL: readonly SecretDeclaration[] = [
  { name: secretName("CLAUDE_CODE_OAUTH_TOKEN"), purpose: "Claude subscription token for the claude CLI (claude setup-token)", oneOf: "model credential" },
  { name: secretName("ANTHROPIC_API_KEY"), purpose: "Anthropic API key for the claude CLI, used when there is no OAuth token", oneOf: "model credential" },
];

/** The claude CLI's config dir and the per-run home dirs, under the state dir. */
export const claudeDirs = (c: BaseContext) => ({
  claudeConfigDir: join(c.loaded.stateDir, "agents", "claude-config"),
  homesDir: join(c.loaded.stateDir, "agents", "homes"),
});
