import { definePlugin } from "../../plugin-api.js";
import { hasOrigin } from "../git/base-push.js";
import { LocalForge } from "./local-forge.js";

// Not a default: config selecting no forge leaves `plugins.forge` empty, and compose then builds this plugin as the
// kernel's link reader, links only (docs/plugins/forge.md). Selected by `"forge": "local"` under `plugins`.
// The base push (design 05-sources, Local items): off by default; `merge_queue.push_base: true` gives it `pushBase`
// when the factory repo names an origin (one read of its git config, no remote call), and compose then makes it the
// forge even with none selected, so a local merge pushes the local base to origin with no GitHub plugin.
export default definePlugin({
  kind: "forge",
  name: "local",
  create: async (ctx) => {
    const cfg = ctx.loaded.config;
    const push = cfg.merge_queue_push_base === true && (await hasOrigin(cfg.repo.path));
    return new LocalForge(cfg.branch_prefix, push ? cfg.repo.base_branch : null);
  },
});
