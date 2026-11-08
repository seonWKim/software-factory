// controller.events (RFC 0015 §5.5, §7): what the controller's units emit for themselves, mostly delayed (durable
// timers). The controller's `unit-messages` handler hands each back to the unit that takes its type.
// - MergeCheckTimedOut{entry_id, run_key}: a merge queue entry's check did not finish in time (the merge-queue unit).

import { defineTopic } from "../../shared/topic.js";

export const MERGE_CHECK_TIMED_OUT = "MergeCheckTimedOut";

export default defineTopic({
  name: "controller.events",
  owner: "controller",
  messages: { [MERGE_CHECK_TIMED_OUT]: "event" },
  consumption: "partitioned",
  retentionDays: 30,
});
