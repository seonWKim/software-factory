import type { SourceRef, UserId, WorkItem } from "../../core/types.js";
import { utcMinute } from "../../core/spec-comment.js";
import { type VerdictButton, VERDICT_BUTTON_LABELS, buttonVerdict, buttonVerdictKey, verdictButtonOf, verdictRefusal } from "../../core/verdict.js";
import type { AuthProvider } from "../../interfaces/auth-provider.js";
import type { EgressScanner } from "../../interfaces/egress-scanner.js";
import type { FactoryStore } from "../../interfaces/factory-store.js";
import type { Logger } from "../../core/log.js";
import { SlackApiError, type SlackApi } from "./slack-api.js";
import {
  FEEDBACK_CALLBACK, FEEDBACK_INPUT, buttonApplies, escapeSlack, feedbackModal, footerCommands, obj, renderComment, resultMarker, str, type SlackRendered, type VerdictShown,
} from "./slack-format.js";

// One-tap verdicts in Slack (design 04-gate-commands, "One-tap verdicts"): a Good, Bad or Feedback press on a factory
// result message, and the Feedback modal's submit, handled inside the Slack source (slack-source.ts) as chat commands
// are: the record_verdict check through the presser's linked user, one verdict per message stored with recordVerdict
// (`replace`), then one edit of the message to show it. Nothing goes to the inbox.

/** The record of the chat.update that showed message `ts`'s verdict as of its state change: one update each. */
const verdictMarker = (ts: string, state_change_id: string) => `slack:verdict:${ts}:${state_change_id}`;
/** Version conflicts a one-tap verdict retries before it gives up (another write to the item won each time). */
const VERDICT_TRIES = 5;

/** A factory result message (resultMarker) with its thread, item, thread entry and its one-tap verdict's key. */
interface ResultMessage {
  source: SourceRef;
  item: WorkItem;
  ts: string;
  entry: { marker: string; body: string };
  key: string;
}

export interface SlackVerdictDeps {
  api: Pick<SlackApi, "openView">;
  channels: readonly string[];
  scanner: EgressScanner;
  store: Pick<FactoryStore, "listPostedCommentsById" | "getWorkItemBySource" | "listItemMessages" | "getWorkItem" | "recordVerdict" | "listVerdicts" | "listStateChanges" | "getPostedComment">;
  auth: Pick<AuthProvider, "resolve" | "authorize">;
  /** Where PR links point, as renderComment takes it. */
  repo: Parameters<typeof renderComment>[1];
  log: Logger;
}

/** What the Slack source does for these: its posting, message edits, Done line, bot ID and thread sources. */
export interface SlackVerdictHost {
  /** Posts one plain notice in the thread under `marker`, once. */
  post(source: SourceRef, text: string, marker: string): Promise<unknown>;
  /** One scanned chat.update of message `ts`, recorded under `marker` (`of`: the message's own marker, for the log). */
  update(source: SourceRef, ts: string, msg: SlackRendered, marker: string, of: string): Promise<void>;
  done(item: WorkItem): Promise<string>;
  bot(): Promise<string>;
  /** The thread source of a stored source ID when it is a Slack thread in `channel`, else null. */
  thread(source_id: string, channel: string): SourceRef | null;
}

/** Good, Bad and Feedback presses and the Feedback modal's submit. */
export class SlackVerdicts {
  constructor(private readonly d: SlackVerdictDeps, private readonly host: SlackVerdictHost) {}

  /**
   * A Good, Bad or Feedback press on a result message (design 04-gate-commands, one-tap verdicts). The message is
   * found by its ts in the store's posted records (a result marker in this channel, in a work item's thread); a press
   * by an account whose linked user lacks `record_verdict` (or none) stores nothing and gets no reply. Good and Bad
   * store the message's one verdict, then edit the message to show it; Feedback opens the modal (views.open) and
   * stores nothing until its submit. Nothing goes to the inbox; the envelope is acked after the store write.
   */
  async tap(tap: VerdictButton, channel: string, ts: string | null, user: string, trigger_id: string | null): Promise<null> {
    const msg = ts === null ? null : await this.resultMessage(channel, ts);
    const who = msg && (await this.verdictUser(user, msg.item));
    if (!msg || !who) return null;
    if (tap !== "feedback") return this.storeVerdict(msg, who, tap);
    if (trigger_id === null) return null;
    try {
      await this.d.api.openView(trigger_id, feedbackModal({ channel, ts: msg.ts }));
    } catch (err) {
      // A redelivered press's trigger has expired (3 seconds): the person presses again.
      if (!(err instanceof SlackApiError)) throw err;
      this.d.log.warn("slack feedback modal not opened", { work_item_id: msg.item.id, code: err.code });
    }
    return null;
  }

  /**
   * The Feedback modal's submit: the same checks as the press (the message is read again from the store, never from
   * the modal's metadata alone), then G5 on the text. A finding stores nothing and posts one notice in the thread
   * (keyed on the modal's view ID), without the text. Else the text is the reason of the message's one verdict, as
   * `changes`/`none`. Returns null: the ack (which closes the modal) is sent after the store write.
   */
  async submit(p: Record<string, unknown>, me: { user_id: string }): Promise<null> {
    const view = obj(p.view);
    if (view.callback_id !== FEEDBACK_CALLBACK) return null;
    const user = str(obj(p.user).id);
    const view_id = str(view.id);
    let meta: Record<string, unknown> = {};
    try {
      meta = obj(JSON.parse(str(view.private_metadata) ?? "{}"));
    } catch {
      return null;
    }
    const channel = str(meta.channel);
    const ts = str(meta.ts);
    const text = str(obj(obj(obj(obj(view.state).values)[FEEDBACK_INPUT])[FEEDBACK_INPUT]).value)?.trim() ?? "";
    if (user === null || view_id === null || channel === null || ts === null || text === "") return null;
    if (!this.d.channels.includes(channel) || user === me.user_id) return null;
    const msg = await this.resultMessage(channel, ts);
    const who = msg && (await this.verdictUser(user, msg.item));
    if (!msg || !who) return null;
    const scan = await this.d.scanner.scan("comment", text);
    if (!scan.clean) {
      const rules = [...new Set(scan.findings.map((f) => f.rule))].join(",");
      this.d.log.warn("slack feedback blocked by the egress scan; not stored", { work_item_id: msg.item.id, rules });
      const notice = `Your feedback was not stored: the leak scanner found something in it (${escapeSlack(rules)}). Send it again without that.`;
      await this.host.post(msg.source, notice, `<!-- factory:feedback-withheld:${view_id} -->`);
      return null;
    }
    return this.storeVerdict(msg, who, "feedback", text);
  }

  /** The result message `ts` in `channel`: its posted record with a result marker, in a work item's thread; else null. */
  private async resultMessage(channel: string, ts: string): Promise<ResultMessage | null> {
    for (const r of await this.d.store.listPostedCommentsById(ts)) {
      const result = resultMarker(r.marker);
      const source = result && this.host.thread(r.source_id, channel);
      if (!result || !source) continue;
      const item = await this.d.store.getWorkItemBySource("slack_thread", source.id);
      const entry = item && (await this.d.store.listItemMessages(item.id)).find((m) => m.marker === r.marker);
      if (!item || !entry) return null;
      return { source, item, ts, entry, key: buttonVerdictKey(channel, ts, result.run) };
    }
    return null;
  }

  /** The linked factory user of Slack account `user` when it may record a verdict on `item`, else null (logged only). */
  private async verdictUser(user: string, item: WorkItem): Promise<UserId | null> {
    const principal = await this.d.auth.resolve({ provider: "slack", subject: user });
    const decision = principal && (await this.d.auth.authorize(principal, "record_verdict", { kind: "work_item", id: item.id }));
    if (principal && decision?.allow) return principal.user_id;
    this.d.log.info("slack verdict button ignored", { work_item_id: item.id, reason: decision && !decision.allow ? decision.reason : "not_linked" });
    return null;
  }

  /**
   * Stores the message's one verdict under its key, as `user` (recordVerdict with `replace`: a second tap updates the
   * row, the same tap again changes nothing), retrying on version conflicts; then edits the message to show it. An
   * item closed without a merge takes none (verdictRefusal). A failed write throws: the envelope stays unacked.
   */
  private async storeVerdict(msg: ResultMessage, user: UserId, tap: VerdictButton, text?: string): Promise<null> {
    const v = buttonVerdict(tap, text);
    for (let i = 0; i < VERDICT_TRIES; i++) {
      const it = await this.d.store.getWorkItem(msg.item.id);
      if (!it) return null;
      const closed = verdictRefusal(it);
      if (closed !== null) {
        this.d.log.info("slack verdict button not stored", { work_item_id: it.id, reason: closed });
        return null;
      }
      const r = await this.d.store.recordVerdict({
        id: it.id, expected_version: it.version, actor: { kind: "user", id: user }, ...v, comment_id: msg.key, target: "issue",
        implicit: false, pr_head: it.change_ref === null ? null : it.last_head_sha, replace: true,
      });
      if (r.ok || r.reason === "duplicate") {
        await this.showVerdict({ ...msg, item: r.ok ? r.item : it });
        return null;
      }
      if (r.reason !== "version_conflict") return null;
    }
    this.d.log.warn("slack verdict button gave up after conflicts", { work_item_id: msg.item.id });
    return null;
  }

  /**
   * Edits a result message to show its stored verdict, keeping what a state change left of it (`settle`). Recorded
   * under the message and the verdict's state change, so the same verdict shown again makes no Slack call.
   */
  private async showVerdict(msg: ResultMessage): Promise<void> {
    const v = (await this.d.store.listVerdicts(msg.item.id)).find((x) => x.comment_id === msg.key);
    if (!v) return;
    const marker = verdictMarker(msg.ts, v.state_change_id);
    if ((await this.d.store.getPostedComment(msg.source.id, marker, ""))?.comment_id) return;
    const had = footerCommands(msg.entry.body);
    const keep = had.filter((c) => buttonApplies(c, msg.item));
    const done = keep.length < had.length ? { line: await this.host.done(msg.item), keep } : undefined;
    const rendered = renderComment(msg.entry.body, this.d.repo, await this.host.bot(), done, await this.shown(msg.item, msg.key));
    await this.host.update(msg.source, msg.ts, rendered, marker, msg.entry.marker);
  }

  /** A result message's verdict as it shows: the stored verdict under `key` (its button, actor ID and time), or none. */
  async shown(item: WorkItem, key: string): Promise<VerdictShown> {
    const v = (await this.d.store.listVerdicts(item.id)).find((x) => x.comment_id === key);
    if (!v) return { chosen: null };
    const actor = (await this.d.store.listStateChanges(item.id)).find((c) => c.id === v.state_change_id)?.actor.id ?? "unknown";
    const b = verdictButtonOf(v);
    return { chosen: b, line: `Verdict: ${b ? VERDICT_BUTTON_LABELS[b] : v.verdict} by ${actor} at ${utcMinute(v.at)}.` };
  }
}
