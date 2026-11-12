import { definePlugin } from "../../plugin-api.js";

export default definePlugin({
  kind: "source",
  name: "github-issues",
  default: true,
  create: async (c) => {
    const [{ GitHubIssueSource }, { LiveIntakeLabel }] = await Promise.all([import("./github-issue-source.js"), import("./intake-label.js")]);
    // The intake label in force when new issues are listed or filed: `intake_label` is settable (design 08-settings).
    return new GitHubIssueSource(
      c.github, c.repo, new LiveIntakeLabel(c.loaded.config.intake_label, c.store), c.loaded.config.branch_prefix, c.loaded.config.repo.base_branch,
      c.loaded.config.status_label_prefix, c.store,
    );
  },
  // `npm run setup`: creates the intake and status labels on the repository.
  setup: async (c) => (await import("./github-issue-source.js")).setupLabels(c.github, c.repo, c.loaded.config, c.print),
});
