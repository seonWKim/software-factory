import { resolve } from "node:path";
import { definePlugin } from "../../plugin-api.js";

export default definePlugin({
  kind: "broker",
  name: "github",
  default: true,
  create: async (c) => {
    const { GitHubToolBroker } = await import("./github-tool-broker.js");
    return new GitHubToolBroker({
      client: c.github,
      store: c.store,
      scanner: c.scanner,
      clock: c.clock,
      repo: c.repo,
      branchPrefix: c.loaded.config.branch_prefix,
      repoPath: resolve(c.loaded.root, c.loaded.config.repo.path),
    });
  },
});
