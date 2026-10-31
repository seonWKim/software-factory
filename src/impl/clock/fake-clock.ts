import type { Clock } from "../../interfaces/clock.js";

interface Sleeper {
  wakeAt: number;
  resolve: () => void;
}

/** Test clock. Time moves only through advance(); sleepers wake when their time is reached. */
export class FakeClock implements Clock {
  private ms: number;
  private sleepers: Sleeper[] = [];

  constructor(start: Date | string = "2026-01-01T00:00:00.000Z") {
    this.ms = new Date(start).getTime();
  }

  now(): Date {
    return new Date(this.ms);
  }

  sleep(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) return reject(signal.reason);
      const sleeper: Sleeper = { wakeAt: this.ms + ms, resolve };
      this.sleepers.push(sleeper);
      signal?.addEventListener(
        "abort",
        () => {
          this.sleepers = this.sleepers.filter((s) => s !== sleeper);
          reject(signal.reason);
        },
        { once: true },
      );
    });
  }

  advance(ms: number): void {
    this.ms += ms;
    const due = this.sleepers.filter((s) => s.wakeAt <= this.ms);
    this.sleepers = this.sleepers.filter((s) => s.wakeAt > this.ms);
    for (const s of due) s.resolve();
  }

  set(time: Date | string): void {
    const target = new Date(time).getTime();
    if (target < this.ms) throw new Error("FakeClock cannot go backwards");
    this.advance(target - this.ms);
  }
}
