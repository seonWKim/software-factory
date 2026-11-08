// The default TickGenerator: the system clock (or the time a component hands it) and each schedule's period. With
// the bus plugins' transport code, this is the only place allowed to read the clock or set a timer (no-clock test).

import { periodOf, tickAt, type Period, type TickGenerator, type TickHandler, type TickSource, type TimeSource } from "../../tick-generator.js";
import { systemTimer } from "./timer.js";

interface Entry {
  name: string;
  period: Period;
  onTick: TickHandler;
}

export class TimeBasedTickGenerator implements TickGenerator {
  private readonly entries: Entry[] = [];

  constructor(
    private readonly onError: (schedule: string, err: unknown) => void = () => {},
    private readonly time: TimeSource | null = null,
  ) {}

  schedule(name: string, period: Period, onTick: TickHandler): void {
    if (this.entries.some((e) => e.name === name)) throw new Error(`tick schedule "${name}" is registered twice`);
    this.entries.push({ name, period, onTick });
  }

  async run(signal: AbortSignal): Promise<void> {
    await Promise.all(this.entries.map((e) => this.loop(e, signal)));
  }

  private async loop(e: Entry, signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      try {
        await e.onTick(tickAt(e.name, periodOf(e.period), this.time ? this.time.now().getTime() : Date.now()));
      } catch (err) {
        this.onError(e.name, err);
      }
      // Read after the tick, so a period the tick changed (a live setting it refreshed) sets this wait.
      const ms = periodOf(e.period);
      if (this.time) await this.time.sleep(ms, signal).catch(() => undefined);
      else await systemTimer.after(ms, signal);
    }
  }
}

/** The `time-based` TickGenerator plugin, the default (docs/plugins/tick-generator.md). */
export class TimeBasedTicks implements TickSource {
  create(onError: (schedule: string, err: unknown) => void, time?: TimeSource): TimeBasedTickGenerator {
    return new TimeBasedTickGenerator(onError, time ?? null);
  }
}
