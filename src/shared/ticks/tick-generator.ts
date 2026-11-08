// Time enters a component only through the TickGenerator it embeds (RFC 0015 §5.3). Handlers and state
// machines never read a clock: they move on a message, or on a tick. Ticks never go on the bus.

export interface Tick {
  readonly schedule: string;
  /** ISO-8601 UTC. */
  readonly now: string;
  /** floor(now / period): part of the idempotency key of what a tick decides, so a repeated slot is a no-op. */
  readonly slot: number;
  /**
   * ISO-8601 UTC: when this tick was due, one period after the previous tick ended. Absent on a schedule's first
   * tick, which fires at once. `now` later than `due` by far means the host slept (design §5 Host sleep).
   */
  readonly due?: string;
}

/** A fixed period, or one read before each wait (a live setting: a change applies from the next wait on). */
export type Period = number | (() => number);

export function periodOf(p: Period): number {
  return typeof p === "number" ? p : p();
}

export type TickHandler = (tick: Tick) => Promise<void>;

export interface TickGenerator {
  /** Registers a schedule. Each schedule runs one tick at a time; a slow tick delays the next, never overlaps it. */
  schedule(name: string, periodMs: Period, onTick: TickHandler): void;
  /** Starts ticking until `signal` aborts. Resolves once every schedule has stopped. */
  run(signal: AbortSignal): Promise<void>;
}

/** A time a generator can tick on in place of the system's: the process's injected clock, which tests move by hand. */
export interface TimeSource {
  now(): Date;
  /** Resolves after `ms` of this time, or rejects once the signal aborts. */
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
}

/**
 * A TickGenerator plugin (`plugins.ticks`, docs/plugins/tick-generator.md): makes one generator per component a
 * process runs. `onError` hears a schedule's failed tick; the schedule goes on. `time`, when given, is the time a
 * time-based generator reads and waits on (a plugin that does not read time ignores it).
 */
export interface TickSource {
  create(onError: (schedule: string, err: unknown) => void, time?: TimeSource): TickGenerator;
}

export function tickAt(schedule: string, periodMs: number, ms: number, dueMs?: number): Tick {
  const tick = { schedule, now: new Date(ms).toISOString(), slot: Math.floor(ms / periodMs) };
  return dueMs === undefined ? tick : { ...tick, due: new Date(dueMs).toISOString() };
}
