// Source adapter fakes (RFC 0023 R4): poll and stream sources. Their registries are in ../harness.ts.
import { WORK_STATUSES, type WorkStatus } from "../../../src/core/status-label.js";
import type { SourceRef, SourceType } from "../../../src/core/types.js";
import type { ExternalIdentity } from "../../../src/interfaces/auth-provider.js";
import type {
  PollResult, PollSource, PushedEvent, SourceCloseReason, SourceEvent, StreamSource, SubIssueInput,
} from "../../../src/interfaces/source-adapter.js";

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

  /** Like GitHub, a `github_issue` source refuses intake silently; any other type replies. */
  readonly silent_intake_refusal?: true;

  constructor(readonly type: SourceType = "github_issue") {
    if (type === "github_issue") this.silent_intake_refusal = true;
  }
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
      // Like GitHub, the source keeps who closed an item and reads it back when it closes the item's PR.
      if (e.kind === "source_closed") this.closers.set(e.source.id, e.closer);
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
  /** The reason of each closeIssue call that succeeded, in the order of `closed`. */
  closeReasons: SourceCloseReason[] = [];
  async closeIssue(source: SourceRef, reason: SourceCloseReason = "not_planned"): Promise<void> {
    if (this.closeError) throw this.closeError;
    this.closed.push(source);
    this.closeReasons.push(reason);
  }
  /**
   * Issues fileSubIssue filed, in order, numbered from 100. Like GitHub, a marker already filed is returned,
   * not filed again; `linked` says whether the sub-issue link was made.
   */
  subIssues: { ref: SourceRef; parent: SourceRef; title: string; body: string; marker: string; linked: boolean }[] = [];
  /** Every fileSubIssue call, failed ones included. */
  subIssueCalls = 0;
  /** When set, the call with this 1-based number files the issue, then throws before linking it. */
  subIssueFailAt: number | null = null;
  /** When set, the marker lookup finds nothing, as a search that has not caught up with a just-filed issue. */
  subIssueLookupMisses = false;
  async fileSubIssue(input: SubIssueInput): Promise<SourceRef> {
    this.subIssueCalls++;
    let issue = this.subIssueLookupMisses ? undefined : this.subIssues.find((i) => i.marker === input.marker);
    if (!issue) {
      const n = 100 + this.subIssues.length;
      const ref = { type: this.type, id: `o/r#${n}`, link: `https://github.com/o/r/issues/${n}` };
      issue = { ref, parent: input.parent, title: input.title, body: input.body, marker: input.marker, linked: false };
      this.subIssues.push(issue);
    }
    if (this.subIssueCalls === this.subIssueFailAt) throw new Error("sub-issue link failed");
    issue.linked = true;
    return issue.ref;
  }
  /** Who closed each source item, by source id, as the last delivered source_closed said. */
  closers = new Map<string, ExternalIdentity | null>();
  /** Every setStatus call, in order, including ones that threw. */
  statusCalls: { source: SourceRef; status: WorkStatus; change_ref: string | null }[] = [];
  /** When set, setStatus records the call, then throws this without changing labels. */
  statusError: Error | null = null;
  /**
   * Labels per target (`labelTarget`). Status labels are the WorkStatus names themselves; anything else
   * in a set stands for a label the factory does not own.
   */
  labels = new Map<string, Set<string>>();
  async setStatus(source: SourceRef, status: WorkStatus, change_ref: string | null): Promise<void> {
    this.statusCalls.push({ source, status, change_ref });
    if (this.statusError) throw this.statusError;
    const key = labelTarget(source, change_ref);
    const set = this.labels.get(key) ?? new Set<string>();
    for (const s of WORK_STATUSES) if (s !== status) set.delete(s);
    set.add(status);
    this.labels.set(key, set);
  }
  /** The status labels on a target. */
  statusLabels(source: SourceRef, change_ref: string | null = null): string[] {
    const set = this.labels.get(labelTarget(source, change_ref)) ?? new Set<string>();
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
  statusCalls: { source: SourceRef; status: WorkStatus; change_ref: string | null }[] = [];
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
  async setStatus(source: SourceRef, status: WorkStatus, change_ref: string | null): Promise<void> {
    this.statusCalls.push({ source, status, change_ref });
  }

  private notify(): void {
    const wake = this.wake;
    this.wake = [];
    for (const w of wake) w();
  }
}

export function labelTarget(source: SourceRef, change_ref: string | null): string {
  return change_ref === null ? source.id : `${source.id}:pr#${change_ref}`;
}
