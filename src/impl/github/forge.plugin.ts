import { definePlugin } from "../../plugin-api.js";
import type { Contexts } from "../../plugin-api.js";
import { type ProjectRef, projectLabel } from "../../core/project.js";
import type { RepoIdentity, RepoPath } from "../../interfaces/github-credentials.js";

/**
 * What build() passes beside the forge context (src/compose.ts): the store its PR comments and labels are recorded
 * in, and the Clock and log its poll needs. Left out (a bare build, as in Plugins.forge(github)): no records, no poll.
 */
type GitHubForgeContext = Contexts["forge"] & Partial<Pick<Contexts["source"], "store" | "clock" | "log">>;

// The project key of a GitHub repository (design 2026-11-01) is named here, not in the implementation, so the CLI
// and startup resolve it without loading the forge, and a config with no GitHub plugin loads no GitHub module.

/** The key of a GitHub repository: provider, host and the repository's node ID. */
export function githubProjectKey(host: string, nodeId: string): string {
  if (!/^[A-Za-z0-9.-]+(?::\d+)?$/.test(host)) throw new Error(`not a host name: ${JSON.stringify(host)}`);
  if (!/^[A-Za-z0-9_=-]+$/.test(nodeId)) throw new Error(`not a repository node ID: ${JSON.stringify(nodeId)}`);
  return `github:${host}:${nodeId}`;
}

/** What resolving the configured repo needs from the GitHub client: one read of the repository. */
export interface RepoLookup {
  repoIdentity(repo: RepoPath): Promise<RepoIdentity>;
}

/** A GitHub answer retrying cannot fix: bad credentials (401) or no such repository (404). */
function permanent(err: unknown): boolean {
  const status = (err as { status?: unknown } | null)?.status;
  return status === 401 || status === 404;
}

/**
 * The configured repo as a project (design 2026-11-01): its key from GitHub's node ID, its label from the path
 * GitHub reports now (a renamed repo gets its new path). Throws a message naming the configured repo and the
 * reason (the GitHub error as its `cause`, `permanent` as Forge.projectIdentity says) when GitHub cannot resolve it.
 */
export async function resolveProject(github: RepoLookup, repo: RepoPath): Promise<ProjectRef> {
  try {
    const id = await github.repoIdentity(repo);
    return { key: githubProjectKey(id.host, id.node_id), label: projectLabel(id.host, id.owner, id.name) };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw Object.assign(
      new Error(
        `cannot resolve the configured repo ${repo.owner}/${repo.name} (factory.config.json repo.owner / repo.name) to its GitHub repository ID: ${reason}`,
        { cause: err },
      ),
      { permanent: permanent(err) },
    );
  }
}

// Not a default: selected by `"forge": "github"` under `plugins`, or derived from `github-issues` in
// `plugins.source` when `plugins.forge` is left out (docs/plugins/forge.md).
export default definePlugin({
  kind: "forge",
  name: "github",
  create: async (ctx) => {
    const [{ GitHubIssueSource, githubHistorySince }, { GitHubForge }] = await Promise.all([import("./github-issue-source.js"), import("./github-forge.js")]);
    const c = ctx as GitHubForgeContext;
    const cfg = c.loaded.config;
    const issues = new GitHubIssueSource(
      c.github, c.repo, cfg.intake_label, cfg.branch_prefix, cfg.repo.base_branch, cfg.status_label_prefix, c.store ?? null,
    );
    const poll = c.clock && c.log ? { clock: c.clock, history_since: githubHistorySince(c.loaded.file.github), log: c.log } : null;
    return new GitHubForge(c.github, c.repo, cfg.branch_prefix, cfg.repo.base_branch, issues, poll, c.credentials ?? null);
  },
});
