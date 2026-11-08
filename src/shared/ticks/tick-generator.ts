// Time enters a component only through the TickGenerator it embeds (RFC 0015 §5.3). Handlers and state
// machines never read a clock: they move on a message, or on a tick. Ticks never go on the bus.

export interface Tick {
  readonly schedule: string;
  /** ISO-8601 UTC. */
  readonly now: string;
  /** floor(now / period): part of the idempotency key of what a tick decides, so a repeated slot is a no-op. */
  readonly slot: number;
}

export type TickHandler = (tick: Tick) => Promise<void>;

export interface TickGenerator {
  /** Registers a schedule. Each schedule runs one tick at a time; a slow tick delays the next, never overlaps it. */
  schedule(name: string, periodMs: number, onTick: TickHandler): void;
  /** Starts ticking until `signal` aborts. Resolves once every schedule has stopped. */
  run(signal: AbortSignal): Promise<void>;
}

export function tickAt(schedule: string, periodMs: number, ms: number): Tick {
  return { schedule, now: new Date(ms).toISOString(), slot: Math.floor(ms / periodMs) };
}
