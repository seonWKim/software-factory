import { definePlugin } from "../../plugin-api.js";
import { runProcess } from "../process/run-process.js";
import { NoOpSandbox } from "./noop-sandbox.js";

export default definePlugin({
  kind: "sandbox",
  name: "noop",
  default: true,
  // No GitHub plugin selected (design 05-sources, Local startup): no origin fetch, the local base branch.
  create: (c) => new NoOpSandbox(c.loaded.worktreesDir, runProcess, undefined, { local: c.loaded.config.local_only === true }),
});
