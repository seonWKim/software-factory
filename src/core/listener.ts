import type { FactoryConfig } from "./config.js";
import type { LogFields, Logger } from "./log.js";
import { retryDelayMs } from "./policy.js";
import type { Clock } from "../interfaces/clock.js";
import type { FactoryStore } from "../interfaces/factory-store.js";
import type { PushedEvent, StreamSource } from "../interfaces/source-adapter.js";

export interface ListenerDeps {
  store: FactoryStore;
  source: StreamSource;
  clock: Clock;
  /** The listener lease reuses the run lease timings: renew every heartbeat_ms, expire after lease_ms. */
  config: Pick<FactoryConfig, "lease_ms" | "heartbeat_ms">;
  log: Logger;
  /** This replica's id, stored as the lease owner. */
  owner: string;
  /** Reconnect backoff: base_ms, doubling per failed connection, capped at max_ms. Default 1 s to 60 s. */
  reconnect?: { base_ms: number; max_ms: number };
}

export const RECONNECT_DEFAULTS = { base_ms: 1_000, max_ms: 60_000 } as const;

type State = "waiting" | "leased" | "connected" | "disconnected" | "lease_lost" | "store_failed" | "stopped";

/** Why one connection ended. */
type Ended = { kind: "closed"; events: number; error?: unknown } | { kind: "lease_lost" };

/**
 * Stream intake (docs/architecture.md, Intake). Across all replicas, only the holder of the source's
 * listener lease subscribes. Each pushed event is written to the store inbox first; ack() follows only once
 * that write committed (a duplicate dedupe_key is stored already, so it is acked too). A failed write is
 * not acked, and the source redelivers it on a later connection. The controller reads the inbox, never the
 * stream, so any replica handles the events.
 *
 * The only in-process state is the current lease token and the log state, neither of which another
 * replica needs: the lease row in the store decides who listens.
 */
export class Listener {
  private state: State | null = null;

  constructor(private readonly d: ListenerDeps) {}

  /** Runs until `signal` aborts, then releases the lease if it still holds it. */
  async run(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      const token = await this.acquire();
      if (token === null) {
        await this.sleep(this.d.config.heartbeat_ms, signal);
        continue;
      }
      await this.hold(token, signal);
    }
    this.enter("stopped", "info", "listener stopped");
  }

  /** The lease token if this replica took the lease, else null. */
  private async acquire(): Promise<number | null> {
    try {
      const r = await this.d.store.acquireListenerLease(this.d.source.type, this.d.owner, this.d.config.lease_ms);
      if (r.ok) {
        this.enter("leased", "info", "listener lease taken", { token: r.lease.token });
        return r.lease.token;
      }
      this.enter("waiting", "info", "listener waiting: another replica holds the lease", { holder: r.holder?.owner ?? null });
    } catch (err) {
      this.enter("store_failed", "warn", "listener lease check failed", { error: message(err) });
    }
    return null;
  }

  /** Holds the lease: renews it in the background and keeps a connection open, reconnecting with backoff. */
  private async hold(token: number, outer: AbortSignal): Promise<void> {
    const held = new AbortController();
    const stop = () => held.abort();
    outer.addEventListener("abort", stop, { once: true });
    let lost = false;
    const loseLease = (fields: LogFields) => {
      if (lost) return;
      lost = true;
      this.enter("lease_lost", "warn", "listener lease lost; stream closed", { token, ...fields });
      held.abort();
    };
    const renewing = this.renew(token, held.signal, loseLease);
    const { base_ms, max_ms } = this.d.reconnect ?? RECONNECT_DEFAULTS;
    let failures = 0;
    try {
      while (!held.signal.aborted) {
        const ended = await this.connect(token, held.signal);
        if (ended.kind === "lease_lost") {
          loseLease({ reason: "inbox_write_refused" });
          break;
        }
        if (held.signal.aborted) break;
        // A connection that stored something was healthy: the backoff starts over.
        failures = ended.events > 0 ? 1 : failures + 1;
        this.enter("disconnected", "warn", "stream disconnected; reconnecting with backoff", {
          error: ended.error === undefined ? null : message(ended.error),
        });
        await this.sleep(retryDelayMs(failures, base_ms, max_ms), held.signal);
      }
    } finally {
      held.abort();
      outer.removeEventListener("abort", stop);
      await renewing;
      if (!lost) {
        // Shutting down: hand the lease over now instead of after lease_ms.
        await this.d.store.releaseListenerLease(this.d.source.type, token).catch(() => undefined);
      }
    }
  }

  /**
   * Renews every heartbeat_ms. A refused renew means another replica took the lease. A store failure is
   * retried, but once lease_ms has passed since the last good renew the lease is treated as lost, so this
   * replica stops listening before another one can take over (no two connections at once).
   */
  private async renew(token: number, signal: AbortSignal, loseLease: (f: LogFields) => void): Promise<void> {
    const { lease_ms, heartbeat_ms } = this.d.config;
    let lastOk = this.d.clock.now().getTime();
    while (!signal.aborted) {
      await this.sleep(heartbeat_ms, signal);
      if (signal.aborted) return;
      try {
        const r = await this.d.store.renewListenerLease(this.d.source.type, token, lease_ms);
        if (!r.ok) return loseLease({ reason: "renew_refused", holder: r.holder?.owner ?? null });
        lastOk = this.d.clock.now().getTime();
      } catch (err) {
        if (this.d.clock.now().getTime() - lastOk >= lease_ms) {
          return loseLease({ reason: "renew_failed", error: message(err) });
        }
      }
    }
  }

  /** One connection: store, then ack, each event until the stream ends, fails, or the lease goes. */
  private async connect(token: number, signal: AbortSignal): Promise<Ended> {
    let events = 0;
    let iterator: AsyncIterator<PushedEvent> | null = null;
    // Stops waiting on a source that does not end its stream promptly when the signal aborts.
    let onAbort = () => {};
    const aborted = new Promise<IteratorResult<PushedEvent>>((resolve) => {
      onAbort = () => resolve({ done: true, value: undefined });
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
    });
    try {
      iterator = this.d.source.subscribe(signal)[Symbol.asyncIterator]();
      while (true) {
        const next = await Promise.race([iterator.next(), aborted]);
        if (next.done) return { kind: "closed", events };
        const pushed = next.value;
        const r = await this.d.store.appendInbox({
          source_type: this.d.source.type,
          dedupe_key: pushed.dedupe_key,
          event: pushed.event,
          lease_token: token,
        });
        if (!r.ok) return { kind: "lease_lost" };
        // The write committed (or was there already): only now may the source forget the event.
        await pushed.ack();
        // Connected means: this connection got an event through to the inbox. Logged on the change only,
        // so a connection that fails before that (e.g. the store is down) does not log on every retry.
        if (events++ === 0) this.enter("connected", "info", "stream connected");
      }
    } catch (err) {
      // A failed inbox write lands here too: no ack, the connection is dropped, the source redelivers.
      return { kind: "closed", events, error: err };
    } finally {
      signal.removeEventListener("abort", onAbort);
      if (iterator?.return) Promise.resolve(iterator.return()).catch(() => undefined);
    }
  }

  /** Logs only when the state changes, so a retry loop does not log every attempt. */
  private enter(state: State, level: "info" | "warn", msg: string, fields: LogFields = {}): void {
    if (this.state === state) return;
    this.state = state;
    this.d.log[level](msg, { source_type: this.d.source.type, owner: this.d.owner, ...fields });
  }

  private sleep(ms: number, signal: AbortSignal): Promise<void> {
    return this.d.clock.sleep(ms, signal).catch(() => undefined);
  }
}

function message(err: unknown): string {
  return err instanceof Error ? err.message.slice(0, 300) : "unknown";
}
