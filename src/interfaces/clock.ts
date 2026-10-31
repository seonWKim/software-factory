// Injected wherever time matters (leases, timestamps, polling). Prod: SystemClock. Tests: FakeClock.

export interface Clock {
  now(): Date;
  /** Resolves after `ms` of this clock's time, or rejects with the signal's reason. */
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
}
