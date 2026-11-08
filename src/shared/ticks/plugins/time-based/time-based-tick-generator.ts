// The default TickGenerator: the system clock (or the time a component hands it) and each schedule's period. With
// the bus plugins' transport code, this is the only place allowed to read the clock or set a timer (no-clock test).

import { type Period, periodOf, tickAt, type TickGenerator, type TickHandler, type TickSource, type TimeSource } from "../../tick-generator.js";
import { systemTimer } from "./timer.js";

interface Entry {
  name: string;
  periodMs: Period;
  onTick: TickHandler;
}

export class TimeBasedTickGenerator implements TickGenerator {
  private readonly entries: Entry[] = [];

  constructor(
    private readonly onError: (schedule: string, err: unknown) => void = () => {},
    private readonly time: TimeSource | null = null,
  ) {}

  schedule(name: string, periodMs: Period, onTick: TickHandler): void {
    if (this.entries.some((e) => e.name === name)) throw new Error(`tick schedule "${name}" is registered twice`);
    this.entries.push({ name, periodMs, onTick });
  }

  async run(signal: AbortSignal): Promise<void> {
    await Promise.all(this.entries.map((e) => this.loop(e, signal)));
  }

  private async loop(e: Entry, signal: AbortSignal): Promise<void> {
    let due: number | undefined;
    let period = periodOf(e.periodMs);
    while (!signal.aborted) {
      try {
        await e.onTick(tickAt(e.name, period, this.now(), due));
      } catch (err) {
        this.onError(e.name, err);
      }
      // Read before each wait, so a live period applies from the next wait on.
      period = periodOf(e.periodMs);
      due = this.now() + period;
      if (this.time) await this.time.sleep(period, signal).catch(() => undefined);
      else await systemTimer.after(period, signal);
    }
  }

  private now(): number {
    return this.time ? this.time.now().getTime() : Date.now();
  }
}

/** The `time-based` TickGenerator plugin, the default (docs/plugins/tick-generator.md). */
export class TimeBasedTicks implements TickSource {
  create(onError: (schedule: string, err: unknown) => void, time?: TimeSource): TimeBasedTickGenerator {
    return new TimeBasedTickGenerator(onError, time ?? null);
  }
}
