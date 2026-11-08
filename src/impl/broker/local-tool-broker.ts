import type { Logger } from "../../core/log.js";
import type { EgressScanner } from "../../interfaces/egress-scanner.js";
import type { FactoryStore } from "../../interfaces/factory-store.js";
import type { ToolBroker, ToolCallContext, ToolDescriptor, ToolResult } from "../../interfaces/tool-broker.js";
import { brokerToolName } from "./tool-alias.js";
import { branchAllowed, factoryCommit, holdsLease, scanBranch, trustedRunFolder } from "./trusted-git.js";

/**
 * The local broker's only tool, named like the GitHub broker's push so the worker calls one name (`github.push_branch`
 * still runs it, as an alias); it pushes to no remote. No `forge.open_change`, `forge.preflight` or `forge.comment`:
 * a local item has no PR, and its messages are its thread.
 */
const TOOLS: readonly ToolDescriptor[] = [
  {
    name: "forge.push_branch",
    read_only: false,
    description: "Commit the current HEAD of a run folder to its factory branch in the factory repo itself, as a local branch. Pushes to no remote.",
    input_schema: {
      type: "object",
      required: ["workdir", "branch", "base_ref"],
      properties: { workdir: { type: "string" }, branch: { type: "string" }, base_ref: { type: "string" } },
    },
  },
];

interface PushArgs {
  workdir: string;
  branch: string;
  base_ref: string;
}

/**
 * G2 with no forge (design 05-sources, local startup): a run's branch becomes the local branch
 * `refs/heads/<branch>` of the factory repo. Never pushes to a remote, never calls the forge, needs no credential.
 * Still a full guard: every call checks the lease, only factory branches are written, the run folder passes the
 * trusted-git checks, and the commits, diff (from the factory repo's local base branch) and `.env.example` files
 * are egress-scanned before any ref is written.
 */
export class LocalToolBroker implements ToolBroker {
  constructor(
    private readonly deps: {
      store: Pick<FactoryStore, "getRun">;
      scanner: EgressScanner;
      branchPrefix: string;
      /** The factory repo: its `refs/heads/<base>` is the trusted base; its branches are where runs land. */
      repoPath: string;
      /** Where a github.* alias's one warning goes; stderr when absent. */
      log?: Pick<Logger, "warn">;
    },
  ) {}

  listTools(grants: readonly string[]): ToolDescriptor[] {
    return TOOLS.filter((t) => grants.includes(t.name));
  }

  allTools(): readonly ToolDescriptor[] {
    return TOOLS;
  }

  async call(ctx: ToolCallContext, name: string, args: unknown): Promise<ToolResult> {
    if (!(await holdsLease(this.deps.store, ctx))) return { ok: false, error_code: "lease_lost", message: "run no longer holds its lease" };
    if (brokerToolName(name, this.deps.log) === "forge.push_branch") return this.commitBranch(args as PushArgs);
    return { ok: false, error_code: "unknown_tool", message: name };
  }

  /**
   * Moves `refs/heads/<branch>` of the factory repo to the run folder's HEAD with a push to the repo's own path
   * (git's local transport: the factory repo receives with its own config, the run folder's is never read there).
   * Never forced: a branch that moved elsewhere is refused (`push_failed`).
   */
  private async commitBranch(a: PushArgs): Promise<ToolResult> {
    const refused = branchAllowed(a.branch, this.deps.branchPrefix);
    if (refused) return refused;
    const repo = this.deps.repoPath;
    const base = await factoryCommit(repo, `refs/heads/${a.base_ref}`);
    if (!("sha" in base)) return base;
    const folder = await trustedRunFolder(a.workdir);
    if (!("git" in folder)) return folder;
    const blocked = await scanBranch(folder.git, base.sha, this.deps.scanner);
    if (blocked) return blocked;
    const r = await folder.git(["-c", "credential.helper=", "push", "--quiet", "--no-verify", repo, `HEAD:refs/heads/${a.branch}`]);
    if (r.exit_code !== 0) return { ok: false, error_code: "push_failed", message: r.stderr.trim().slice(0, 500) };
    const head = await folder.git(["rev-parse", "HEAD"]);
    return { ok: true, content: { sha: head.stdout.trim() } };
  }
}
