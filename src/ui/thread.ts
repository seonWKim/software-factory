// An item's thread as the item API returns it (design §9, issue #286): the store's entries (listItemMessages, the
// item_thread table) oldest first, each body through the Withholder. A thread entry stores only its marker, body
// and time, so what the API says about its author comes from the marker: the factory's own entries (marker
// `<!-- factory:<kind>:… -->`) have author `factory`, every other entry `unknown`. The channel is the item's
// source type. Store reads only, no forge or source call.

import type { SourceType, WorkItemId } from "../core/types.js";
import type { FactoryStore, ItemMessage } from "../interfaces/factory-store.js";

const FACTORY_MARKER = "<!-- factory:";
const GITHUB_COMMENT = /^github:\d+$/;

/** The page anchor of a thread entry: `msg-<seq>`, the id the item page gives the entry. */
export const threadAnchor = (seq: number): string => `msg-${seq}`;

/** One thread entry as the item API returns it. */
export interface ThreadRow {
  seq: number;
  at: string;
  /** From the marker: the factory entry's word (`spec`, `refused`, …), `comment` for a GitHub comment, else `message`. */
  kind: string;
  /** `factory` for the factory's own entries; `unknown` for any other, since the entry stores no author. */
  author: string;
  /** The item's source type: where the thread lives. */
  channel: SourceType;
  anchor: string;
  body: string;
}

const isFactory = (m: ItemMessage) => m.marker.startsWith(FACTORY_MARKER);

function kindOf(m: ItemMessage): string {
  if (isFactory(m)) return /^<!-- factory:([a-z][a-z-]*)/.exec(m.marker)?.[1] ?? "factory";
  return GITHUB_COMMENT.test(m.marker) ? "comment" : "message";
}

/** The item's thread, oldest first; `text` is the Withholder's plain text. */
export async function threadRows(
  store: Pick<FactoryStore, "listItemMessages">, id: WorkItemId, channel: SourceType, text: (v: string) => Promise<string>,
): Promise<ThreadRow[]> {
  const out: ThreadRow[] = [];
  for (const m of await store.listItemMessages(id)) {
    out.push({
      seq: m.seq,
      at: m.created_at,
      kind: kindOf(m),
      author: isFactory(m) ? "factory" : "unknown",
      channel,
      anchor: threadAnchor(m.seq),
      body: await text(m.body),
    });
  }
  return out;
}

/** The anchor of the item's newest factory entry (the latest "why" the factory wrote); null when it has none. */
export async function latestWhyAnchor(store: Pick<FactoryStore, "listItemMessages">, id: WorkItemId): Promise<string | null> {
  const latest = (await store.listItemMessages(id)).filter(isFactory).reduce<ItemMessage | null>((a, m) => (a && a.seq > m.seq ? a : m), null);
  return latest ? threadAnchor(latest.seq) : null;
}
