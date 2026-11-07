// The one conversion between a work item's change reference and a forge PR number (design 02, phase 2 of the
// change fields). The core reads the PR from `change_ref` and converts here only where a forge call takes a number.

import type { WorkItem } from "./types.js";

/** The PR number of the item's change: `change_ref` as a number. Null without a change, or for a non-numeric ref. */
export function prNumber(item: Pick<WorkItem, "change_ref">): number | null {
  if (item.change_ref === null || !/^\d+$/.test(item.change_ref)) return null;
  const n = Number(item.change_ref);
  return Number.isSafeInteger(n) ? n : null;
}

/** A local item's source type: its messages are its item thread, so it has no forge issue. */
const LOCAL_SOURCE = "local";

/**
 * The forge issue number of an issue item, from its `owner/repo#<digits>` source id (design 05-sources). Null for
 * a local item, and for any other id (a chat thread, a malformed id): such an item gets no forge comment.
 */
export function issueNumber(item: Pick<WorkItem, "source">): number | null {
  if (item.source.type === LOCAL_SOURCE) return null;
  const m = /^[^\s#/]+\/[^\s#/]+#(\d+)$/.exec(item.source.id);
  const n = m ? Number(m[1]) : 0;
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}
