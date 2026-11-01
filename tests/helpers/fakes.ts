import type { FactoryConfig, Prompts } from "../../src/core/config.js";
import type { LogFields, Logger } from "../../src/core/log.js";
import { WORK_STATUSES, type WorkStatus } from "../../src/core/status-label.js";
import type { SourceRef, UserId } from "../../src/core/types.js";
import type { AgentRunResult, AgentRunSpec, AgentRunner } from "../../src/interfaces/agent-runner.js";
import { PatternEgressScanner } from "../../src/impl/egress/pattern-egress-scanner.js";
import type { AuthDecision, AuthProvider, ExternalIdentity, Principal } from "../../src/interfaces/auth-provider.js";
import type { ExecOptions, ExecResult, Sandbox, SandboxHandle, SandboxSpec } from "../../src/interfaces/sandbox.js";
import type { SharedStorage } from "../../src/interfaces/shared-storage.js";
import type { PollResult, SourceAdapter, SourceEvent } from "../../src/interfaces/source-adapter.js";
import type { ToolBroker, ToolCallContext, ToolDescriptor, ToolResult } from "../../src/interfaces/tool-broker.js";

export const config: FactoryConfig = {
  repo: { owner: "o", name: "r", path: "/repo", base_branch: "main", test_command: ["npm", "test"] },
  intake_label: "factory",
  status_label_prefix: "sf: ",
  branch_prefix: "factory/",
  dials: { spec_gate_min_tier: 1, auto_merge_max_tier: 0 },
  floors: [{ prefix: "src/impl/broker/", tier: 4 }],
  max_loops: 3,
  max_attempts: 3,
  max_restart: 3,
  retry_base_ms: 60_000,
  retry_max_ms: 1_800_000,
  max_diff_lines: 1500,
  max_diff_files: 40,
  lease_ms: 60_000,
  heartbeat_ms: 10_000,
  tick_ms: 1000,
  poll_interval_ms: 30_000,
  run_timeout_ms: 600_000,
  workers: 1,
  deny_paths: ["/home/u/.config/software-factory"],
  agent_git_identity: { name: "bot", email: "bot@example.com" },
};

export const prompts: Prompts = { triage: "TRIAGE", implement: "IMPLEMENT", review: "REVIEW" };

/** The real pattern scanner with no known secret values: blocks token-shaped text only. */
export const cleanScanner = new PatternEgressScanner(async () => []);

export const silent: Logger = { info() {}, warn() {}, error() {} };

export const alice: ExternalIdentity = { provider: "github", subject: "1", login: "alice" };
export const mallory: ExternalIdentity = { provider: "github", subject: "666", login: "mallory" };

export function issueRef(n: number): SourceRef {
  return { type: "github_issue", id: `o/r#${n}`, link: `https://github.com/o/r/issues/${n}` };
}

/**
 * Keeps the SourceAdapter replay contract like GitHubIssueSource does: the cursor holds a comment-id
 * high-water mark, and a command event at or below it is not delivered again. Records every markSeen call.
 */
export class FakeSource implements SourceAdapter {
  readonly type = "github_issue" as const;
  queue: SourceEvent[] = [];
  /** Posted comments; `url` stands in for the forge's comment URL (`<issue link>#issuecomment-<n>`). */
  comments: { source: SourceRef; body: string; marker: string; url: string }[] = [];
  reactions: { source: SourceRef; comment_id: string | null }[] = [];
  /** When set, markSeen throws this instead of recording. */
  reactionError: Error | null = null;

  async poll(cursor: string | null): Promise<PollResult> {
    const c = cursor ? (JSON.parse(cursor) as { n: number; last_comment_id: number }) : { n: 0, last_comment_id: 0 };
    let last = c.last_comment_id;
    const events: SourceEvent[] = [];
    for (const e of this.queue) {
      if ("comment_id" in e) {
        if (Number(e.comment_id) <= last) continue;
        last = Number(e.comment_id);
      }
      events.push(e);
    }
    this.queue = [];
    return { events, next_cursor: JSON.stringify({ n: c.n + 1, last_comment_id: last }) };
  }
  async postComment(source: SourceRef, body: string, marker: string): Promise<{ url: string }> {
    if (this.commentError) throw this.commentError;
    const existing = this.comments.find((c) => c.marker === marker);
    if (existing) return { url: existing.url };
    const url = `${source.link}#issuecomment-${this.comments.length + 1}`;
    this.comments.push({ source, body, marker, url });
    return { url };
  }
  async markSeen(source: SourceRef, commentId: string | null): Promise<void> {
    if (this.reactionError) throw this.reactionError;
    this.reactions.push({ source, comment_id: commentId });
  }
  /** Every closeIssue call that succeeded, in order. */
  closed: SourceRef[] = [];
  /** When set, closeIssue throws this instead of recording. */
  closeError: Error | null = null;
  /** When set, postComment throws this instead of recording. */
  commentError: Error | null = null;
  async closeIssue(source: SourceRef): Promise<void> {
    if (this.closeError) throw this.closeError;
    this.closed.push(source);
  }
  /** Every setStatus call, in order, including ones that threw. */
  statusCalls: { source: SourceRef; status: WorkStatus; pr_number: number | null }[] = [];
  /** When set, setStatus records the call, then throws this without changing labels. */
  statusError: Error | null = null;
  /**
   * Labels per target (`labelTarget`). Status labels are the WorkStatus names themselves; anything else
   * in a set stands for a label the factory does not own.
   */
  labels = new Map<string, Set<string>>();
  async setStatus(source: SourceRef, status: WorkStatus, pr_number: number | null): Promise<void> {
    this.statusCalls.push({ source, status, pr_number });
    if (this.statusError) throw this.statusError;
    const key = labelTarget(source, pr_number);
    const set = this.labels.get(key) ?? new Set<string>();
    for (const s of WORK_STATUSES) if (s !== status) set.delete(s);
    set.add(status);
    this.labels.set(key, set);
  }
  /** The status labels on a target. */
  statusLabels(source: SourceRef, pr_number: number | null = null): string[] {
    const set = this.labels.get(labelTarget(source, pr_number)) ?? new Set<string>();
    return [...set].filter((l) => (WORK_STATUSES as readonly string[]).includes(l));
  }
}

export function labelTarget(source: SourceRef, pr_number: number | null): string {
  return pr_number === null ? source.id : `${source.id}:pr#${pr_number}`;
}

/** Only subject "1" may approve. */
export class FakeAuth implements AuthProvider {
  async resolve(identity: ExternalIdentity): Promise<Principal> {
    return { user_id: `github:${identity.subject}` as UserId, attributes: {} };
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
  /** Files `git diff --name-only` reports for the branch against base (returned NUL-separated, as with `-z`). */
  changedFiles: string[] = [];
  /**
   * `git diff --numstat -z` output for the branch against base. Null: one line added per `changedFiles` entry.
   */
  numstat: string | null = null;
  /** Every git command line the worker ran, for asserting on order and arguments. */
  gitCalls: string[] = [];

  async create(spec: SandboxSpec): Promise<SandboxHandle> {
    this.created.push(spec);
    return { id: `sbx${this.created.length}`, workdir: `/wt/${this.created.length}` };
  }
  async exec(_h: SandboxHandle, cmd: readonly string[], _o: ExecOptions): Promise<ExecResult> {
    const args = cmd.slice(1).join(" ");
    this.gitCalls.push(args);
    const out = (stdout: string): ExecResult => ({ exit_code: 0, signal: null, stdout, stderr: "", timed_out: false });
    if (args === "rev-parse HEAD") return out("base\n");
    if (args.startsWith("rev-parse --path-format")) return out("/repo/.git\n");
    if (args.startsWith("rev-parse --verify")) return out("basesha\n");
    if (args.startsWith("rev-list")) return out(this.commits.join("\n"));
    if (args.startsWith("log -1")) return out("commit subject\n");
    if (args.startsWith("diff --numstat")) {
      return out(this.numstat ?? this.changedFiles.map((f) => `1\t0\t${f}\0`).join(""));
    }
    if (args.startsWith("diff --name-only")) return out(this.changedFiles.map((f) => `${f}\0`).join(""));
    if (args.startsWith("diff")) return out("+ a change\n");
    return out("");
  }
  async copyIn(): Promise<void> {}
  async copyOut(): Promise<void> {}
  async destroy(): Promise<void> {
    this.destroyed++;
  }
}

/** A script may be async, e.g. to move a FakeClock mid-run and wait for the worker to react. */
type Script = Partial<
  Record<AgentRunSpec["role"], (spec: AgentRunSpec) => Partial<AgentRunResult> | Promise<Partial<AgentRunResult>>>
>;

export class FakeRunner implements AgentRunner {
  specs: AgentRunSpec[] = [];
  constructor(public script: Script) {}

  async run(spec: AgentRunSpec): Promise<AgentRunResult> {
    this.specs.push(spec);
    const fn = this.script[spec.role];
    if (!fn) throw new Error(`no script for ${spec.role}`);
    return {
      status: "completed",
      output: null,
      transcript: "{}",
      usage: { input_tokens: 10, output_tokens: 5, cost_usd: null },
      ...(await fn(spec)),
    };
  }
}

/** Yields to timers and I/O until `cond` holds (e.g. a background heartbeat landed in the store). */
export async function waitFor(cond: () => boolean | Promise<boolean>, what = "condition", tries = 200): Promise<void> {
  for (let i = 0; i < tries; i++) {
    if (await cond()) return;
    await new Promise((r) => setImmediate(r));
  }
  throw new Error(`timed out waiting for ${what}`);
}

/** A Logger that keeps every line, for asserting on warnings. */
export function recordingLog(): Logger & { lines: { level: string; msg: string; fields?: LogFields | undefined }[] } {
  const lines: { level: string; msg: string; fields?: LogFields | undefined }[] = [];
  const at = (level: string) => (msg: string, fields?: LogFields) => void lines.push({ level, msg, fields });
  return { lines, info: at("info"), warn: at("warn"), error: at("error") };
}

export class FakeBroker implements ToolBroker {
  calls: { ctx: ToolCallContext; name: string; args: unknown }[] = [];
  listTools(): ToolDescriptor[] {
    return [];
  }
  async call(ctx: ToolCallContext, name: string, args: unknown): Promise<ToolResult> {
    this.calls.push({ ctx, name, args });
    if (name === "github.open_pr") return { ok: true, content: { number: 42 } };
    return { ok: true, content: {} };
  }
}

/** Read-only PR diffs by number, standing in for GitHubClient.pullDiff. Records every PR asked for. */
export class FakeGitHubDiff {
  calls: number[] = [];
  constructor(private readonly diffs: Record<number, string>) {}
  async pullDiff(pr: number): Promise<string> {
    this.calls.push(pr);
    const d = this.diffs[pr];
    if (d === undefined) throw new Error(`no diff for PR ${pr}`);
    return d;
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

export const triageSpec = {
  problem: "Add a CI scope gate",
  done_criteria: ["CI fails when files outside allowed_paths change"],
  desired_output: "workflow + test",
  scope: "CI only",
  allowed_paths: [".github/workflows/"],
  files_to_change: [".github/workflows/scope.yml"],
  tier: 2,
  tier_reason: "CI config",
};
