// Inbound component (RFC 0015 §7): source adapters' polls and streams become stored records and InboundReceived
// messages; normalizers turn them into the controller's commands. Other components import only this file.

export {
  COMMANDS_CURSOR, GITHUB_BUDGET_CURSOR, Inbound, LOCAL_STREAM, RECORD_TTL_MS, inboxCursorName, streamSeq,
  type InboundConfig, type InboundDeps,
} from "./intake.js";
export { commandOf, readCommand, readRecord, type InboundEvent } from "./records.js";
export type { InboundContext } from "./context.js";
export { INBOUND_RECEIVED } from "./topics/inbound-records.topic.js";

/** The component name: its tables' prefix, its outbox and inbox. */
export const INBOUND = "inbound";
