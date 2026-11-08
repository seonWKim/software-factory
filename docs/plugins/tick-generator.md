# TickGenerator

What it does: the only way time enters a component (RFC 0015 §5.3, design [10-event-driven.md](../design/10-event-driven.md)). Each component a role runs gets its own generator and registers its schedules on it (inbound: `intake`, `relay`, `consume`, `records`, `prune`; controller: `relay`, `consume`, `prune`, and its units' `decide` on a second generator; bus: `retry`, `prune`; worker: `claim`, and per run `heartbeat`, `pause-watch` and the implement agent step's `diff-watch`). Handlers never read a clock.

Interface (`src/shared/ticks/tick-generator.ts`): a plugin is a `TickSource`; `create(onError, time?)` makes one `TickGenerator` (`time`: the clock a time-based generator reads and waits on, the controller's injected `Clock` for its units; absent, the system clock), whose `schedule(name, periodMs, onTick)` registers a schedule and `run(signal)` ticks until the signal aborts. `periodMs` is a number or a function read before each wait (a live setting: the worker's `tick_ms` and `heartbeat_ms`). A schedule's first tick fires at once with no `due`; each later tick carries `due`, one period after the previous tick ended, so a tick whose `now` is far past its `due` is a host sleep (design 05-coordination, Host sleep).

Plugins:

- `time-based`: `TimeBasedTicks`, the default. Each schedule ticks on the system clock (or the `time` it was created with) at its period, one tick at a time; a failed tick is logged and the schedule goes on.
  - Enable: `"plugins": { "ticks": "time-based", ... }`, or leave `ticks` out. Secrets: none. Settings: none.
- `manual`: `ManualTicks`, for tests. Nothing ticks until a test calls `tick(schedule, at, due?)` on a generator it made (`made`, in creation order), with no sleeps and no fake timers.
  - Enable: `"plugins": { "ticks": "manual", ... }`. Secrets: none. Settings: none. A factory run this way does not move on its own.

Solo developer and enterprise team: the same `time-based` plugin. Turn on / off: it cannot be turned off. Switch back: `"ticks": "time-based"`.

## History

No earlier decision is recorded for this topic.
