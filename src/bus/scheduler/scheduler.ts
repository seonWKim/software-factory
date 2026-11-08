// The bus's schedules (RFC 0015 §5.3). Ticks come from the TickGenerator the caller embeds; the bus never
// reads a clock or sets a timer. A component with an outbox schedules `relay` and `prune` on its own
// generator; the process that runs the bus role schedules the scheduler's `retry` and `prune`.

import type { TickGenerator } from "../../shared/ticks/tick-generator.js";
import type { Relay, RetryScheduler } from "../index.js";

export const BUS_PERIODS = { relay: 250, consume: 250, retry: 1_000, prune: 3_600_000 } as const;

export function scheduleBus(ticks: TickGenerator, scheduler: RetryScheduler, periods: { retry: number; prune: number } = BUS_PERIODS): void {
  ticks.schedule("retry", periods.retry, (t) => scheduler.release(t));
  ticks.schedule("prune", periods.prune, (t) => scheduler.prune(t));
}

export function scheduleComponent(ticks: TickGenerator, relay: Relay, periods: { relay: number; prune: number } = BUS_PERIODS): void {
  ticks.schedule("relay", periods.relay, async (t) => {
    await relay.relay(t);
  });
  ticks.schedule("prune", periods.prune, (t) => relay.prune(t));
}
