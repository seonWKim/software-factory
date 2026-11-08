// The default TickGenerator: the system clock and each schedule's period. With the bus plugins' transport
// code, this is the only place allowed to read the clock or set a timer (no-clock test).

import { tickAt, type TickGenerator, type TickHandler } from "../../tick-generator.js";

interface Entry {
  name: string;
  periodMs: number;
  onTick: TickHandler;
}

export class TimeBasedTickGenerator implements TickGenerator {
  private readonly entries: Entry[] = [];

  constructor(private readonly onError: (schedule: string, err: unknown) => void = () => {}) {}

  schedule(name: string, periodMs: number, onTick: TickHandler): void {
    if (this.entries.some((e) => e.name === name)) throw new Error(`tick schedule "${name}" is registered twice`);
    this.entries.push({ name, periodMs, onTick });
  }

  async run(signal: AbortSignal): Promise<void> {
    await Promise.all(this.entries.map((e) => this.loop(e, signal)));
  }

  private async loop(e: Entry, signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      try {
        await e.onTick(tickAt(e.name, e.periodMs, Date.now()));
      } catch (err) {
        this.onError(e.name, err);
      }
      await sleep(e.periodMs, signal);
    }
  }
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });
    function done(): void {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
  });
}
