import { definePlugin } from "../../plugin-api.js";
import type { Contexts } from "../../plugin-api.js";
import { GitHubIssueSource, githubHistorySince } from "./github-issue-source.js";
import { GitHubForge } from "./github-forge.js";

/**
 * What build() passes beside the forge context (src/compose.ts): the store its PR comments and labels are recorded
 * in, and the Clock and log its poll needs. Left out (a bare build, as in Plugins.forge(github)): no records, no poll.
 */
type GitHubForgeContext = Contexts["forge"] & Partial<Pick<Contexts["source"], "store" | "clock" | "log">>;

// Not a default: selected by `"forge": "github"` under `plugins`, or derived from `github-issues` in
// `plugins.source` when `plugins.forge` is left out (docs/plugins/forge.md).
export default definePlugin({
  kind: "forge",
  name: "github",
  create: (ctx) => {
    const c = ctx as GitHubForgeContext;
    const cfg = c.loaded.config;
    const issues = new GitHubIssueSource(
      c.github, c.repo, cfg.intake_label, cfg.branch_prefix, cfg.repo.base_branch, cfg.status_label_prefix, c.store ?? null,
    );
    const poll = c.clock && c.log ? { clock: c.clock, history_since: githubHistorySince(c.loaded.file.github), log: c.log } : null;
    return new GitHubForge(c.github, c.repo, cfg.branch_prefix, cfg.repo.base_branch, issues, poll);
  },
});
