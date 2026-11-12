// An item's thread as the item API returns it (design §9, issue #286): the store's entries (listItemMessages, the
// item_thread table) oldest first, each body through the Withholder. A thread entry stores only its marker, body
// and time, so what the API says about its author comes from the marker: the factory's own entries (marker
// `<!-- factory:<kind>:… -->`) have author `factory`, every other entry `unknown`. The item's verdicts are in the
// thread too (kind `verdict`, design §9): the verdict's kind and severity, its actor ID (from its state change) as
// author, and its reason (a Feedback text) as the body. The channel is the item's source type. Store reads only, no
// forge or source call. Owner entries (`role` owner): the item's CLI and dashboard commands (listItemCommands) with
// their text, the command's name as kind, its stored actor ID as author and its origin (`cli`, `app`) as channel;
// the item's non-factory thread entries (a GitHub or Slack message, already stored once) and its verdicts are the
// owner's too. The factory's own entries have role `factory`.

import { MERGE_COMMAND } from "../core/local-merge.js";
import type { StateChange, Verdict, WorkItemId } from "../core/types.js";
import type { FactoryStore, ItemMessage } from "../interfaces/factory-store.js";

const FACTORY_MARKER = "<!-- factory:";
const GITHUB_COMMENT = /^github:\d+$/;
/** The owner commands the thread shows with their text. */
const OWNER_COMMANDS: readonly string[] = ["approve", "revise", "retry", "reject", MERGE_COMMAND, "verdict"];
const COMMANDS_LIMIT = 200;

/** The page anchor of a thread entry: `msg-<seq>`, the id the item page gives the entry. */
export const threadAnchor = (seq: number): string => `msg-${seq}`;
/** The page anchor of a verdict in the thread: `verdict-<id>`. */
const verdictAnchor = (v: Verdict): string => `verdict-${v.id}`;

/** One thread entry as the item API returns it. */
export interface ThreadRow {
  /** The store's thread entry's seq; 0 for a verdict, which is no thread entry (its `anchor` is its key). */
  seq: number;
  at: string;
  /** From the marker: the factory entry's word (`spec`, `refused`, …), `comment` for a GitHub comment, else `message`; `verdict` for a verdict. */
  kind: string;
  /** `factory` for the factory's own entries; the owner's stored user ID for a command or a verdict; an entry from a source stores its actor's ID when it has one, else `unknown`. */
  author: string;
  /** `factory` for the factory's own entries, `owner` for everything the owner sent. */
  role: "factory" | "owner";
  /** The item's source type for an entry or a verdict; `cli` or `app` (the dashboard) for a command. */
  channel: string;
  anchor: string;
  body: string;
}

const isFactory = (m: ItemMessage) => m.marker.startsWith(FACTORY_MARKER);

function kindOf(m: ItemMessage): string {
  if (isFactory(m)) return /^<!-- factory:([a-z][a-z-]*)/.exec(m.marker)?.[1] ?? "factory";
  return GITHUB_COMMENT.test(m.marker) ? "comment" : "message";
}

/**
 * The item's thread, oldest first: its entries, its verdicts, then its owner commands (the page orders them by
 * time); `text` is the Withholder's plain text, which every body and note passes; `changes` the item's state
 * changes, for each verdict's actor.
 */
export async function threadRows(
  store: Pick<FactoryStore, "listItemMessages" | "listVerdicts" | "listItemCommands">, id: WorkItemId, channel: string, text: (v: string) => Promise<string>,
  changes: readonly StateChange[],
): Promise<ThreadRow[]> {
  const out: ThreadRow[] = [];
  for (const m of await store.listItemMessages(id)) {
    out.push({
      seq: m.seq,
      at: m.created_at,
      kind: kindOf(m),
      author: isFactory(m) ? "factory" : (m.actor ?? "unknown"),
      role: isFactory(m) ? "factory" : "owner",
      channel,
      anchor: threadAnchor(m.seq),
      body: await text(m.body),
    });
  }
  for (const v of await store.listVerdicts(id)) {
    const head = `Verdict **${v.verdict}**, severity ${v.severity}${v.implicit ? " (implicit)" : ""}`;
    out.push({
      seq: 0,
      at: v.at,
      kind: "verdict",
      author: changes.find((c) => c.id === v.state_change_id)?.actor.id ?? "unknown",
      role: "owner",
      channel,
      anchor: verdictAnchor(v),
      body: v.reason === null ? head : `${head}\n\n${await text(v.reason)}`,
    });
  }
  for (const c of await store.listItemCommands(id, COMMANDS_LIMIT)) {
    if (!OWNER_COMMANDS.includes(c.command)) continue;
    const note = c.args.text ?? c.args.note;
    out.push({
      seq: 0,
      at: c.created_at,
      kind: c.command,
      author: c.actor,
      role: "owner",
      channel: c.origin,
      anchor: `command-${c.id}`,
      body: typeof note === "string" ? await text(note) : "",
    });
  }
  return out;
}

/** The anchor of the item's newest factory entry (the latest "why" the factory wrote); null when it has none. */
export async function latestWhyAnchor(store: Pick<FactoryStore, "listItemMessages">, id: WorkItemId): Promise<string | null> {
  const latest = (await store.listItemMessages(id)).filter(isFactory).reduce<ItemMessage | null>((a, m) => (a && a.seq > m.seq ? a : m), null);
  return latest ? threadAnchor(latest.seq) : null;
}
