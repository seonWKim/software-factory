import { definePlugin } from "../../plugin-api.js";

export default definePlugin({
  kind: "source",
  name: "github-issues",
  default: true,
  create: async (c) =>
    new (await import("./github-issue-source.js")).GitHubIssueSource(
      c.github, c.repo, c.loaded.config.intake_label, c.loaded.config.branch_prefix, c.loaded.config.repo.base_branch,
      c.loaded.config.status_label_prefix, c.store,
    ),
  // `npm run setup`: creates the intake and status labels on the repository.
  setup: async (c) => (await import("./github-issue-source.js")).setupLabels(c.github, c.repo, c.loaded.config, c.print),
});
