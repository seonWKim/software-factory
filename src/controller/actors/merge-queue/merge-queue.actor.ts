// The MergeQueue actor (RFC 0015 §7 Merge queue, §8; M8): one per project and base branch, snapshot in
// `controller_merge_queues`. idle: nothing is being checked. checking: the head entry's merge-check run is out.
// merging: a green entry is landing. paused: the queue takes no entry to check (no command sets it yet).

import { defineActor } from "../../router/actor.js";

export type MergeQueueState = "idle" | "checking" | "merging" | "paused";

export default defineActor<MergeQueueState>({
  name: "MergeQueue",
  states: ["idle", "checking", "merging", "paused"],
  initial: ["idle"],
  terminal: [],
  transitions: [
    ["idle", "checking"],
    ["checking", "merging"],
    // A red check, a timed-out check, or a check whose entry left: back to idle, and the next entry is checked.
    ["checking", "idle"],
    // Landed, or refused because the base moved: back to idle.
    ["merging", "idle"],
    ["idle", "paused"],
    ["checking", "paused"],
    ["paused", "idle"],
  ],
});
