import { type ChatCommand, parseChatCommand } from "../../core/command-table.js";
import { commandPhase, phaseLabel } from "../../core/commands.js";
import type { Logger } from "../../core/log.js";
import { noticeKind, waitReason } from "../../core/notifications.js";
import type { SourceRef, WorkItem, WorkItemId } from "../../core/types.js";
import type { EgressScanner } from "../../interfaces/egress-scanner.js";
import type { FactoryStore } from "../../interfaces/factory-store.js";
import type { RepoRef } from "../github/github-client.js";
import { SlackApiError, type SlackApi } from "./slack-api.js";
import { type ChatAnswer, type ChatStore, UNLINKED, runChatCommand } from "./slack-commands.js";
import { parseSlackSourceId } from "./slack-source.js";
import {
  ACTION_SPEC_APPROVE, ACTION_SPEC_OTHER, ACTION_SPEC_REJECT, ACTION_VIEW, MAX_SECTIONS, SECTION_MAX, type SlackRendered, button, buttonApplies,
  chunks, cutNote, escapeSlack, modal, modalCommand, section, specModal, toMrkdwn, waitingSpec, withheldNotice, withoutFooter,
} from "./slack-format.js";

// Slack modals (design 05-sources): the spec decision modals (Other… and Reject…) and the read-only item modal a
// View press opens, so the owner reads and decides on an item inside Slack, with no dashboard link (a phone cannot
// open the local dashboard). Each press reads the store; the only Slack call is views.open (views.push inside the
// item modal), after the egress scan. Every press goes through the same checks and the same command rows as the
// thread's buttons; slack-source.ts only routes the envelopes here.

/** The item modal's callback ID; its private_metadata is the item ID. */
export const VIEW_ITEM = "sf_item";
/** Merge, in the item modal of a ready-to-merge item only (not a thread footer button); its value is the item ID. */
export const ACTION_MERGE = "sf_merge";
/** The title every item modal shows (Slack takes at most 24 characters). */
const ITEM_TITLE = "Work item";

const str = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);
const obj = (v: unknown): Record<string, unknown> => (typeof v === "object" && v !== null ? (v as Record<string, unknown>) : {});

/** What the modals need of the `slack` source: its deps, and its thread replies for an item from a Slack thread. */
export interface ModalHost {
  readonly d: {
    api: SlackApi;
    channels: readonly string[];
    notify_channel?: string;
    scanner: EgressScanner;
    store: ChatStore & Pick<FactoryStore, "getWorkItemBySource">;
    repo: RepoRef;
    log: Logger;
  };
  /** Runs `cmd` as the presser and posts its answer, if any, in the item's thread. */
  chat(cmd: ChatCommand, source: SourceRef, user: string, id: string, item: WorkItem | null): Promise<null>;
  /** Posts `answer` in the thread under a marker keyed on `id`. */
  reply(source: SourceRef, answer: ChatAnswer, id: string): Promise<null>;
  /** The reply to a press of a button that no longer applies. */
  stale(source: SourceRef, item: WorkItem, id: string): Promise<null>;
  /** Posts one message in the thread under `marker`, once. */
  post(source: SourceRef, render: (bot: string) => SlackRendered, marker: string): Promise<{ url: string | null }>;
}

/**
 * One press on an item. `id`: the press's key (`<team>-<user>-<action_ts>`, or `view-<view id>` for a submit);
 * `root`: the open item modal's view ID when the press came from inside it, else null (a press on a message).
 */
interface Press {
  user: string;
  id: string;
  item: WorkItem;
  trigger: string | null;
  root: string | null;
}

/** Whether `item` came from a Slack thread: its answers go there; any other item's go to the open modal (owner answer 2). */
const inSlack = (item: WorkItem) => item.source.type === "slack_thread";

/** The factory's own thread entries of `item` (no person's reply), oldest first. */
async function factoryBodies(store: ModalHost["d"]["store"], item: WorkItem): Promise<string[]> {
  return (await store.listItemMessages(item.id)).flatMap((m) => (m.actor ? [] : [m.body]));
}

/** The one line a modal press's result shows when its command was stored: the controller answers in the item's thread. */
function storedLine(cmd: ChatCommand): string {
  const name = cmd.kind === "command" ? cmd.entry.name : "help";
  const did: Record<string, string> = { approve: "Approved", reject: "Rejected", merge: "Merge requested" };
  return `${did[name] ?? "Sent"}. The factory answers in the item's own thread.`;
}

/** An answer as one line: its first non-blank line. */
function oneLine(a: NonNullable<ChatAnswer>): string {
  const lines = "markdown" in a ? a.markdown.split("\n") : a.lines;
  return lines.find((l) => l.trim() !== "")?.trim() ?? "";
}

/**
 * The read-only item modal: the item's title, its state, the one-line reason it needs the owner, and the waiting spec
 * (or else the latest factory message) as mrkdwn, its command footer dropped, in sections of at most SECTION_MAX
 * characters; past MAX_SECTIONS the body is cut and ends with the note naming `factory task show <id>`. So it stays
 * under Slack's 100 blocks. Buttons that apply now: Approve, Other… (with a decision) and Reject… for a waiting spec;
 * Merge for a ready-to-merge item; none otherwise.
 */
export function itemModal(item: WorkItem, bodies: readonly string[], repo: RepoRef): Record<string, unknown> {
  const phase = commandPhase(item);
  const waits = item.blocked_on === "human" || item.blocked_on === "budget";
  const reason = waits ? waitReason(noticeKind(item.blocked_reason)) : "nothing: it does not wait on you";
  const head = `*${escapeSlack(item.title ?? item.id)}*\nState: ${escapeSlack(phaseLabel(phase))}\nNeeds you for: ${escapeSlack(reason)}`;
  const specBody = phase === "spec_pending" ? bodies.filter((b) => waitingSpec(b) !== null).at(-1) : undefined;
  const body = specBody ?? bodies.at(-1);
  let parts = body === undefined ? ["_No factory message yet._"] : chunks(toMrkdwn(withoutFooter(body), repo));
  if (parts.length > MAX_SECTIONS) parts = [...parts.slice(0, MAX_SECTIONS), cutNote(`factory task show ${item.id}`)];
  const spec = specBody === undefined ? null : waitingSpec(specBody);
  const buttons = phase === "spec_pending"
    ? [
      button("Approve", ACTION_SPEC_APPROVE, item.id, "primary"),
      ...(spec && spec.decisions.length > 0 ? [button("Other…", ACTION_SPEC_OTHER, item.id)] : []),
      button("Reject…", ACTION_SPEC_REJECT, item.id),
    ]
    : phase === "merge_pending" ? [button("Merge", ACTION_MERGE, item.id, "primary")] : [];
  const blocks = [section(head.slice(0, SECTION_MAX)), ...parts.map((t) => section(t)), ...(buttons.length > 0 ? [{ type: "actions", elements: buttons }] : [])];
  return modal(VIEW_ITEM, ITEM_TITLE, null, item.id, blocks);
}

/** The item modal after a press on an item not from a Slack thread: one line, the press's result (owner answer 2). */
export function resultModal(item_id: string, line: string): Record<string, unknown> {
  return modal(VIEW_ITEM, ITEM_TITLE, null, item_id, [section(escapeSlack(line).slice(0, SECTION_MAX))]);
}

export class SlackModals {
  constructor(private readonly h: ModalHost) {}

  /**
   * A View press, on a spec message in a listed channel or on a notice line in the notices channel (owner answer 1),
   * by a linked Slack account: the item modal for the item its value names, opened with views.open once it passes the
   * egress scan (a withheld one shows the withheld notice). Store reads only; an unlinked presser gets no modal.
   */
  async view(p: Record<string, unknown>, me: { user_id: string }): Promise<null> {
    const user = str(obj(p.user).id);
    const channel = str(obj(p.channel).id) ?? str(obj(p.container).channel_id);
    const value = str(obj(Array.isArray(p.actions) ? p.actions[0] : undefined).value);
    const trigger = str(p.trigger_id);
    const { channels, notify_channel, store } = this.h.d;
    if (user === null || user === me.user_id || channel === null || value === null || trigger === null) return null;
    if (!channels.includes(channel) && channel !== (notify_channel ?? channels[0])) return null;
    if ((await store.resolveLink("slack", user)) === null) return null;
    const item = await store.getWorkItem(value as WorkItemId);
    if (!item) return null;
    return this.show({ user, id: "", item, trigger, root: null }, itemModal(item, await factoryBodies(store, item), this.h.d.repo), "modal");
  }

  /** A spec message's Approve, Other… or Reject… press in the item's Slack thread `source`. */
  async specPress(action: string, source: SourceRef, user: string, id: string, trigger: string | null): Promise<null> {
    const item = await this.h.d.store.getWorkItemBySource("slack_thread", source.id);
    return item ? this.act(action, { user, id, item, trigger, root: null }) : null;
  }

  /** A press inside the item modal (`view.callback_id` VIEW_ITEM): the item is the modal's private_metadata. */
  async modalPress(p: Record<string, unknown>, me: { team_id: string; user_id: string }): Promise<null> {
    const view = obj(p.view);
    const user = str(obj(p.user).id);
    const team = str(obj(p.team).id) ?? me.team_id;
    const action = obj(Array.isArray(p.actions) ? p.actions[0] : undefined);
    const [action_id, action_ts, meta] = [str(action.action_id), str(action.action_ts), str(view.private_metadata)];
    if (view.callback_id !== VIEW_ITEM || user === null || user === me.user_id || action_id === null || action_ts === null || meta === null) return null;
    if (![ACTION_SPEC_APPROVE, ACTION_SPEC_OTHER, ACTION_SPEC_REJECT, ACTION_MERGE].includes(action_id)) return null;
    const item = await this.h.d.store.getWorkItem(meta as WorkItemId);
    const root = str(view.root_view_id) ?? str(view.id);
    return item ? this.act(action_id, { user, id: `${team}-${user}-${action_ts}`, item, trigger: str(p.trigger_id), root }) : null;
  }

  /**
   * A spec modal's submit: the typed command it stands for (`modalCommand`), by the press rules, keyed on the view ID.
   * Its private_metadata is the item's Slack thread source ID (a listed channel's), or the item ID for an item from
   * elsewhere, whose result goes to the item modal under it.
   */
  async submission(p: Record<string, unknown>, me: { user_id: string }): Promise<null> {
    const view = obj(p.view);
    const [view_id, user, meta] = [str(view.id), str(obj(p.user).id), str(view.private_metadata) ?? ""];
    const cmd = parseChatCommand(modalCommand(str(view.callback_id) ?? "", obj(obj(view.state).values)) ?? "");
    if (view_id === null || user === null || cmd === null || user === me.user_id) return null;
    const { store, channels } = this.h.d;
    const thread = parseSlackSourceId(meta);
    const item = thread ? (channels.includes(thread.channel) ? await store.getWorkItemBySource("slack_thread", meta) : null) : await store.getWorkItem(meta as WorkItemId);
    if (!item) return null;
    const press: Press = { user, id: `view-${view_id}`, item, trigger: null, root: str(view.root_view_id) };
    return (await this.refused(press, buttonApplies("approve", item))) ? null : this.run(cmd, press);
  }

  /** Approve and Merge store their command; Other… and Reject… open their modal (views.push inside the item modal). */
  private async act(action: string, p: Press): Promise<null> {
    const merge = action === ACTION_MERGE;
    if (await this.refused(p, merge ? commandPhase(p.item) === "merge_pending" : buttonApplies("approve", p.item))) return null;
    if (merge || action === ACTION_SPEC_APPROVE) return this.run(parseChatCommand(merge ? "merge" : "/approve")!, p);
    const meta = inSlack(p.item) ? p.item.source.id : p.item.id;
    return this.show(p, specModal(action, await factoryBodies(this.h.d.store, p.item), meta), p.root === null ? "thread" : "modal");
  }

  /** True once it answered: an unlinked presser gets the refusal, a press that no longer applies the stale reply. */
  private async refused(p: Press, applies: boolean): Promise<boolean> {
    if ((await this.h.d.store.resolveLink("slack", p.user)) === null) return (await this.answer(p, UNLINKED), true);
    if (applies) return false;
    const stale = `That button is from an earlier step, so it did nothing now. The item is now ${phaseLabel(commandPhase(p.item))}.`;
    return (await (inSlack(p.item) ? this.h.stale(p.item.source, p.item, p.id) : this.result(p, stale)), true);
  }

  /**
   * Runs `cmd` as the linked presser through the thread buttons' path. An item from a Slack thread gets the answer in
   * its thread; any other item's command runs with no Slack post (the controller answers in the item's own thread)
   * and the open modal shows its one-line result (owner answer 2).
   */
  private async run(cmd: ChatCommand, p: Press): Promise<null> {
    if (inSlack(p.item)) return this.h.chat(cmd, p.item.source, p.user, p.id, p.item);
    const answer = await runChatCommand({ store: this.h.d.store }, cmd, { user: p.user, item: p.item, id: `slack-${p.id}`, origin: "slack_thread" });
    return this.result(p, answer === null ? storedLine(cmd) : oneLine(answer));
  }

  /** `text` to the presser: in the item's Slack thread, else as the open modal's one line. */
  private answer(p: Press, text: string): Promise<null> {
    return inSlack(p.item) ? this.h.reply(p.item.source, { markdown: text }, p.id) : this.result(p, text);
  }

  /** The open item modal replaced by one line (views.update), once it passes the egress scan; no modal open: nothing. */
  private async result(p: Press, line: string): Promise<null> {
    if (p.root === null) return null;
    const { view } = await this.scanned(resultModal(p.item.id, line), p.item.id);
    const root = p.root;
    return this.call("views.update", p.item.id, () => this.h.d.api.updateView(root, view));
  }

  /**
   * Opens `view` by the press's trigger once it passes the egress scan: views.push inside the item modal, else
   * views.open. A withheld view opens the withheld notice instead, except that a spec modal pressed on a thread message
   * (`withheld` "thread") leaves the notice in the thread, as before, and opens nothing. A failed call is logged once,
   * not retried.
   */
  private async show(p: Press, view: Record<string, unknown>, withheld: "modal" | "thread"): Promise<null> {
    const trigger = p.trigger;
    if (trigger === null) return null;
    const scan = await this.scanned(view, p.item.id);
    if (scan.withheld && withheld === "thread") return this.h.post(p.item.source, () => scan.withheld!, `<!-- factory:modal:${p.id} -->`).then(() => null);
    const api = this.h.d.api;
    if (p.root !== null) return this.call("views.push", p.item.id, () => api.pushView(trigger, scan.view));
    return this.call("views.open", p.item.id, () => api.openView(trigger, scan.view));
  }

  /** G5 on the whole view: a finding replaces its blocks with the withheld notice, which names the rules only. */
  private async scanned(view: Record<string, unknown>, item_id: string): Promise<{ view: Record<string, unknown>; withheld: SlackRendered | null }> {
    const scan = await this.h.d.scanner.scan("comment", `\n${JSON.stringify([view])}`);
    if (scan.clean) return { view, withheld: null };
    const rules = [...new Set(scan.findings.map((f) => f.rule))].join(",");
    this.h.d.log.warn("slack modal blocked by the egress scan; withheld", { work_item_id: item_id, rules });
    const notice = withheldNotice(rules);
    return { view: { ...view, blocks: notice.blocks }, withheld: notice };
  }

  private call(method: string, item_id: string, f: () => Promise<void>): Promise<null> {
    const failed = (e: unknown) => this.h.d.log.warn(`slack ${method} failed; no modal opened`, { work_item_id: item_id, code: e instanceof SlackApiError ? e.code : "unknown_error" });
    return f().then(() => null, (e: unknown) => (failed(e), null));
  }
}

/** Whether a block_actions payload is for the modals: a View press, or a press inside the item modal. */
export function isModalPress(p: Record<string, unknown>): boolean {
  const action_id = str(obj(Array.isArray(p.actions) ? p.actions[0] : undefined).action_id);
  return action_id === ACTION_VIEW || obj(p.view).callback_id === VIEW_ITEM;
}
