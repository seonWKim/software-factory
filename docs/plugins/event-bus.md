# EventBus

What it does: carries the factory's messages between components (RFC 0015 §5, design [10-event-driven.md](../design/10-event-driven.md)). A component publishes into its own outbox in its own transaction; the relay moves the outbox onto the topics; each consumer group claims, acks or nacks; failures retry with the topic's backoff and end as dead letters, each one announced on `system.alerts`. The retry scheduler moves the bus's time (the release horizon) on its `retry` tick.

Interface (`src/bus/index.ts`): a plugin is a `BusPlugin`. `component({ db, component, topics, consumerId, capabilities })` builds one component's `EventBus & Inbox & Relay`; `scheduler(db, topics)` builds the `RetryScheduler` the bus role ticks. The runtime builds the plugin through the registry (`src/compose.ts`) and hands it to the roles.

Plugins:

- `sql`: `SqlBus`, the default. Every topic is a set of tables in the store's own database (`bus_<topic>`, `_cursors`, `_retries`, `_dead_letters`), created by `npm run migrate` from the discovered topics and again, idempotently, when a role starts.
  - Solo developer: SQLite, nothing to set up. Enterprise team: the shared MySQL store; several replicas claim with conditional updates and leases.
  - Competing topics take `requires`: a consumer built with `capabilities` claims only messages whose `requires` are all among them.
  - Enable: `"plugins": { "bus": "sql", ... }`, or leave `bus` out: it is the default. Secrets: none. Settings: none.

Turn on / off: the bus cannot be turned off; there is no other plugin yet (Kafka and NATS implement the same interface later, RFC 0015 §5.6). Switch back: `"bus": "sql"`.

The descriptor lives in `src/impl/bus/sql.plugin.ts` until `plugin-api.ts` moves into a component (M11): a component file that imports it is a dependency-direction violation.

## History

No earlier decision is recorded for this topic.
