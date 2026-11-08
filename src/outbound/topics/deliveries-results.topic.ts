// deliveries.results (RFC 0015 §5.5, §7): what outbound delivered. DeliveryCompleted{batch_id, destination,
// intent_ids}: every intent of the batch was delivered (a best-effort action: tried once) and is marked so. The
// controller records what it keeps of a delivery: a thread entry's URL on its item. The subject is the destination.

import { defineTopic } from "../../shared/topic.js";

export const DELIVERY_COMPLETED = "DeliveryCompleted";

export default defineTopic({
  name: "deliveries.results",
  owner: "outbound",
  messages: { [DELIVERY_COMPLETED]: "event" },
  consumption: "partitioned",
  retentionDays: 7,
});
