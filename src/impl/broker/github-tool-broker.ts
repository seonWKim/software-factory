import { lstat, realpath } from "node:fs/promises";
import { join } from "node:path";
import { TRUSTED_GIT_ENV, untrustedGitConfig } from "../../core/worker.js";
import type { Clock } from "../../interfaces/clock.js";
import type { EgressScanner } from "../../interfaces/egress-scanner.js";
import type { FactoryStore } from "../../interfaces/factory-store.js";
import type { GitHubCredentials } from "../../interfaces/github-credentials.js";
import type { ToolBroker, ToolCallContext, ToolDescriptor, ToolResult } from "../../interfaces/tool-broker.js";
import { FORGE_AUTH, PREFLIGHT_FAILED } from "../../core/policy.js";
import { GitHubError, type GitHubClient, type RepoRef } from "../github/github-client.js";
import { baseEnv, runProcess } from "../process/run-process.js";

/**
 * The run folder's git folder, as a real path, if it is the clone's own: a directory (not a link or a `gitdir:`
 * file) with no `commondir` or `config.worktree` that would make git read another folder's config.
 */
async function runFolderGitDir(workdir: string): Promise<string | null> {
  const dir = join(workdir, ".git");
  const st = await lstat(dir).catch(() => null);
  if (!st?.isDirectory()) return null;
  for (const f of ["commondir", "config.worktree"]) {
    if (await lstat(join(dir, f)).then(() => true, () => false)) return null;
  }
  const cfg = await lstat(join(dir, "config")).catch(() => null);
  if (!cfg?.isFile()) return null;
  return realpath(dir);
}

const TOOLS: readonly ToolDescriptor[] = [
  {
    name: "github.push_branch",
    description: "Push the current HEAD of a run folder to its factory branch on the factory repo's remote.",
    input_schema: {
      type: "object",
      required: ["workdir", "branch", "base_ref"],
      properties: { workdir: { type: "string" }, branch: { type: "string" }, base_ref: { type: "string" } },
    },
  },
  {
    name: "github.open_pr",
    description: "Open a PR for a factory branch, or return the open one.",
    input_schema: {
      type: "object",
      required: ["branch", "base_ref", "title", "body"],
      properties: {
        branch: { type: "string" },
        base_ref: { type: "string" },
        title: { type: "string" },
        body: { type: "string" },
      },
    },
  },
  {
    name: "github.preflight",
    description:
      "Read-only check before an implement run's agent starts: the credentials may push to the repository, and the PR API answers for the branch.",
    input_schema: {
      type: "object",
      required: ["branch", "base_ref"],
      properties: { branch: { type: "string" }, base_ref: { type: "string" } },
    },
  },
  {
    name: "github.comment",
    description: "Comment on an issue or PR at most once per marker.",
    input_schema: {
      type: "object",
      required: ["number", "body", "marker"],
      properties: { number: { type: "integer" }, body: { type: "string" }, marker: { type: "string" } },
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
}
interface PreflightArgs {
  branch: string;
  base_ref: string;
}
interface CommentArgs {
  number: number;
  body: string;
  marker: string;
}

/**
 * G2: credentialed GitHub actions, in the worker process. Every call checks the caller still holds
 * its lease (fencing) and egress-scans what it is about to send (G5). Pushes only to factory branches.
 */
export class GitHubToolBroker implements ToolBroker {
  constructor(
    private readonly deps: {
      client: GitHubClient;
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

  async call(ctx: ToolCallContext, name: string, args: unknown): Promise<ToolResult> {
    if (!(await this.holdsLease(ctx))) return { ok: false, error_code: "lease_lost", message: "run no longer holds its lease" };
    switch (name) {
      case "github.push_branch":
        return this.push(args as PushArgs);
      case "github.open_pr":
        return this.openPr(args as PrArgs);
      case "github.preflight":
        return this.preflight(args as PreflightArgs);
      case "github.comment":
        return this.comment(args as CommentArgs);
      default:
        return { ok: false, error_code: "unknown_tool", message: name };
    }
  }

  /**
   * Same rule as the store: status and token fence the caller, not the clock. A run whose lease ran out
   * during a host sleep but was not reaped still holds it; after a requeue or reclaim it does not.
   */
  private async holdsLease(ctx: ToolCallContext): Promise<boolean> {
    const run = await this.deps.store.getRun(ctx.run_id);
    return (
      run !== null &&
      run.work_item_id === ctx.work_item_id &&
      run.status === "running" &&
      run.lease?.token === ctx.lease_token
    );
  }

  /**
   * Pushes the run folder's HEAD. Everything trusted comes from the factory repo, never from the run folder the
   * agent could write (design §5): the remote URL, and the base commit the scanned diff starts from. Git in the
   * run folder runs with TRUSTED_GIT_ENV and only after its git folder and config pass the checks, so no hook,
   * fsmonitor, textconv or URL rewrite the agent configured runs or redirects the push.
   */
  private async push(a: PushArgs): Promise<ToolResult> {
    if (!a.branch.startsWith(this.deps.branchPrefix)) {
      return { ok: false, error_code: "branch_not_allowed", message: `only ${this.deps.branchPrefix}* branches` };
    }
    const repo = this.deps.repoPath;
    if (!repo) return { ok: false, error_code: "no_trusted_repo", message: "the broker has no factory repo path" };
    const trusted = (args: string[]) => runProcess(["git", "-C", repo, ...args], { cwd: repo, env: baseEnv({ GIT_TERMINAL_PROMPT: "0" }) });
    const [baseR, urlR] = await Promise.all([
      trusted(["rev-parse", "--verify", "--end-of-options", `origin/${a.base_ref}^{commit}`]),
      trusted(["remote", "get-url", "--push", "origin"]),
    ]);
    if (baseR.exit_code !== 0 || urlR.exit_code !== 0) {
      return { ok: false, error_code: "git_failed", message: (baseR.stderr + urlR.stderr).trim().slice(0, 500) };
    }
    const base = baseR.stdout.trim();
    const url = urlR.stdout.trim();

    const gitDir = await runFolderGitDir(a.workdir);
    if (!gitDir) return { ok: false, error_code: "untrusted_git_dir", message: "the run folder's .git is not its own git folder" };
    const git = (args: string[], extra: Record<string, string> = {}) =>
      runProcess(["git", ...args], {
        cwd: a.workdir,
        env: baseEnv({ ...extra, ...TRUSTED_GIT_ENV, GIT_DIR: gitDir, GIT_WORK_TREE: a.workdir }),
      });
    const names = await git(["config", "--file", join(gitDir, "config"), "--name-only", "--list", "-z"]);
    if (names.exit_code !== 0) return { ok: false, error_code: "git_failed", message: names.stderr.trim().slice(0, 500) };
    const untrusted = untrustedGitConfig(names.stdout);
    if (untrusted.length > 0) {
      return { ok: false, error_code: "untrusted_git_config", message: untrusted.join(", ").slice(0, 500) };
    }

    const range = `${base}...HEAD`;
    const [log, diff] = await Promise.all([
      git(["log", "--no-textconv", "--format=%B", range]),
      git(["diff", "--no-textconv", "--no-ext-diff", range]),
    ]);
    if (log.exit_code !== 0 || diff.exit_code !== 0) {
      return { ok: false, error_code: "git_failed", message: (log.stderr + diff.stderr).trim() };
    }
    for (const [channel, content] of [["commit", log.stdout], ["commit", diff.stdout]] as const) {
      const scan = await this.deps.scanner.scan(channel, content);
      if (!scan.clean) return { ok: false, error_code: "egress_blocked", message: scan.findings.map((f) => f.rule).join(",") };
    }

    const token = await this.deps.credentials.token();
    if (!token) return { ok: false, error_code: "no_credential", message: "GitHub credentials missing" };
    // The token reaches git only through this child's env and an inline credential helper, never argv.
    const helper = '!f() { echo username=x-access-token; echo "password=$SF_GIT_TOKEN"; }; f';
    const r = await git(
      ["-c", "credential.helper=", "-c", `credential.helper=${helper}`, "push", "--quiet", "--no-verify", url, `HEAD:refs/heads/${a.branch}`],
      { SF_GIT_TOKEN: token.reveal() },
    );
    if (r.exit_code !== 0) {
      // A refused credential is not a rejected push: forge_auth pauses implement-type claims (design §5 Restarts).
      return { ok: false, error_code: forgeAuthRefused(r.stderr) ? FORGE_AUTH : "push_failed", message: r.stderr.trim().slice(0, 500) };
    }
    const head = await git(["rev-parse", "HEAD"]);
    return { ok: true, content: { sha: head.stdout.trim() } };
  }

  private async openPr(a: PrArgs): Promise<ToolResult> {
    if (!a.branch.startsWith(this.deps.branchPrefix)) {
      return { ok: false, error_code: "branch_not_allowed", message: `only ${this.deps.branchPrefix}* branches` };
    }
    const scan = await this.deps.scanner.scan("pr", `${a.title}\n${a.body}`);
    if (!scan.clean) return { ok: false, error_code: "egress_blocked", message: scan.findings.map((f) => f.rule).join(",") };

    const { owner, name } = this.deps.repo;
    try {
      const open = await this.deps.client.request<{ number: number; html_url: string }[]>(
        "GET",
        `/repos/${owner}/${name}/pulls?state=open&head=${encodeURIComponent(`${owner}:${a.branch}`)}`,
      );
      const pr =
        open[0] ??
        (await this.deps.client.request<{ number: number; html_url: string }>("POST", `/repos/${owner}/${name}/pulls`, {
          head: a.branch,
          base: a.base_ref,
          title: a.title,
          body: a.body,
        }));
      return { ok: true, content: { number: pr.number, url: pr.html_url } };
    } catch (err) {
      // A 401/403 is a result, not an exception (design §5 Restarts). Any other error throws, as before.
      if (refusedStatus(err)) return { ok: false, error_code: FORGE_AUTH, message: `open_pr: GitHub refused the credentials (${refusedStatus(err)})` };
      throw err;
    }
  }

  /**
   * The implement preflight's forge checks (design §5 Restarts), read-only: one GET of the repository (it answers;
   * its push flag is only reported) and one GET of the branch's open PRs (the PR API answers). The base fetch is the worker's. A 401
   * or 403 is `forge_auth`; anything else `preflight_failed`. The message starts with the failed check's name and
   * carries the status only: no response body, no header, no credential.
   */
  private async preflight(a: PreflightArgs): Promise<ToolResult> {
    if (!a.branch.startsWith(this.deps.branchPrefix)) {
      return { ok: false, error_code: "branch_not_allowed", message: `only ${this.deps.branchPrefix}* branches` };
    }
    const { owner, name } = this.deps.repo;
    const check = async <T>(what: "push_access" | "pr_api", path: string): Promise<{ value: T } | ToolResult> => {
      try {
        return { value: await this.deps.client.request<T>("GET", path) };
      } catch (err) {
        const status = refusedStatus(err);
        if (status) return { ok: false, error_code: FORGE_AUTH, message: `${what}: GitHub refused the credentials (${status})` };
        const why = err instanceof GitHubError ? `GitHub answered ${err.status}` : "GitHub could not be reached";
        return { ok: false, error_code: PREFLIGHT_FAILED, message: `${what}: ${why}` };
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

  private async comment(a: CommentArgs): Promise<ToolResult> {
    const scan = await this.deps.scanner.scan("comment", a.body);
    if (!scan.clean) return { ok: false, error_code: "egress_blocked", message: scan.findings.map((f) => f.rule).join(",") };
    const r = await this.deps.client.commentOnce(this.deps.repo, a.number, a.body, a.marker);
    return { ok: true, content: r };
  }
}

/** The status of a GitHub 401 or 403, else null. */
function refusedStatus(err: unknown): 401 | 403 | null {
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
