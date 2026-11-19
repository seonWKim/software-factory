// A per-process snapshot of a slow read (the Health checks, the Plugins discovery): the UI routes answer from the
// last result and its as-of time at once, and a refresh runs beside them (design 09-health, 09-dashboard-settings,
// 2026-11-19). In-process on purpose: it is a cache of a read-only probe for this process's own page, never state
// another worker needs.
//
// The first read waits for the first refresh only. After that a read never waits: it returns the last result. While
// started, a refresh runs every `interval_ms` if a read happened in the last `IDLE_MS`; the first read after that
// idle window returns the last result and starts a refresh. A refresh that throws keeps the last good result and
// its time; with no good result yet, the first read gets the error.

/** The part of a Clock the snapshot uses (structural, so any Clock fits). */
interface Clock {
  now(): Date;
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
}

/** No refresh runs unless a read happened within this time: an idle owner's page costs no remote call. */
export const IDLE_MS = 10 * 60_000;

export interface Snapshot<T> {
  value: T;
  /** When the refresh that produced `value` finished. */
  as_of: Date;
}

export class BackgroundSnapshot<T> {
  private last: Snapshot<T> | null = null;
  private inflight: Promise<Snapshot<T>> | null = null;
  private last_read: number | null = null;
  private loop: AbortController | null = null;

  constructor(
    private readonly refresh: () => Promise<T>,
    private readonly clock: Clock,
    private readonly interval_ms: number,
    private readonly idle_ms = IDLE_MS,
  ) {}

  /** One refresh at a time: a caller during a run shares it. A failure leaves the last good result. */
  private run(): Promise<Snapshot<T>> {
    this.inflight ??= this.refresh()
      .then((value) => (this.last = { value, as_of: this.clock.now() }))
      .finally(() => {
        this.inflight = null;
      });
    return this.inflight;
  }

  /** Starts a refresh nobody waits for. */
  refreshInBackground(): void {
    this.run().catch(() => undefined);
  }

  /** The last result; only the first read (no result yet) waits for a refresh, and gets its error if it fails. */
  async read(): Promise<Snapshot<T>> {
    const now = this.clock.now().getTime();
    const idle = this.last_read === null || now - this.last_read >= this.idle_ms;
    this.last_read = now;
    if (this.last === null) return this.run();
    if (idle) this.refreshInBackground();
    return this.last;
  }

  /** Starts the interval; a second start does nothing. */
  start(): void {
    if (this.loop) return;
    const loop = (this.loop = new AbortController());
    void (async () => {
      while (!loop.signal.aborted) {
        try {
          await this.clock.sleep(this.interval_ms, loop.signal);
        } catch {
          return;
        }
        if (this.last_read !== null && this.clock.now().getTime() - this.last_read < this.idle_ms) this.refreshInBackground();
      }
    })();
  }

  /** Stops the interval. A refresh already running finishes; none starts from the timer. */
  stop(): void {
    this.loop?.abort();
    this.loop = null;
  }
}
