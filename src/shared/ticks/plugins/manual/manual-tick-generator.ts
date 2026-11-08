// The test TickGenerator: time moves only when a test calls tick(), with no sleeps and no fake timers.

import { tickAt, type TickGenerator, type TickHandler } from "../../tick-generator.js";

export class ManualTickGenerator implements TickGenerator {
  private readonly entries = new Map<string, { periodMs: number; onTick: TickHandler }>();

  schedule(name: string, periodMs: number, onTick: TickHandler): void {
    if (this.entries.has(name)) throw new Error(`tick schedule "${name}" is registered twice`);
    this.entries.set(name, { periodMs, onTick });
  }

  async run(signal: AbortSignal): Promise<void> {
    if (signal.aborted) return;
    await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
  }

  /** Runs one tick of `schedule` at `at` (ISO string or epoch ms) and waits for it. */
  async tick(schedule: string, at: string | number): Promise<void> {
    const e = this.entries.get(schedule);
    if (!e) throw new Error(`no tick schedule "${schedule}" (registered: ${[...this.entries.keys()].join(", ") || "none"})`);
    await e.onTick(tickAt(schedule, e.periodMs, typeof at === "number" ? at : Date.parse(at)));
  }

  schedules(): string[] {
    return [...this.entries.keys()];
  }
}
