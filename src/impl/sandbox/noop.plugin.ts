import { resolve } from "node:path";
import { definePlugin } from "../../plugin-api.js";
import { NoOpSandbox } from "./noop-sandbox.js";

export default definePlugin({
  kind: "sandbox",
  name: "noop",
  default: true,
  create: (c) => new NoOpSandbox(resolve(c.loaded.root, c.loaded.file.worktrees_dir)),
});
