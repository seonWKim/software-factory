// Dependency inversion (RFC 0015 §6): the core loops over messages and calls the handlers discovery found.
// A feature is a handler in its own folder (`src/<component>/handlers/<name>/<name>.handler.ts`); the core
// never names one.

import type { Draft, Envelope } from "./envelope.js";

/** Where a new consumer group starts on a topic (`EventBus.subscribe`). */
export type StartPosition = "latest" | "earliest";

export interface HandlerContext {
  /** Queues a message. The runtime writes it to the component's outbox in the same transaction as the handler's state. */
  emit(draft: Draft): void;
}

/**
 * A handler's context is its component's: the component's consumer builds it, e.g. with the open transaction its
 * inbox row commits in (`C` extends this base).
 */
export interface HandlerDescriptor<M extends Envelope = Envelope, C extends HandlerContext = HandlerContext> {
  readonly kind: "handler";
  /** Unique across the factory; also the inbox consumer name. */
  readonly name: string;
  /** Message types it subscribes to; the registry indexes handlers by these. */
  readonly accepts: readonly M["type"][];
  /**
   * Where its consumer group starts on a partitioned or fan-out topic it is new to: `latest` (the default) after
   * every message already there, `earliest` at the first one the topic still holds (a replay of its retention).
   * Taken when the component's consumer starts; a group that exists keeps its cursors.
   */
  readonly startFrom?: StartPosition;
  /** Cheap filter run before `handle`. false skips the message with no side effects. */
  readonly canHandle?: (m: M) => boolean;
  handle(m: M, ctx: C): Promise<void>;
}

export const HANDLER_NAME = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

export function defineHandler<M extends Envelope, C extends HandlerContext = HandlerContext>(
  h: Omit<HandlerDescriptor<M, C>, "kind">,
): HandlerDescriptor<M, C> {
  if (!HANDLER_NAME.test(h.name)) throw new Error(`handler name "${h.name}" must be kebab-case`);
  if (h.accepts.length === 0) throw new Error(`handler "${h.name}" accepts no message type`);
  return { kind: "handler", ...h };
}
