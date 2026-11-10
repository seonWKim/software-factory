// A component's consumer (RFC 0015 §5.2, §6.2): on the component's `consume` tick, each of its discovered handlers
// claims the topics of the types it accepts, as its own consumer group (the handler's name), and handles each
// message exactly once in effect: the inbox row, the handler's writes and what it emits commit together
// (`deliver`). A component whose handlers commit their own writes (the legacy bridge, M4) is not transactional:
// the effect runs first and the inbox row follows, so a crash in between runs the effect again, which those
// handlers are safe to.

import { errorText } from "../core/log.js";
import { deliver, type EventBus, type Inbox, type NackError } from "../bus/index.js";
import { causeOf, envelope, type Draft, type Envelope } from "../shared/envelope.js";
import type { HandlerContext, HandlerDescriptor } from "../shared/handler.js";
import type { TopicDescriptor } from "../shared/topic.js";
import type { SqlDriver, SqlExecutor } from "../state/index.js";
import type { Registry } from "./registry/registry.js";

export interface ConsumerOptions<C extends HandlerContext> {
  readonly db: SqlDriver;
  /** The component's bus: it publishes to the component's outbox and dedupes in its inbox. */
  readonly bus: EventBus & Inbox;
  readonly registry: Registry;
  readonly component: string;
  /** The handler's context: `tx` is the consumer's transaction, or null for a non-transactional component. */
  readonly context: (tx: SqlExecutor | null, emit: (d: Draft) => void) => C;
  readonly transactional: boolean;
  /** Messages each handler claims per topic per call. */
  readonly batch?: number;
}

const DEFAULT_BATCH = 100;

function failed(err: unknown): NackError {
  return { retryable: true, code: "error", detail: errorText(err) };
}

export class ComponentConsumer<C extends HandlerContext> {
  private readonly handlers: readonly { h: HandlerDescriptor<Envelope, C>; topics: readonly TopicDescriptor[] }[];

  constructor(private readonly o: ConsumerOptions<C>) {
    this.handlers = o.registry.handlers
      .filter((l) => l.file.split("/")[0] === o.component)
      .map((l) => {
        const h = l.descriptor as HandlerDescriptor<Envelope, C>;
        const topics = [...new Set(h.accepts.map((type) => o.registry.topicOf(type)).filter((t): t is TopicDescriptor => t !== null))];
        return { h, topics };
      });
  }

  /**
   * Subscribes each handler's group to its topics at the handler's `startFrom` (default `latest`). The role calls
   * it when it starts, before any component relays, so a new handler gets what is published from then on and an
   * existing one keeps its cursors.
   */
  async subscribe(): Promise<void> {
    for (const { h, topics } of this.handlers) {
      for (const topic of topics) await this.o.bus.subscribe(h.name, topic.name, h.startFrom ?? "latest");
    }
  }

  /** Claims and handles what is due for each handler; returns how many messages it claimed. */
  async consume(): Promise<number> {
    let n = 0;
    for (const { h, topics } of this.handlers) {
      for (const topic of topics) {
        for (const c of await this.o.bus.consume(h.name, topic.name, this.o.batch ?? DEFAULT_BATCH)) {
          n++;
          const m = c.message;
          if (!h.accepts.includes(m.type) || h.canHandle?.(m) === false) {
            await this.o.bus.ack(c);
            continue;
          }
          // The lease ran out while earlier messages of the batch were handled: another consumer has it now.
          if (!(await this.o.bus.renew(c))) continue;
          const drafts: Draft[] = [];
          const emit = (d: Draft) => void drafts.push(d);
          const publish = (tx: SqlExecutor, msg: Envelope) => this.o.bus.publish(tx, drafts.map((d) => envelope(d, causeOf(msg), h.name)));
          if (this.o.transactional) {
            await deliver(this.o.db, this.o.bus, this.o.bus, h.name, c, async (tx, msg) => {
              // The driver may run this again after a rollback (a MySQL deadlock): drop what that attempt emitted.
              drafts.length = 0;
              await h.handle(msg, this.o.context(tx, emit));
              await publish(tx, msg);
            });
            continue;
          }
          try {
            await h.handle(m, this.o.context(null, emit));
          } catch (err) {
            await this.o.bus.nack(c, failed(err));
            continue;
          }
          await deliver(this.o.db, this.o.bus, this.o.bus, h.name, c, publish);
        }
      }
    }
    return n;
  }
}
