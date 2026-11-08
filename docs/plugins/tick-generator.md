# TickGenerator

What it does: the only way time enters a component (RFC 0015 §5.3, design [10-event-driven.md](../design/10-event-driven.md)). Each component a role runs gets its own generator and registers its schedules on it (inbound: `intake`, `relay`, `consume`, `records`, `prune`; controller: `relay`, `consume`, `prune`; bus: `retry`, `prune`). Handlers never read a clock.

Interface (`src/shared/ticks/tick-generator.ts`): a plugin is a `TickSource`; `create(onError)` makes one `TickGenerator`, whose `schedule(name, periodMs, onTick)` registers a schedule and `run(signal)` ticks until the signal aborts.

Plugins:

- `time-based`: `TimeBasedTicks`, the default. Each schedule ticks on the system clock at its period, one tick at a time; a failed tick is logged and the schedule goes on.
  - Enable: `"plugins": { "ticks": "time-based", ... }`, or leave `ticks` out. Secrets: none. Settings: none.
- `manual`: `ManualTicks`, for tests. Nothing ticks until a test calls `tick(schedule, at)` on a generator it made (`made`, in creation order), with no sleeps and no fake timers.
  - Enable: `"plugins": { "ticks": "manual", ... }`. Secrets: none. Settings: none. A factory run this way does not move on its own.

Solo developer and enterprise team: the same `time-based` plugin. Turn on / off: it cannot be turned off. Switch back: `"ticks": "time-based"`.

## History

No earlier decision is recorded for this topic.
