import { definePlugin } from "../../plugin-api.js";
import { GitHubIssueSource } from "../source/github-issue-source.js";
import { GitHubForge } from "./github-forge.js";

// Optional and not a default: selected only by `"forge": "github"` under `plugins` (docs/plugins/forge.md).
export default definePlugin({
  kind: "forge",
  name: "github",
  create: (c) =>
    new GitHubForge(
      new GitHubIssueSource(
        c.github, c.repo, c.loaded.config.intake_label, c.loaded.config.branch_prefix, c.loaded.config.repo.base_branch,
        c.loaded.config.status_label_prefix,
      ),
    ),
});
