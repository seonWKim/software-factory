// deliveries.requests (RFC 0015 §5.5, §7 Outbound): what the controller (and, after M7's second half, the worker)
// asks to be written to the outside world. DeliveryRequested{commit_id, commit_count, destination, intent_ids}: the
// intents one committed transaction requested for one destination; the intents are stored, the message carries
// their ids. The subject is the destination, so one destination's requests keep their order in one partition.

import { defineTopic } from "../../shared/topic.js";

export const DELIVERY_REQUESTED = "DeliveryRequested";

export default defineTopic({
  name: "deliveries.requests",
  owner: "outbound",
  messages: { [DELIVERY_REQUESTED]: "command" },
  consumption: "partitioned",
  retentionDays: 7,
});
