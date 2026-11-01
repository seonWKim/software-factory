import { definePlugin } from "../../plugin-api.js";
import { GitHubToolBroker } from "./github-tool-broker.js";

export default definePlugin({
  kind: "broker",
  name: "github",
  default: true,
  create: (c) =>
    new GitHubToolBroker({
      client: c.github,
      credentials: c.credentials,
      store: c.store,
      scanner: c.scanner,
      clock: c.clock,
      repo: c.repo,
      branchPrefix: c.loaded.config.branch_prefix,
    }),
});
