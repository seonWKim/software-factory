// The one conversion between a work item's change reference and a forge PR number (design 02, phase 2 of the
// change fields). The core reads the PR from `change_ref` and converts here only where a forge call takes a number.

import type { WorkItem } from "./types.js";

/** The PR number of the item's change: `change_ref` as a number. Null without a change, or for a non-numeric ref. */
export function prNumber(item: Pick<WorkItem, "change_ref">): number | null {
  if (item.change_ref === null || !/^\d+$/.test(item.change_ref)) return null;
  const n = Number(item.change_ref);
  return Number.isSafeInteger(n) ? n : null;
}
