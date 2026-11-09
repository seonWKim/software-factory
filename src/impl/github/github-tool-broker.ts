import type { Logger } from "../../core/log.js";
import type { Clock } from "../../interfaces/clock.js";
import type { EgressScanner } from "../../interfaces/egress-scanner.js";
import type { FactoryStore } from "../../interfaces/factory-store.js";
import { PREFLIGHT, STORE_BRANCH, type ToolBroker, type ToolCallContext, type ToolDescriptor, type ToolResult } from "../../interfaces/tool-broker.js";
import { FORGE_AUTH, GITHUB_RATE_LIMITED, NETWORK_UNAVAILABLE, PREFLIGHT_ACCESS, githubRateLimitMessage, networkDetail, unreachableHost } from "../../core/policy.js";
import type { GitHubApi } from "../../interfaces/github-credentials.js";
import { GitHubError, GitHubRateLimitError, type RepoRef } from "./github-client.js";
import { brokerToolName } from "../broker/tool-alias.js";
import { grantedTools, leaseLost } from "../broker/tool-broker-shared.js";
import { branchAllowed, storeBranch } from "../broker/trusted-git.js";

/**
 * Where a run's last step stores its branch in the factory repo (RFC 0015 M7): a staging ref outbound's
 * `github-push` pushes from, outside `refs/heads/`, so no person's branch is ever written. Forced: only runs write it,
 * and each push intent names its sha.
 */
export function stagingRef(branch: string): string {
  return `refs/factory/outbound/${branch}`;
}

const TOOLS: readonly ToolDescriptor[] = [
  {
    name: STORE_BRANCH,
    read_only: false,
    description: "Store the current HEAD of a run folder in the factory repo, for outbound to push to its factory branch on the forge.",
    input_schema: {
      type: "object",
      required: ["workdir", "branch", "base_ref"],
      properties: { workdir: { type: "string" }, branch: { type: "string" }, base_ref: { type: "string" } },
    },
  },
  {
    name: PREFLIGHT,
    read_only: true,
    description:
      "Read-only check before an implement run's agent starts: the credentials may push to the repository, and the PR API answers for the branch.",
    input_schema: {
      type: "object",
      required: ["branch", "base_ref"],
      properties: { branch: { type: "string" }, base_ref: { type: "string" } },
    },
  },
];

interface PushArgs {
  workdir: string;
  branch: string;
  base_ref: string;
}
interface PreflightArgs {
  branch: string;
  base_ref: string;
}

/**
 * G2: a run's GitHub tools, in the worker process: the store of its branch in the factory repo (the push and the PR
 * are outbound's, through the forge, RFC 0015 M7) and the read-only preflight. Every call checks the caller still
 * holds its lease (fencing); the store egress-scans the branch (G5) and writes only factory branches.
 */
export class GitHubToolBroker implements ToolBroker {
  constructor(
    private readonly deps: {
      client: GitHubApi;
      store: FactoryStore;
      scanner: EgressScanner;
      clock: Clock;
      repo: RepoRef;
      branchPrefix: string;
      /** The factory repo: its origin is the trusted push remote, its origin/<base> the trusted base. */
      repoPath?: string;
      /** Where an old tool name's one warning goes; stderr when absent. */
      log?: Pick<Logger, "warn">;
    },
  ) {}

  listTools(grants: readonly string[]): ToolDescriptor[] {
    return grantedTools(TOOLS, grants);
  }

  /** The store writes the factory repo; only the preflight, which reads, is read-only. */
  allTools(): readonly ToolDescriptor[] {
    return TOOLS;
  }

  async call(ctx: ToolCallContext, name: string, args: unknown): Promise<ToolResult> {
    const lost = await leaseLost(this.deps.store, ctx);
    if (lost) return lost;
    switch (brokerToolName(name, this.deps.log)) {
      case STORE_BRANCH:
        return this.store(args as PushArgs);
      case PREFLIGHT:
        return this.preflight(args as PreflightArgs);
      default:
        return { ok: false, error_code: "unknown_tool", message: name };
    }
  }

  /** The run's last step (RFC 0015 M7): its HEAD stored on the factory repo's staging ref, no remote, no credential. */
  private async store(a: PushArgs): Promise<ToolResult> {
    const refused = branchAllowed(a.branch, this.deps.branchPrefix);
    if (refused) return refused;
    const repo = this.deps.repoPath;
    if (!repo) return { ok: false, error_code: "no_trusted_repo", message: "the broker has no factory repo path" };
    const r = await storeBranch(a.workdir, { repo, base: `origin/${a.base_ref}`, ref: stagingRef(a.branch), force: true }, this.deps.scanner);
    return "sha" in r ? { ok: true, content: { sha: r.sha, forge: true } } : r;
  }

  /**
   * The implement preflight's forge checks (design §5 Restarts), read-only: one GET of the repository (it answers;
   * its push flag is only reported) and one GET of the branch's open PRs (the PR API answers). The base fetch is the worker's. A
   * GitHub rate limit is `github_rate_limited` with its reset; another 401 or 403 is `forge_auth`; a DNS or connect error
   * `network_unavailable` (the network pause, its message the host only); anything else `preflight_access` (since
   * 2026-11-07, issue #216; before, `preflight_failed`),
   * which pauses implement-type claims. The message starts with the failed check's name and
   * carries the status only: no response body, no header, no credential.
   */
  private async preflight(a: PreflightArgs): Promise<ToolResult> {
    const refused = branchAllowed(a.branch, this.deps.branchPrefix);
    if (refused) return refused;
    const { owner, name } = this.deps.repo;
    const check = async <T>(what: "push_access" | "pr_api", path: string): Promise<{ value: T } | ToolResult> => {
      try {
        return { value: await this.deps.client.request<T>("GET", path) };
      } catch (err) {
        const limited = rateLimited(what, err);
        if (limited) return limited;
        const status = refusedStatus(err);
        if (status) return { ok: false, error_code: FORGE_AUTH, message: `${what}: GitHub refused the credentials (${status})` };
        // DNS or connect: the network pause (design §5 Restarts), the host only, no attempt spent.
        const host = err instanceof GitHubError ? null : unreachableHost(causeText(err));
        if (host !== null) return { ok: false, error_code: NETWORK_UNAVAILABLE, message: networkDetail(host) };
        const why = err instanceof GitHubError ? `GitHub answered ${err.status}` : "GitHub could not be reached";
        return { ok: false, error_code: PREFLIGHT_ACCESS, message: `${what}: ${why}` };
      }
    };
    const repo = await check<{ permissions?: { push?: boolean } }>("push_access", `/repos/${owner}/${name}`);
    if (!("value" in repo)) return repo;
    // Reported, never a failure: a GitHub App installation token's answer says `push: false` even when the app
    // has contents: write (2026-11-02: every implement run failed this check while pushes worked). The push itself
    // is the check, and its 401/403 still pauses (forge_auth).
    const push = repo.value?.permissions?.push;
    const prs = await check<unknown[]>(
      "pr_api",
      `/repos/${owner}/${name}/pulls?state=open&head=${encodeURIComponent(`${owner}:${a.branch}`)}&per_page=1`,
    );
    if (!("value" in prs)) return prs;
    return { ok: true, content: { push: push ?? null, open_prs: Array.isArray(prs.value) ? prs.value.length : 0 } };
  }
}

/** An error's message and its causes' (fetch puts the DNS or connect error in `cause`), for classifying only. */
function causeText(err: unknown): string {
  const parts: string[] = [];
  for (let e: unknown = err, depth = 0; e instanceof Error && depth < 4; e = (e as { cause?: unknown }).cause, depth++) parts.push(e.message);
  return parts.join(": ");
}

/** A GitHub rate limit as a result (design §5 Restarts): its message carries the reset; else null. */
function rateLimited(what: string, err: unknown): ToolResult | null {
  if (!(err instanceof GitHubRateLimitError)) return null;
  return { ok: false, error_code: GITHUB_RATE_LIMITED, message: githubRateLimitMessage(what, err.reset_at) };
}

/** The status of a GitHub 401 or 403 that is not a rate limit, else null. */
function refusedStatus(err: unknown): 401 | 403 | null {
  if (err instanceof GitHubRateLimitError) return null;
  return err instanceof GitHubError && (err.status === 401 || err.status === 403) ? err.status : null;
}
