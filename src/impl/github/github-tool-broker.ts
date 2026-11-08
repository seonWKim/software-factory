import type { Clock } from "../../interfaces/clock.js";
import type { EgressScanner } from "../../interfaces/egress-scanner.js";
import type { FactoryStore } from "../../interfaces/factory-store.js";
import type { GitHubCredentials } from "../../interfaces/github-credentials.js";
import type { ToolBroker, ToolCallContext, ToolDescriptor, ToolResult } from "../../interfaces/tool-broker.js";
import { FORGE_AUTH, GITHUB_RATE_LIMITED, NETWORK_UNAVAILABLE, PREFLIGHT_ACCESS, githubRateLimitMessage, networkDetail, unreachableHost } from "../../core/policy.js";
import type { GitHubApi } from "../../interfaces/github-credentials.js";
import { GitHubError, GitHubRateLimitError, type RepoRef } from "./github-client.js";
import { branchAllowed, holdsLease, factoryCommit, factoryRemoteUrl, scanBranch, trustedRunFolder } from "../broker/trusted-git.js";

const TOOLS: readonly ToolDescriptor[] = [
  {
    name: "github.push_branch",
    read_only: false,
    description: "Push the current HEAD of a run folder to its factory branch on the factory repo's remote.",
    input_schema: {
      type: "object",
      required: ["workdir", "branch", "base_ref"],
      properties: { workdir: { type: "string" }, branch: { type: "string" }, base_ref: { type: "string" } },
    },
  },
  {
    name: "github.open_pr",
    read_only: false,
    description:
      "Open a PR for a factory branch, or update the open one's title and body so it matches the branch. `labels` adds (true) or removes (false) each named label on it.",
    input_schema: {
      type: "object",
      required: ["branch", "base_ref", "title", "body"],
      properties: {
        branch: { type: "string" },
        base_ref: { type: "string" },
        title: { type: "string" },
        body: { type: "string" },
        labels: { type: "object", additionalProperties: { type: "boolean" } },
      },
    },
  },
  {
    name: "github.preflight",
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
interface PrArgs {
  branch: string;
  base_ref: string;
  title: string;
  body: string;
  /** Label name → present. Adding creates a missing label; removing one that is not there is a no-op. */
  labels?: Record<string, boolean>;
}
interface PreflightArgs {
  branch: string;
  base_ref: string;
}

/**
 * G2: credentialed GitHub actions, in the worker process. Every call checks the caller still holds
 * its lease (fencing) and egress-scans what it is about to send (G5). Pushes only to factory branches.
 */
export class GitHubToolBroker implements ToolBroker {
  constructor(
    private readonly deps: {
      client: GitHubApi;
      credentials: GitHubCredentials;
      store: FactoryStore;
      scanner: EgressScanner;
      clock: Clock;
      repo: RepoRef;
      branchPrefix: string;
      /** The factory repo: its origin is the trusted push remote, its origin/<base> the trusted base. */
      repoPath?: string;
    },
  ) {}

  listTools(grants: readonly string[]): ToolDescriptor[] {
    return TOOLS.filter((t) => grants.includes(t.name));
  }

  /** Push and PR change the forge; only the preflight, which reads, is read-only. */
  allTools(): readonly ToolDescriptor[] {
    return TOOLS;
  }

  async call(ctx: ToolCallContext, name: string, args: unknown): Promise<ToolResult> {
    if (!(await holdsLease(this.deps.store, ctx))) return { ok: false, error_code: "lease_lost", message: "run no longer holds its lease" };
    switch (name) {
      case "github.push_branch":
        return this.push(args as PushArgs);
      case "github.open_pr":
        return this.openPr(args as PrArgs);
      case "github.preflight":
        return this.preflight(args as PreflightArgs);
      default:
        return { ok: false, error_code: "unknown_tool", message: name };
    }
  }

  /**
   * Pushes the run folder's HEAD. Everything trusted comes from the factory repo, never from the run folder the
   * agent could write (design §5): the remote URL, and the base commit the scanned diff starts from. Git in the
   * run folder runs with TRUSTED_GIT_ENV and only after its git folder and config pass the checks, so no hook,
   * fsmonitor, textconv or URL rewrite the agent configured runs or redirects the push.
   */
  private async push(a: PushArgs): Promise<ToolResult> {
    const refused = branchAllowed(a.branch, this.deps.branchPrefix);
    if (refused) return refused;
    const repo = this.deps.repoPath;
    if (!repo) return { ok: false, error_code: "no_trusted_repo", message: "the broker has no factory repo path" };
    const [baseR, urlR] = await Promise.all([
      factoryCommit(repo, `origin/${a.base_ref}`),
      factoryRemoteUrl(repo),
    ]);
    if (!("sha" in baseR) || !("url" in urlR)) {
      const why = [baseR, urlR].map((r) => ("message" in r ? r.message : "")).join(" ");
      return { ok: false, error_code: "git_failed", message: why.trim().slice(0, 500) };
    }
    const url = urlR.url;

    const folder = await trustedRunFolder(a.workdir);
    if (!("git" in folder)) return folder;
    const { git } = folder;
    const blocked = await scanBranch(git, baseR.sha, this.deps.scanner);
    if (blocked) return blocked;

    const token = await this.deps.credentials.token();
    if (!token) return { ok: false, error_code: "no_credential", message: "GitHub credentials missing" };
    // The token reaches git only through this child's env and an inline credential helper, never argv.
    const helper = '!f() { echo username=x-access-token; echo "password=$SF_GIT_TOKEN"; }; f';
    const r = await git(
      ["-c", "credential.helper=", "-c", `credential.helper=${helper}`, "push", "--quiet", "--no-verify", url, `HEAD:refs/heads/${a.branch}`],
      { SF_GIT_TOKEN: token.reveal() },
    );
    if (r.exit_code !== 0) {
      // A host that cannot be reached is the network, not the push: the network pause, with the host only.
      const host = unreachableHost(r.stderr);
      if (host !== null) return { ok: false, error_code: NETWORK_UNAVAILABLE, message: networkDetail(host) };
      // A refused credential is not a rejected push: forge_auth pauses implement-type claims (design §5 Restarts).
      return { ok: false, error_code: forgeAuthRefused(r.stderr) ? FORGE_AUTH : "push_failed", message: r.stderr.trim().slice(0, 500) };
    }
    const head = await git(["rev-parse", "HEAD"]);
    return { ok: true, content: { sha: head.stdout.trim() } };
  }

  private async openPr(a: PrArgs): Promise<ToolResult> {
    const refused = branchAllowed(a.branch, this.deps.branchPrefix);
    if (refused) return refused;
    const scan = await this.deps.scanner.scan("pr", [a.title, a.body, ...Object.keys(a.labels ?? {})].join("\n"));
    if (!scan.clean) return { ok: false, error_code: "egress_blocked", message: scan.findings.map((f) => f.rule).join(",") };

    const { owner, name } = this.deps.repo;
    try {
      const open = await this.deps.client.request<{ number: number; html_url: string }[]>(
        "GET",
        `/repos/${owner}/${name}/pulls?state=open&head=${encodeURIComponent(`${owner}:${a.branch}`)}`,
      );
      // An open PR gets this push's title and body (issue #229): the description follows the branch.
      const pr = open[0]
        ? await this.deps.client.request<{ number: number; html_url: string }>("PATCH", `/repos/${owner}/${name}/pulls/${open[0].number}`, {
          title: a.title,
          body: a.body,
        })
        : await this.deps.client.request<{ number: number; html_url: string }>("POST", `/repos/${owner}/${name}/pulls`, {
          head: a.branch,
          base: a.base_ref,
          title: a.title,
          body: a.body,
        });
      for (const [label, present] of Object.entries(a.labels ?? {})) {
        const path = `/repos/${owner}/${name}/issues/${pr.number}/labels`;
        if (present) {
          await this.deps.client.request("POST", path, { labels: [label] });
          continue;
        }
        try {
          await this.deps.client.request("DELETE", `${path}/${encodeURIComponent(label)}`);
        } catch (err) {
          if (!(err instanceof GitHubError && err.status === 404)) throw err;
        }
      }
      return { ok: true, content: { number: pr.number, url: pr.html_url } };
    } catch (err) {
      // A rate limit or a 401/403 is a result, not an exception (design §5 Restarts). Any other error throws, as before.
      const limited = rateLimited("open_pr", err);
      if (limited) return limited;
      if (refusedStatus(err)) return { ok: false, error_code: FORGE_AUTH, message: `open_pr: GitHub refused the credentials (${refusedStatus(err)})` };
      throw err;
    }
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

/**
 * Whether git's push stderr says the forge refused the credentials (HTTP 401/403, a denied permission, failed
 * authentication), as opposed to a rejected push (non-fast-forward, a hook, a protected branch).
 */
export function forgeAuthRefused(stderr: string): boolean {
  return (
    /The requested URL returned error: (401|403)\b/.test(stderr) ||
    /Authentication failed for/.test(stderr) ||
    /Permission to \S+ denied/.test(stderr) ||
    /Invalid username or (password|token)/.test(stderr)
  );
}
