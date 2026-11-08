// controller.commands (RFC 0015 §5.5): what the outside world asks of the controller, normalized by inbound.
// - CommandReceived{command_id}: a command row (CLI, UI app request, or a comment command a forge poll stored).
// - SourceEventReceived{record_id, kind}: an event a source or the forge reported (an issue to take in, a comment,
//   a close, a PR change, a base commit); `kind` is the adapter's event kind. Finer message types come with the
//   controller units (M5), which decide on them.
// The subject is the record's stream until M5 resolves the actor at normalization, so a source's messages keep
// their order through one partition.

import { defineTopic } from "../../shared/topic.js";

export const COMMAND_RECEIVED = "CommandReceived";
export const SOURCE_EVENT_RECEIVED = "SourceEventReceived";

export default defineTopic({
  name: "controller.commands",
  owner: "controller",
  messages: { [COMMAND_RECEIVED]: "command", [SOURCE_EVENT_RECEIVED]: "command" },
  consumption: "partitioned",
  retentionDays: 30,
  // A command whose handling failed (a store error) is retried until it succeeds, as the command cursor held it
  // before M4: at most a minute apart, and dead-lettered only after about 16 hours of failures.
  backoff: { baseMs: 1_000, maxMs: 60_000, maxAttempts: 1_000 },
});
