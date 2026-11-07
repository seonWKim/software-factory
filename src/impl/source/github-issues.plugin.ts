import { definePlugin } from "../../plugin-api.js";
import { GitHubIssueSource, githubHistorySince } from "./github-issue-source.js";

export default definePlugin({
  kind: "source",
  name: "github-issues",
  default: true,
  create: (c) =>
    new GitHubIssueSource(
      c.github, c.repo, c.loaded.config.intake_label, c.loaded.config.branch_prefix, c.loaded.config.repo.base_branch,
      c.loaded.config.status_label_prefix, c.store,
      c.clock ? { clock: c.clock, history_since: githubHistorySince(c.loaded.file.github), log: c.log } : null,
    ),
});
