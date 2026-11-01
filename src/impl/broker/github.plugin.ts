import { secretName } from "../../interfaces/secret-store.js";
import { definePlugin } from "../../plugin-api.js";
import { GitHubToolBroker } from "./github-tool-broker.js";

export default definePlugin({
  kind: "broker",
  name: "github",
  default: true,
  secrets: [{ name: secretName("GITHUB_TOKEN"), purpose: "pushes factory branches, opens pull requests and comments" }],
  create: (c) =>
    new GitHubToolBroker({
      client: c.github,
      secrets: c.secrets,
      store: c.store,
      scanner: c.scanner,
      clock: c.clock,
      repo: c.repo,
      branchPrefix: c.loaded.config.branch_prefix,
    }),
});
