import { join } from "node:path";
import { definePlugin } from "../../plugin-api.js";
import { MODEL_CREDENTIAL, claudeDirs } from "../claude/claude-shared.js";
import { ClaudeCliLLMProvider } from "./claude-cli-llm-provider.js";

export default definePlugin({
  kind: "llm",
  name: "claude-cli",
  default: true,
  secrets: MODEL_CREDENTIAL,
  create: (c) =>
    new ClaudeCliLLMProvider({
      secrets: c.secrets,
      claudeConfigDir: claudeDirs(c).claudeConfigDir,
      workDir: join(c.loaded.stateDir, "agents", "llm"),
      models: c.loaded.file.models,
    }),
});
