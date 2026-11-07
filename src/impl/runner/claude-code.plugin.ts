import { definePlugin } from "../../plugin-api.js";
import { MODEL_CREDENTIAL, claudeDirs } from "../claude/claude-shared.js";
import { ClaudeCodeRunner } from "./claude-code-runner.js";

export default definePlugin({
  kind: "runner",
  name: "claude-code",
  default: true,
  secrets: MODEL_CREDENTIAL,
  create: (c) =>
    new ClaudeCodeRunner({
      sandbox: c.sandbox,
      secrets: c.secrets,
      ...claudeDirs(c),
      models: c.loaded.file.models,
      // Granted broker tools (tool_grants) reach the agent only through this broker and scanner.
      ...(c.broker && c.scanner ? { tools: { broker: c.broker, scanner: c.scanner } } : {}),
    }),
});
