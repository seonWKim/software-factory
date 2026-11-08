// Controller component (RFC 0015 §7): the consumer claims controller.commands and hands each message to its
// handler, which loads the record or command and gives it to the router; the router hands each event to the unit
// that accepts its kind (src/controller/units/, discovered). Other components import only this file.

import type { CliCommand, NewAlert } from "../interfaces/factory-store.js";
import type { InboundEvent } from "../inbound/index.js";
import type { HandlerContext } from "../shared/handler.js";
import type { SqlExecutor } from "../state/index.js";
import type { UnitDescriptor } from "./router/unit.js";
import type { ControllerEvent } from "./units/context.js";
import type { Kernel } from "./units/kernel.js";

export { COMMAND_RECEIVED, SOURCE_EVENT_RECEIVED } from "./topics/controller-commands.topic.js";
export { Router } from "./router/router.js";
export type { UnitName, UnitOperations } from "./router/unit.js";
export type { ControllerEvent } from "./units/context.js";
export { Kernel } from "./units/kernel.js";

/** The discovered units, as the router takes them. */
export type ControllerUnits = readonly UnitDescriptor<Kernel, ControllerEvent, unknown>[];

/** The component name: its tables' prefix, its outbox and inbox. */
export const CONTROLLER = "controller";

/** Where what inbound delivers is decided (the controller role, through the router and its units). */
export interface Decisions {
  /** One event a source or the forge reported. A failure is logged there and passed, as a polled event's was. */
  consumeEvent(e: InboundEvent): Promise<void>;
  /** One command row. Throws when it should be tried again; the commands after it in its stream wait. */
  consumeCommand(c: CliCommand): Promise<void>;
}

/**
 * What the controller's handlers get. The units still commit their own transactions (their pure load/decide split
 * is the follow-up), so the handler runs outside the consumer's: the inbox row is written after the effect, and the
 * effect is safe to run twice (M4).
 */
export interface ControllerContext extends HandlerContext {
  /** Reads through other components' index.ts. */
  readonly db: SqlExecutor;
  readonly decisions: Decisions;
  /**
   * Stores an alarm for the status page's Needs you (design 05-alarms), unless its pattern key alerted within
   * `dedupe_ms`. Its detail is scanned as UI text first and dropped if flagged (G5).
   */
  recordAlert(alert: NewAlert, dedupe_ms: number): Promise<void>;
}
