import { secretName } from "../../interfaces/secret-store.js";
import { definePlugin } from "../../plugin-api.js";
import { GitHubIssueSource } from "./github-issue-source.js";

export default definePlugin({
  kind: "source",
  name: "github-issues",
  default: true,
  secrets: [{ name: secretName("GITHUB_TOKEN"), purpose: "reads issues, comments and commits; posts comments and status labels" }],
  create: (c) =>
    new GitHubIssueSource(
      c.github, c.repo, c.loaded.config.intake_label, c.loaded.config.branch_prefix, c.loaded.config.repo.base_branch,
      c.loaded.config.status_label_prefix,
    ),
});
