// A MergeQueue entry (RFC 0015 §7 Merge queue; M8), snapshot in `controller_merge_queue_entries`. queued: waits
// for its check. checking: its merge-check run (base + the entries ahead + this change) is out. passed: its check
// was green while entries ahead of it had not landed yet (speculative depth > 1); it lands once it is the head.
// merging: green and at the head, landing. merged and removed end it: removed is a red or timed-out check, a
// refused landing, or an item that left.

import { defineActor } from "../../router/actor.js";

export type MergeQueueEntryState = "queued" | "checking" | "passed" | "merging" | "merged" | "removed";

/** The states an entry is still in the queue in. */
export const LIVE_ENTRY_STATES: readonly MergeQueueEntryState[] = ["queued", "checking", "passed", "merging"];

export default defineActor<MergeQueueEntryState>({
  name: "MergeQueueEntry",
  states: ["queued", "checking", "passed", "merging", "merged", "removed"],
  initial: ["queued"],
  terminal: ["merged", "removed"],
  transitions: [
    ["queued", "checking"],
    ["checking", "passed"],
    ["passed", "merging"],
    // Rebuilt: an entry ahead of it left, so what it was checked against will not land.
    ["checking", "queued"],
    ["passed", "queued"],
    // The base moved between the check and the landing: checked again.
    ["merging", "queued"],
    ["merging", "merged"],
    ["queued", "removed"],
    ["checking", "removed"],
    ["passed", "removed"],
    ["merging", "removed"],
  ],
});
