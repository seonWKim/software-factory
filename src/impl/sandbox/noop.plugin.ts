import { definePlugin } from "../../plugin-api.js";
import { NoOpSandbox } from "./noop-sandbox.js";

export default definePlugin({
  kind: "sandbox",
  name: "noop",
  default: true,
  create: (c) => new NoOpSandbox(c.loaded.worktreesDir),
});
