// Dependency inversion (RFC 0015 §6): the core loops over messages and calls the handlers discovery found.
// A feature is a handler in its own folder (`src/<component>/handlers/<name>/<name>.handler.ts`); the core
// never names one.

import type { Draft, Envelope } from "./envelope.js";

export interface HandlerContext {
  /** Queues a message. The runtime writes it to the component's outbox in the same transaction as the handler's state. */
  emit(draft: Draft): void;
}

export interface HandlerDescriptor<M extends Envelope = Envelope> {
  readonly kind: "handler";
  /** Unique across the factory; also the inbox consumer name. */
  readonly name: string;
  /** Message types it subscribes to; the registry indexes handlers by these. */
  readonly accepts: readonly M["type"][];
  /** Cheap filter run before `handle`. false skips the message with no side effects. */
  readonly canHandle?: (m: M) => boolean;
  handle(m: M, ctx: HandlerContext): Promise<void>;
}

export const HANDLER_NAME = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

export function defineHandler<M extends Envelope>(h: Omit<HandlerDescriptor<M>, "kind">): HandlerDescriptor<M> {
  if (!HANDLER_NAME.test(h.name)) throw new Error(`handler name "${h.name}" must be kebab-case`);
  if (h.accepts.length === 0) throw new Error(`handler "${h.name}" accepts no message type`);
  return { kind: "handler", ...h };
}
