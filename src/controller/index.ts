// Controller component (RFC 0015 §7): the router claims controller.commands and hands each message to its
// handlers. Until the units land (M5), one handler bridges to the legacy controller's decision code. Other
// components import only this file.

import type { CliCommand, NewAlert } from "../interfaces/factory-store.js";
import type { InboundEvent } from "../inbound/index.js";
import type { HandlerContext } from "../shared/handler.js";
import type { SqlExecutor } from "../state/index.js";

export { COMMAND_RECEIVED, SOURCE_EVENT_RECEIVED } from "./topics/controller-commands.topic.js";

/** The component name: its tables' prefix, its outbox and inbox. */
export const CONTROLLER = "controller";

/** The legacy controller's entry points for what inbound delivers (src/core/controller.ts until M5). */
export interface LegacyDecisions {
  /** One event a source or the forge reported. A failure is logged there and passed, as a polled event's was. */
  consumeEvent(e: InboundEvent): Promise<void>;
  /** One command row. Throws when it should be tried again; the commands after it in its stream wait. */
  consumeCommand(c: CliCommand): Promise<void>;
}

/**
 * What the controller's handlers get. The legacy decision code commits its own transactions, so its handler runs
 * outside the consumer's: the inbox row is written after the effect, and the effect is safe to run twice (M4).
 */
export interface ControllerContext extends HandlerContext {
  /** Reads through other components' index.ts. */
  readonly db: SqlExecutor;
  readonly legacy: LegacyDecisions;
  /**
   * Stores an alarm for the status page's Needs you (design 05-alarms), unless its pattern key alerted within
   * `dedupe_ms`. Its detail is scanned as UI text first and dropped if flagged (G5).
   */
  recordAlert(alert: NewAlert, dedupe_ms: number): Promise<void>;
}
