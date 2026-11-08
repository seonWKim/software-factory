import type { EgressScanner } from "../../interfaces/egress-scanner.js";
import type { FactoryStore } from "../../interfaces/factory-store.js";
import { STORE_BRANCH, type ToolBroker, type ToolCallContext, type ToolDescriptor, type ToolResult } from "../../interfaces/tool-broker.js";
import { branchAllowed, holdsLease, storeBranch } from "./trusted-git.js";

const SCHEMA = {
  type: "object",
  required: ["workdir", "branch", "base_ref"],
  properties: { workdir: { type: "string" }, branch: { type: "string" }, base_ref: { type: "string" } },
};

/**
 * The local broker's one tool: `git.store_branch` (a run's push, RFC 0015 M7: the implement, update and resolve
 * runs, a wip branch, the session's finish). It pushes to no remote. No `github.preflight`: a local item has no PR.
 */
const TOOLS: readonly ToolDescriptor[] = [
  {
    name: STORE_BRANCH,
    read_only: false,
    description: "Store the current HEAD of a run folder as its factory branch in the factory repo itself, as a local branch. Pushes to no remote.",
    input_schema: SCHEMA,
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
    if (name === STORE_BRANCH) return this.commitBranch(args as PushArgs);
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
    const r = await storeBranch(a.workdir, { repo, base: `refs/heads/${a.base_ref}`, ref: `refs/heads/${a.branch}`, force: false }, this.deps.scanner);
    return "sha" in r ? { ok: true, content: { sha: r.sha, forge: false } } : r;
  }
}
