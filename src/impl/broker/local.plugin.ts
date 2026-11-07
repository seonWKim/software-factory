import { resolve } from "node:path";
import { definePlugin } from "../../plugin-api.js";
import { LocalToolBroker } from "./local-tool-broker.js";

export default definePlugin({
  kind: "broker",
  name: "local",
  create: (c) =>
    new LocalToolBroker({
      store: c.store,
      scanner: c.scanner,
      branchPrefix: c.loaded.config.branch_prefix,
      repoPath: resolve(c.loaded.root, c.loaded.config.repo.path),
    }),
});
