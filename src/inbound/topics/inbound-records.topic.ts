// inbound.records (RFC 0015 §5.5): one message per record an adapter stored (a raw source event, or a command
// row), consumed by the normalizers. Partitioned by the record's stream (its source type, or `local` for CLI and
// UI commands), not by record id: a source's records keep the order the adapters read them in, so a merge the
// forge reported is normalized before the issue close it caused, as one controller tick handled them before.

import { defineTopic } from "../../shared/topic.js";

export const INBOUND_RECEIVED = "InboundReceived";

export default defineTopic({
  name: "inbound.records",
  owner: "inbound",
  messages: { [INBOUND_RECEIVED]: "event" },
  consumption: "partitioned",
  retentionDays: 7,
});
