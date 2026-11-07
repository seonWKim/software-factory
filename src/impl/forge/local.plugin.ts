import { definePlugin } from "../../plugin-api.js";
import { LocalForge } from "./local-forge.js";

// Not a default: selected by `"forge": "local"` under `plugins` (docs/plugins/forge.md). Makes no GitHub call.
export default definePlugin({
  kind: "forge",
  name: "local",
  create: (ctx) => {
    const cfg = ctx.loaded.config;
    return new LocalForge({ repo: cfg.repo.path, base: cfg.repo.base_branch, identity: cfg.agent_git_identity });
  },
});
