// The test TickGenerator: time moves only when a test calls tick(), with no sleeps and no fake timers.

import { periodOf, tickAt, type Period, type TickGenerator, type TickHandler, type TickSource } from "../../tick-generator.js";

export class ManualTickGenerator implements TickGenerator {
  private readonly entries = new Map<string, { period: Period; onTick: TickHandler }>();

  schedule(name: string, period: Period, onTick: TickHandler): void {
    if (this.entries.has(name)) throw new Error(`tick schedule "${name}" is registered twice`);
    this.entries.set(name, { period, onTick });
  }

  async run(signal: AbortSignal): Promise<void> {
    if (signal.aborted) return;
    await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
  }

  /** Runs one tick of `schedule` at `at` (ISO string or epoch ms) and waits for it. */
  async tick(schedule: string, at: string | number): Promise<void> {
    const e = this.entries.get(schedule);
    if (!e) throw new Error(`no tick schedule "${schedule}" (registered: ${[...this.entries.keys()].join(", ") || "none"})`);
    await e.onTick(tickAt(schedule, periodOf(e.period), typeof at === "number" ? at : Date.parse(at)));
  }

  schedules(): string[] {
    return [...this.entries.keys()];
  }
}

/**
 * The `manual` TickGenerator plugin, for tests (docs/plugins/tick-generator.md): nothing ticks until a test calls
 * `tick()` on one of the generators it made, which it keeps in `made`, in creation order.
 */
export class ManualTicks implements TickSource {
  readonly made: ManualTickGenerator[] = [];

  create(): ManualTickGenerator {
    const g = new ManualTickGenerator();
    this.made.push(g);
    return g;
  }
}
