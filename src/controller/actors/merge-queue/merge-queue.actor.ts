// The MergeQueue actor (RFC 0015 §7 Merge queue, §8; M8): one per project and base branch, snapshot in
// `controller_merge_queues`. idle: no check is out. checking: at least one entry's merge-check run is out (up to the
// speculative depth). merging: the head entry is landing; nothing else starts meanwhile. paused: the queue starts no
// check and lands nothing (no command sets it yet: neither the design nor the RFC names one).

import { defineActor } from "../../router/actor.js";

export type MergeQueueState = "idle" | "checking" | "merging" | "paused";

export default defineActor<MergeQueueState>({
  name: "MergeQueue",
  states: ["idle", "checking", "merging", "paused"],
  initial: ["idle"],
  terminal: [],
  transitions: [
    ["idle", "checking"],
    // Every check came back (red, timed out, passed behind an entry still landing): idle.
    ["checking", "idle"],
    // The head passed: it lands, whether or not checks behind it are still out.
    ["idle", "merging"],
    ["checking", "merging"],
    // Landed, or refused: back to idle, and the queue settles to checking if checks are still out.
    ["merging", "idle"],
    ["idle", "paused"],
    ["checking", "paused"],
    ["paused", "idle"],
  ],
});
