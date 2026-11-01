import type { Clock } from "../../interfaces/clock.js";
import type { EgressScanner } from "../../interfaces/egress-scanner.js";
import type { FactoryStore } from "../../interfaces/factory-store.js";
import type { GitHubCredentials } from "../../interfaces/github-credentials.js";
import type { ToolBroker, ToolCallContext, ToolDescriptor, ToolResult } from "../../interfaces/tool-broker.js";
import type { GitHubClient, RepoRef } from "../github/github-client.js";
import { baseEnv, runProcess } from "../process/run-process.js";

const TOOLS: readonly ToolDescriptor[] = [
  {
    name: "github.push_branch",
    description: "Push the current HEAD of a factory worktree to its factory branch.",
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

  private async push(a: PushArgs): Promise<ToolResult> {
    if (!a.branch.startsWith(this.deps.branchPrefix)) {
      return { ok: false, error_code: "branch_not_allowed", message: `only ${this.deps.branchPrefix}* branches` };
    }
    const git = (args: string[], extra: Record<string, string> = {}) =>
      runProcess(["git", ...args], { cwd: a.workdir, env: baseEnv({ GIT_TERMINAL_PROMPT: "0", ...extra }) });

    const range = `origin/${a.base_ref}...HEAD`;
    const [log, diff] = await Promise.all([git(["log", "--format=%B", range]), git(["diff", range])]);
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
      ["-c", "credential.helper=", "-c", `credential.helper=${helper}`, "push", "--quiet", "origin", `HEAD:refs/heads/${a.branch}`],
      { SF_GIT_TOKEN: token.reveal() },
    );
    if (r.exit_code !== 0) return { ok: false, error_code: "push_failed", message: r.stderr.trim().slice(0, 500) };
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
  }

  private async comment(a: CommentArgs): Promise<ToolResult> {
    const scan = await this.deps.scanner.scan("comment", a.body);
    if (!scan.clean) return { ok: false, error_code: "egress_blocked", message: scan.findings.map((f) => f.rule).join(",") };
    const r = await this.deps.client.commentOnce(this.deps.repo, a.number, a.body, a.marker);
    return { ok: true, content: r };
  }
}
