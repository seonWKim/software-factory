// system.alerts (RFC 0015 §5.4, §5.5): notices for the operator, fanned out to every group that listens (the
// alarms, the UI). The bus itself writes DeadLettered here, in the transaction that dead-letters a message.
// Partitioned by the alert's pattern, so one pattern's notices keep their order.

import { defineTopic } from "../../shared/topic.js";

export const DEAD_LETTERED = "DeadLettered";

export default defineTopic({
  name: "system.alerts",
  owner: "bus",
  messages: { [DEAD_LETTERED]: "event" },
  partitionKey: (m) => String(m.payload.pattern ?? m.type),
  consumption: "fanout",
  retentionDays: 90,
});
