import { definePlugin } from "../../plugin-api.js";
import { LocalForge } from "./local-forge.js";

// Not a default: config selecting no forge leaves `plugins.forge` empty, and compose then builds this plugin as the
// kernel's link reader, links only (docs/plugins/forge.md). Selected by `"forge": "local"` under `plugins`.
export default definePlugin({
  kind: "forge",
  name: "local",
  create: (ctx) => new LocalForge(ctx.loaded.config.branch_prefix),
});
