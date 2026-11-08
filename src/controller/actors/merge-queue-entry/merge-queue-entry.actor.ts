// A MergeQueue entry (RFC 0015 §7 Merge queue; M8), snapshot in `controller_merge_queue_entries`. queued: waits
// for its check. checking: its merge-check run (base + the entries ahead + this change) is out. merging: green,
// landing. merged and removed end it: removed is a red or timed-out check, a refused landing, or an item that left.

import { defineActor } from "../../router/actor.js";

export type MergeQueueEntryState = "queued" | "checking" | "merging" | "merged" | "removed";

/** The states an entry is still in the queue in. */
export const LIVE_ENTRY_STATES: readonly MergeQueueEntryState[] = ["queued", "checking", "merging"];

export default defineActor<MergeQueueEntryState>({
  name: "MergeQueueEntry",
  states: ["queued", "checking", "merging", "merged", "removed"],
  initial: ["queued"],
  terminal: ["merged", "removed"],
  transitions: [
    ["queued", "checking"],
    ["checking", "merging"],
    // Rebuilt: an entry ahead of it was removed, so what it was checked against will not land.
    ["checking", "queued"],
    // The base moved between the check and the landing: checked again.
    ["merging", "queued"],
    ["merging", "merged"],
    ["queued", "removed"],
    ["checking", "removed"],
    ["merging", "removed"],
  ],
});
