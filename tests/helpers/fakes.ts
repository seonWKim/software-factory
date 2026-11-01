import type { FactoryConfig, Prompts } from "../../src/core/config.js";
import type { LogFields, Logger } from "../../src/core/log.js";
import { WORK_STATUSES, type WorkStatus } from "../../src/core/status-label.js";
import type { SourceRef, SourceType, UserId } from "../../src/core/types.js";
import type { AgentRunResult, AgentRunSpec, AgentRunner } from "../../src/interfaces/agent-runner.js";
import { PatternEgressScanner } from "../../src/impl/egress/pattern-egress-scanner.js";
import type { AuthDecision, AuthProvider, ExternalIdentity, Principal } from "../../src/interfaces/auth-provider.js";
import type { ExecOptions, ExecResult, Sandbox, SandboxHandle, SandboxSpec } from "../../src/interfaces/sandbox.js";
import type { SharedStorage } from "../../src/interfaces/shared-storage.js";
import type { PollResult, PollSource, PushedEvent, SourceEvent, StreamSource } from "../../src/interfaces/source-adapter.js";
import { REGISTRY, type Registry, withPlugin } from "../../src/plugins.js";
import type { ToolBroker, ToolCallContext, ToolDescriptor, ToolResult } from "../../src/interfaces/tool-broker.js";

export const config: FactoryConfig = {
  repo: { owner: "o", name: "r", path: "/repo", base_branch: "main", install_command: ["npm", "ci"], test_command: ["npm", "test"] },
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
  inbox_retention_days: 14,
  workers: 1,
  deny_paths: ["/home/u/.config/software-factory"],
  agent_git_identity: { name: "bot", email: "bot@example.com" },
};

export const prompts: Prompts = { triage: "TRIAGE", implement: "IMPLEMENT", review: "REVIEW", resolve: "RESOLVE" };

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
export class FakeSource implements PollSource {
  readonly intake = "poll" as const;
  queue: SourceEvent[] = [];
  /** Every poll call, failed ones included, with the cursor it was given. */
  polls: (string | null)[] = [];
  /** When set, poll throws this instead of returning events. */
  pollError: Error | null = null;

  constructor(readonly type: SourceType = "github_issue") {}
  /** Posted comments; `url` stands in for the forge's comment URL (`<issue link>#issuecomment-<n>`). */
  comments: { source: SourceRef; body: string; marker: string; url: string }[] = [];
  reactions: { source: SourceRef; comment_id: string | null }[] = [];
  /** When set, markSeen throws this instead of recording. */
  reactionError: Error | null = null;

  async poll(cursor: string | null): Promise<PollResult> {
    this.polls.push(cursor);
    if (this.pollError) throw this.pollError;
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

/**
 * A second poll source, of type `slack_thread`: FakeSource's replay contract and records, under another
 * source type. Test-only plugin name `fake-slack-poll` (docs/plugins.md), through `fakeSlackPollRegistry()`.
 */
export class FakeSlackPollSource extends FakeSource {
  constructor() {
    super("slack_thread");
  }
}

/** REGISTRY plus the test-only `fake-slack-poll` source. */
export function fakeSlackPollRegistry(base: Registry = REGISTRY, make: () => FakeSlackPollSource = () => new FakeSlackPollSource()): Registry {
  return withPlugin(base, "source", "fake-slack-poll", make);
}

export function slackRef(n: number): SourceRef {
  return { type: "slack_thread", id: `C1/${n}`, link: `https://slack.example/archives/C1/p${n}` };
}

/**
 * Test-only stream source, plugin name `fake-stream` (docs/plugins.md). Behaves like Slack Socket Mode as
 * the listener sees it: every connection delivers each pushed event that is not acked yet, so an event
 * delivered on a connection that died before its ack comes back on the next one. Never in REGISTRY; tests
 * get it through `fakeStreamRegistry()`.
 */
export class FakeStreamSource implements StreamSource {
  readonly type = "slack_thread" as const;
  readonly intake = "stream" as const;
  /** Pushed and not acked yet, oldest first. Two pushes with one key are two deliveries (a redelivery). */
  pending: { event: SourceEvent; dedupe_key: string }[] = [];
  /** Dedupe keys in ack order. */
  acks: string[] = [];
  /** subscribe() calls, failed ones included. */
  subscribes = 0;
  /** Connections open right now. */
  open = 0;
  /** When set, every subscribe fails at once with this error until it is cleared. */
  connectError: Error | null = null;
  /** Runs inside ack(), before the ack is recorded: lets a test look at the store at that moment. */
  onAck: ((dedupe_key: string) => void | Promise<void>) | null = null;
  comments: { source: SourceRef; body: string; marker: string }[] = [];
  /** Every closeIssue call, in order. */
  closed: SourceRef[] = [];
  async closeIssue(source: SourceRef): Promise<void> {
    this.closed.push(source);
  }
  reactions: { source: SourceRef; comment_id: string | null }[] = [];
  statusCalls: { source: SourceRef; status: WorkStatus; pr_number: number | null }[] = [];
  private wake: (() => void)[] = [];
  private connection: { ended: boolean; error: Error | null } | null = null;

  push(event: SourceEvent, dedupe_key: string): void {
    this.pending.push({ event, dedupe_key });
    this.notify();
  }

  /** Ends the open connection: it completes, or fails with `error`. */
  disconnect(error: Error | null = null): void {
    if (this.connection) Object.assign(this.connection, { ended: true, error });
    this.notify();
  }

  async *subscribe(signal: AbortSignal): AsyncGenerator<PushedEvent> {
    this.subscribes++;
    if (this.connectError) throw this.connectError;
    const conn = { ended: false, error: null as Error | null };
    this.connection = conn;
    this.open++;
    const sent = new Set<object>();
    try {
      while (!signal.aborted && !conn.ended) {
        const d = this.pending.find((p) => !sent.has(p));
        if (!d) {
          await new Promise<void>((resolve) => {
            const done = () => {
              signal.removeEventListener("abort", done);
              resolve();
            };
            this.wake.push(done);
            signal.addEventListener("abort", done, { once: true });
          });
          continue;
        }
        sent.add(d);
        yield {
          event: d.event,
          dedupe_key: d.dedupe_key,
          ack: async () => {
            await this.onAck?.(d.dedupe_key);
            this.acks.push(d.dedupe_key);
            this.pending = this.pending.filter((p) => p !== d);
          },
        };
      }
      if (conn.error) throw conn.error;
    } finally {
      this.open--;
      if (this.connection === conn) this.connection = null;
    }
  }

  async postComment(source: SourceRef, body: string, marker: string): Promise<{ url: string | null }> {
    if (!this.comments.some((c) => c.marker === marker)) this.comments.push({ source, body, marker });
    return { url: null };
  }
  async markSeen(source: SourceRef, commentId: string | null): Promise<void> {
    this.reactions.push({ source, comment_id: commentId });
  }
  async setStatus(source: SourceRef, status: WorkStatus, pr_number: number | null): Promise<void> {
    this.statusCalls.push({ source, status, pr_number });
  }

  private notify(): void {
    const wake = this.wake;
    this.wake = [];
    for (const w of wake) w();
  }
}

/** REGISTRY plus the test-only `fake-stream` source. The only place fake-stream is wired. */
export function fakeStreamRegistry(base: Registry = REGISTRY, make: () => FakeStreamSource = () => new FakeStreamSource()): Registry {
  return withPlugin(base, "source", "fake-stream", make);
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
  /** What `git rev-parse HEAD` prints. A resolve run's checkout makes it its commit-tree result. */
  head = "base\n";
  private trees = 0;

  async updateBase(): Promise<string> {
    return "basesha";
  }
  async create(spec: SandboxSpec): Promise<SandboxHandle> {
    this.created.push(spec);
    return { id: `sbx${this.created.length}`, workdir: `/wt/${this.created.length}` };
  }
  async exec(_h: SandboxHandle, cmd: readonly string[], _o: ExecOptions): Promise<ExecResult> {
    const res = (exit_code: number, stdout = ""): ExecResult => ({ exit_code, signal: null, stdout, stderr: "", timed_out: false });
    const out = (stdout: string): ExecResult => res(0, stdout);
    if (cmd[0] !== "git") {
      const line = cmd.join(" ");
      this.commands.push(line);
      if (cmd[0] === "cat") return out(this.files[cmd.at(-1)!] ?? "");
      return res(this.exits[line] ?? 0);
    }
    const args = cmd.slice(1).join(" ");
    this.gitCalls.push(args);
    if (args === "rev-parse HEAD") return out(this.head);
    if (args.startsWith("rev-parse --path-format=absolute --git-path")) return out("/repo/.git/worktrees/x/sf-resolve-index\n");
    if (args.startsWith("rev-parse --path-format")) return out("/repo/.git\n");
    if (args.startsWith("rev-parse --verify")) return out("basesha\n");
    if (args.startsWith("rev-list")) return out(this.commits.join("\n"));
    if (args.startsWith("log -1")) return out("commit subject\n");
    if (args.startsWith("merge-base --is-ancestor")) return res(this.ancestorExit);
    if (args.startsWith("merge ")) return res(this.mergeExit);
    if (args === "write-tree") return out(`tree${++this.trees}\n`);
    if (args.startsWith("grep")) return this.markers ? out(this.markers) : res(1);
    if (args.startsWith("commit-tree")) return out("resolvedsha\n");
    if (/(^| )checkout /.test(args)) this.head = `${cmd.at(-1)}\n`;
    if (args.startsWith("diff --cached --quiet")) return res(1);
    if (args.startsWith("diff --numstat")) {
      return out(this.numstat ?? this.changedFiles.map((f) => `1\t0\t${f}\0`).join(""));
    }
    if (args.startsWith("diff --name-only -z --diff-filter=U")) return out(this.conflicts.map((f) => `${f}\0`).join(""));
    if (args.startsWith("diff --name-only -z --no-renames tree")) return out(this.resolveChanged.map((f) => `${f}\0`).join(""));
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
