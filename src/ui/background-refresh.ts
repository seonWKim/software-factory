// A per-process stored result of a slow read (the Health checks, the Plugins listing): the UI routes answer from it
// at once and never wait for a refresh (design 09-health, 09-dashboard-settings, 2026-11-19, wi_926cad13). In-process
// on purpose: it is a cache of a read-only probe for this process's own page, never state another worker needs.
//
// A read returns the stored result and its as-of time, or `pending` before the first refresh ends. It starts a
// refresh only when the stored result is older than `interval_ms` (or there is none) or `markStale()` was called;
// there is no timer, so with no reads and no writes nothing runs. One refresh at a time per snapshot. A refresh that
// throws keeps the last good result and its time; with none, reads answer `failed` until the next refresh is due.

/** The part of a Clock the snapshot uses (structural, so any Clock fits). */
interface Clock {
  now(): Date;
}

/** What a read answers. `refreshing`: a refresh is running, so a newer result is on its way. */
export type StoredRead<T> =
  | { state: "ready"; value: T; /** When the refresh that produced `value` finished. */ as_of: Date; refreshing: boolean }
  | { state: "pending" }
  | { state: "failed"; error: unknown; /** When the failed refresh finished. */ at: Date };

export class BackgroundSnapshot<T> {
  private last: { value: T; as_of: Date } | null = null;
  /** The last refresh's failure, cleared by a success. */
  private error: { error: unknown; at: Date } | null = null;
  private inflight: Promise<void> | null = null;
  private stale = false;

  constructor(
    private readonly refresh: () => Promise<T>,
    private readonly clock: Clock,
    private readonly interval_ms: number,
  ) {}

  /** Older than the interval, never refreshed, or marked stale. Measured from the last refresh's end, good or failed. */
  private due(): boolean {
    if (this.stale) return true;
    const ended = Math.max(this.last?.as_of.getTime() ?? -Infinity, this.error?.at.getTime() ?? -Infinity);
    return this.clock.now().getTime() - ended >= this.interval_ms;
  }

  /** Starts a refresh nobody waits for; while one runs, does nothing (single flight). A failure keeps the last result. */
  refreshInBackground(): void {
    if (this.inflight) return;
    this.stale = false;
    this.inflight = this.refresh()
      .then(
        (value) => {
          this.last = { value, as_of: this.clock.now() };
          this.error = null;
        },
        (error: unknown) => {
          this.error = { error, at: this.clock.now() };
        },
      )
      .finally(() => {
        this.inflight = null;
      });
  }

  /** The next read starts a refresh (after a write). A write during a running refresh makes one more run after it. */
  markStale(): void {
    this.stale = true;
  }

  /** The stored result at once; starts a refresh when it is due. Never waits and never throws. */
  read(): StoredRead<T> {
    if (!this.inflight && this.due()) this.refreshInBackground();
    if (this.last) return { state: "ready", value: this.last.value, as_of: this.last.as_of, refreshing: this.inflight !== null || this.stale };
    if (this.inflight || !this.error) return { state: "pending" };
    return { state: "failed", error: this.error.error, at: this.error.at };
  }
}
