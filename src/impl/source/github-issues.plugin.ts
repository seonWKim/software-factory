import { definePlugin } from "../../plugin-api.js";
import { GitHubIssueSource } from "./github-issue-source.js";

export default definePlugin({
  kind: "source",
  name: "github-issues",
  default: true,
  create: (c) =>
    new GitHubIssueSource(
      c.github, c.repo, c.loaded.config.intake_label, c.loaded.config.branch_prefix, c.loaded.config.repo.base_branch,
      c.loaded.config.status_label_prefix,
    ),
});
