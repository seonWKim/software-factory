// Fakes of the worker's ports (RFC 0023 R4): auth, sandbox, agent runner, shared storage, network probe, session files.
import type { UserId, WorkItemId } from "../../../src/core/types.js";
import type { AgentRunResult, AgentRunSpec, AgentRunner } from "../../../src/interfaces/agent-runner.js";
import type { AuthDecision, AuthProvider, ExternalIdentity, Principal } from "../../../src/interfaces/auth-provider.js";
import type { ExecOptions, ExecResult, Sandbox, SandboxHandle, SandboxSpec } from "../../../src/interfaces/sandbox.js";
import type { NetworkProbe, NetworkProbeResult } from "../../../src/interfaces/network-probe.js";
import type { SharedStorage } from "../../../src/interfaces/shared-storage.js";
import type { IssueLookup, SessionFile, SessionFiles, SessionIssue } from "../../../src/core/session.js";

/** Only subject "1" may approve. */
export class FakeAuth implements AuthProvider {
  async resolve(identity: ExternalIdentity): Promise<Principal> {
    return { user_id: `github:${identity.subject}` as UserId };
  }
  async authorize(p: Principal, action: string): Promise<AuthDecision> {
    if (action === "submit_work" || p.user_id === "github:1") return { allow: true };
    return { allow: false, reason: "not_a_collaborator" };
  }
}

export class FakeSandbox implements Sandbox {
  created: SandboxSpec[] = [];
  destroyed = 0;
  /** Commits the next implement run "makes". */
  commits: string[] = ["c1"];
  /** Commits `git rev-list` reports for one exact argument list, ahead of `commits` (e.g. a branch's earlier work). */
  revLists: Record<string, string[]> = {};
  /** Files `git diff --name-only` reports for the branch against base (returned NUL-separated, as with `-z`). */
  changedFiles: string[] = [];
  /**
   * `git diff --numstat -z` output for the branch against base. Null: one line added per `changedFiles` entry.
   */
  numstat: string | null = null;
  /** Every git command line the worker ran, for asserting on order and arguments. */
  gitCalls: string[] = [];
  /** The env of each git command, in the same order as `gitCalls`. */
  gitEnvs: Readonly<Record<string, string>>[] = [];
  /** Every non-git command (argv joined by spaces), e.g. the install and test gate commands. */
  commands: string[] = [];

  // Merging the base branch (update and resolve runs).
  /** Exit of `git merge-base --is-ancestor`: 0 = the base is already in the branch. */
  ancestorExit = 0;
  /** Exit of `git merge`: non-zero with `conflicts` set is a conflicted merge. */
  mergeExit = 0;
  /** Files `git diff --diff-filter=U` reports as conflicting after the merge. */
  conflicts: string[] = [];
  /** Text `cat -- <path>` returns, e.g. a conflicting file with its markers. */
  files: Record<string, string> = {};
  /** What `git grep -l` for conflict markers prints in the resolve run's checked tree (non-empty: markers left). */
  markers = "";
  /** Files the resolve run changed between its pre-agent and post-agent snapshots. */
  resolveChanged: string[] = [];
  /** Exit codes of non-git commands by argv joined with spaces, e.g. { "npm test": 1 }. Default 0. */
  exits: Record<string, number> = {};
  /** What non-git commands print on stdout, by argv joined with spaces, e.g. { "npm test": "FAIL  tests/a.test.ts > x" }. */
  stdouts: Record<string, string> = {};
  /** What a plain `git diff` prints, e.g. a review run's diff against the base ("": an empty diff). */
  diff = "+ a change\n";
  /** What `git rev-parse HEAD` prints. A resolve run's checkout makes it its commit-tree result. */
  head = "base\n";
  /** What `git rev-parse origin/<branch>` prints, by branch (e.g. a PR's pushed head); a branch not listed prints nothing. */
  branchHeads: Record<string, string> = {};
  /** Commits `git rev-parse --verify --end-of-options <ref>^{commit}` resolves, by ref (e.g. a wip branch). */
  refs: Record<string, string> = {};
  /** Git argv prefixes (joined by spaces) that exit 1 with a `fatal:` stderr, e.g. "fetch" for a failed base fetch. */
  failGit: string[] = [];
  /** The stderr of a `failGit` command, when set (e.g. git's "Could not resolve host" line); else `fatal: <verb> failed`. */
  failGitStderr: string | null = null;
  /** What `git status --porcelain` prints: non-empty means the worktree has changes (a pause commits them). */
  status = "";
  /** When set, a `git commit` moves HEAD here (the WIP commit a pause makes). */
  commitHead: string | null = null;
  /** Folders created and not destroyed yet, by handle id: what `reattach` finds on this "host". */
  live = new Set<string>();
  /** Handles destroyed, in order. */
  destroyedIds: string[] = [];
  private trees = 0;

  async updateBase(): Promise<string> {
    return "basesha";
  }
  async create(spec: SandboxSpec): Promise<SandboxHandle> {
    this.created.push(spec);
    const id = `sbx${this.created.length}`;
    this.live.add(id);
    return { id, workdir: `/wt/${this.created.length}`, base_sha: "basesha" };
  }
  async reattach(id: string): Promise<SandboxHandle | null> {
    return this.live.has(id) ? { id, workdir: `/wt/${id.slice(3)}` } : null;
  }
  async exec(_h: SandboxHandle, cmd: readonly string[], o: ExecOptions): Promise<ExecResult> {
    const res = (exit_code: number, stdout = ""): ExecResult => ({ exit_code, signal: null, stdout, stderr: "", timed_out: false });
    const out = (stdout: string): ExecResult => res(0, stdout);
    if (cmd[0] !== "git") {
      const line = cmd.join(" ");
      this.commands.push(line);
      if (cmd[0] === "cat") return out(this.files[cmd.at(-1)!] ?? "");
      if (cmd[0] === "mktemp") return this.exits[line] ? res(this.exits[line]!) : out(`/tmp/sf-fake.${this.commands.length}\n`);
      return res(this.exits[line] ?? 0, this.stdouts[line] ?? "");
    }
    const args = cmd.slice(1).join(" ");
    this.gitCalls.push(args);
    this.gitEnvs.push({ ...o.env });
    if (this.failGit.some((p) => args.startsWith(p))) return { ...res(1), stderr: this.failGitStderr ?? `fatal: ${args.split(" ")[0]} failed` };
    if (args === "rev-parse HEAD") return out(this.head);
    const branch = args.match(/^rev-parse origin\/(.+)$/)?.[1];
    if (branch !== undefined && branch in this.branchHeads) return out(`${this.branchHeads[branch]}\n`);
    const ref = args.match(/^rev-parse --verify --end-of-options (.+)\^\{commit\}$/)?.[1];
    if (ref !== undefined && ref in this.refs) return out(`${this.refs[ref]}\n`);
    if (args.startsWith("rev-parse --path-format=absolute --git-path")) return out("/repo/.git/worktrees/x/sf-resolve-index\n");
    if (args.startsWith("rev-parse --path-format")) return out("/repo/.git\n");
    if (args.startsWith("rev-parse --verify") || args === "rev-parse origin/main") return out("basesha\n");
    if (args in this.revLists) return out(this.revLists[args]!.join("\n"));
    if (args.startsWith("rev-list")) return out(this.commits.join("\n"));
    if (args.startsWith("log -1")) return out("commit subject\n");
    if (args.startsWith("merge-base --is-ancestor")) return res(this.ancestorExit);
    if (args.startsWith("merge ")) return res(this.mergeExit);
    if (args === "write-tree") return out(`tree${++this.trees}\n`);
    if (args.startsWith("grep")) return this.markers ? out(this.markers) : res(1);
    if (args.startsWith("commit-tree")) return out("resolvedsha\n");
    if (/(^| )checkout /.test(args)) this.head = `${cmd.at(-1)}\n`;
    if (args.startsWith("status --porcelain")) return out(this.status);
    if (/(^| )commit /.test(args) && this.commitHead) this.head = `${this.commitHead}\n`;
    if (args.startsWith("diff --cached --quiet")) return res(1);
    if (args.startsWith("diff --numstat")) {
      return out(this.numstat ?? this.changedFiles.map((f) => `1\t0\t${f}\0`).join(""));
    }
    if (args.startsWith("diff --name-only -z --diff-filter=U")) return out(this.conflicts.map((f) => `${f}\0`).join(""));
    if (args.startsWith("diff --name-only -z --no-renames tree")) return out(this.resolveChanged.map((f) => `${f}\0`).join(""));
    if (args.startsWith("diff --name-only")) return out(this.changedFiles.map((f) => `${f}\0`).join(""));
    if (args.startsWith("diff")) return out(this.diff);
    return out("");
  }
  async copyIn(): Promise<void> {}
  async copyOut(): Promise<void> {}
  async destroy(h: SandboxHandle): Promise<void> {
    this.destroyed++;
    this.live.delete(h.id);
    this.destroyedIds.push(h.id);
  }
}

/** A script may be async, e.g. to move a FakeClock mid-run and wait for the worker to react. */
type Script = Partial<
  Record<AgentRunSpec["role"], (spec: AgentRunSpec) => Partial<AgentRunResult> | Promise<Partial<AgentRunResult>>>
>;

export class FakeRunner implements AgentRunner {
  specs: AgentRunSpec[] = [];
  /** The steps whose signal was aborted when their script returned: what a real runner would have stopped. */
  aborted: AgentRunSpec[] = [];
  constructor(public script: Script) {}

  async run(spec: AgentRunSpec): Promise<AgentRunResult> {
    this.specs.push(spec);
    const fn = this.script[spec.role];
    if (!fn) throw new Error(`no script for ${spec.role}`);
    const scripted = await fn(spec);
    if (spec.signal.aborted) this.aborted.push(spec);
    return {
      status: "completed",
      output: null,
      transcript: "{}",
      usage: { input_tokens: 10, output_tokens: 5, cost_usd: null },
      ...scripted,
    };
  }
}

export class MemoryStorage implements SharedStorage {
  data = new Map<string, Uint8Array>();
  async put(k: string, v: Uint8Array) {
    this.data.set(k, v);
  }
  async get(k: string) {
    return this.data.get(k) ?? null;
  }
  async list(prefix: string) {
    return [...this.data.keys()].filter((k) => k.startsWith(prefix));
  }
  async delete(k: string) {
    this.data.delete(k);
  }
}

/** A NetworkProbe whose answers are scripted, in order; with none left it passes. Counts its probes. */
export class FakeNetworkProbe implements NetworkProbe {
  probes = 0;
  constructor(public answers: NetworkProbeResult[] = []) {}
  async probe(): Promise<NetworkProbeResult> {
    this.probes++;
    return this.answers.shift() ?? { ok: true };
  }
}

/** `factory session`'s local records (src/core/session.ts), in memory instead of under state_dir. */
export class MemorySessionFiles implements SessionFiles {
  files = new Map<string, SessionFile>();
  read = async (id: WorkItemId) => this.files.get(id) ?? null;
  list = async () => [...this.files.values()];
  write = async (f: SessionFile) => void this.files.set(f.work_item_id, f);
  remove = async (id: WorkItemId) => void this.files.delete(id);
}

/** The repo's issues by number, for `session start` on an issue with no work item. Records each number asked. */
export class FakeIssues implements IssueLookup {
  readonly type = "github_issue";
  asked: number[] = [];
  constructor(readonly issues: Record<number, SessionIssue> = {}) {}
  issue = async (n: number) => (this.asked.push(n), this.issues[n] ?? null);
}
