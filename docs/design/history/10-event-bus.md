## History

- **Pure units: load, decide, the router commits** (decision changed 2026-11-09, M5 follow-up). Before: the outbox
  unit's `post` built and wrote thread entries itself beside `threadEntry`, only `reaper`, `mirror` and
  `transitions` were off the ratchet, the reader held store reads and the scan only, and `tick_ms` was read once when
  the decide loop started.
- **Unhandled event kinds** (decision changed 2026-11-08, M8 leftovers). Before: the router dropped an event no unit
  accepted, and a run kind with no run file failed each of its runs when claimed.
- **Messaging between parts** (decision changed 2026-11-08, RFC 0015 M3). Before: no bus; the controller tick
  polls sources and the store, and workers claim runs from the store (still how the factory runs until components
  are wired to the bus in M4 and later).
- **Controller decisions** (decision changed 2026-11-08, RFC 0015 M5). Before: one `Controller` class in
  `src/core/controller.ts` (4,790 lines) held every decision, dispatched events with a `switch` on their kind, and
  ran its steps in one hand-ordered loop; the controller role extended it.
- **Pure units** (decision changed 2026-11-08, M5 follow-up). Before: every unit read and wrote the store inline;
  the units' loop slept on the injected `Clock` in a `while` loop, and the reaper read `clock.now()` itself.
- **Intake** (decision changed 2026-11-08, RFC 0015 M4). Before: the controller tick polled every source and the
  forge, read the command inbox and the app requests (two tables) by `seq` cursor, and handled each in the same
  tick.
- **Runs and the worker** (decision changed 2026-11-08, RFC 0015 M6). Before: the engine existed only in its
  contract test; runs went through `src/core/worker.ts` (one class, every kind a method, a dispatch by kind), which
  renewed its lease through the store's heartbeat and kept no journal, so a run whose worker died started over.
- **Seq cursors** (decision changed 2026-11-09, RFC 0015 review finding 1). Before: inserts into a topic table or
  `inbound_commands` took no lock, so on MySQL a cursor could pass a seq that committed later and lose it.
- **Start of a new consumer group** (decision changed 2026-11-09, review finding 6). Before: `consume` created a
  group's cursors at seq 0 on first use, so a new or renamed handler replayed the topic's whole retention.
- **Skipping duplicate rows** (decision changed 2026-11-09, review finding 7). Before: `INSERT IGNORE` on MySQL,
  which also hid values cut to their column.
- **Topic tables at start** (changed 2026-11-09, runtime review M3). Before: every start ran each topic's
  `CREATE TABLE IF NOT EXISTS` even when `bus_topics` listed it, so a MySQL user without CREATE rights failed at the
  first `wire()` and the controller restarted in a loop.
- **Unconsumed handlers and failed builds** (changed 2026-11-09, runtime review L2, L3). Before: a handler in a
  component no role consumes (worker, identity) passed the dispatch check and its messages piled up with no
  error; and a failed `build()` or discovery stayed cached as a rejected promise, so every later call failed the
  same way for the life of the object.
