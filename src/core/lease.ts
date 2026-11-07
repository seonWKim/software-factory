import type { FactoryConfig } from "./config.js";
import type { LogFields, Logger } from "./log.js";
import type { Clock } from "../interfaces/clock.js";
import type { FactoryStore, ListenerLease, SyncFence, SyncLease } from "../interfaces/factory-store.js";
import type { SourceType } from "./types.js";

/**
 * Store leases, one copy for every lease a replica holds for a while (docs/architecture.md, Intake; design
 * 05-coordination, sync lease): the stream listener's lease and the sync lease. A lease row in the store decides
 * the holder; the token it hands out fences the holder's writes. The holder renews every heartbeat_ms; a refused
 * renew means another replica took it; a store failure is retried, but once lease_ms has passed since the last
 * good renew the lease counts as lost, so this replica stops before another one can take over.
 */

/** One take or renew of a lease row, whatever table it lives in. `holder`: the current owner, null when none. */
export type LeaseAnswer = { ok: true; token: number } | { ok: false; holder: string | null; expires_at: string | null };

/** The store calls behind one lease. */
export interface LeaseOps {
  acquire(owner: string, lease_ms: number): Promise<LeaseAnswer>;
  renew(token: number, lease_ms: number): Promise<LeaseAnswer>;
  release(token: number): Promise<void>;
}

/** What one renew means for the holder. */
export type Renewal = { ok: true } | { ok: false; fields: LogFields };

type Row = ListenerLease | SyncLease;
type Result = { ok: true; lease: Row } | { ok: false; holder: Row | null };

function answer(r: Result): LeaseAnswer {
  return r.ok ? { ok: true, token: r.lease.token } : { ok: false, holder: r.holder?.owner ?? null, expires_at: r.holder?.expires_at ?? null };
}

/** The stream listener's lease: one per source type, in `listener_leases`. */
export function listenerLeaseOps(store: FactoryStore, type: SourceType): LeaseOps {
  return {
    acquire: async (owner, ms) => answer(await store.acquireListenerLease(type, owner, ms)),
    renew: async (token, ms) => answer(await store.renewListenerLease(type, token, ms)),
    release: (token) => store.releaseListenerLease(type, token),
  };
}

/** The sync lease `name`, in `sync_leases`. */
export function syncLeaseOps(store: FactoryStore, name: string): LeaseOps {
  return {
    acquire: async (owner, ms) => answer(await store.acquireSyncLease(name, owner, ms)),
    renew: async (token, ms) => answer(await store.renewSyncLease(name, token, ms)),
    release: (token) => store.releaseSyncLease(name, token),
  };
}

/** The sync lease of source type `type` in project `project`: `sync:<type>:<project>`. */
export function syncLeaseName(type: SourceType, project: string): string {
  return `sync:${type}:${project}`;
}

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message.slice(0, 300) : "unknown";
}

/**
 * One lease as one replica holds it. The only in-process state is the token and the time of the last good renew,
 * which no other replica needs. `config` is read on every call, so a lease_ms or heartbeat_ms change applies next.
 */
export class StoreLease {
  private token: number | null = null;
  private lastOk = 0;

  constructor(
    private readonly ops: LeaseOps,
    private readonly clock: Clock,
    private readonly config: Pick<FactoryConfig, "lease_ms" | "heartbeat_ms">,
    readonly owner: string,
  ) {}

  /** The token this replica holds, or null. */
  get held(): number | null {
    return this.token;
  }

  /** Takes the lease if it is free (or already this owner's). Store errors are thrown. */
  async acquire(): Promise<LeaseAnswer> {
    const r = await this.ops.acquire(this.owner, this.config.lease_ms);
    this.token = r.ok ? r.token : null;
    if (r.ok) this.lastOk = this.clock.now().getTime();
    return r;
  }

  /**
   * One renew of the held lease. Refused: lost (another replica took it). A store failure: still held until
   * lease_ms has passed since the last good renew, then lost.
   */
  async renew(): Promise<Renewal> {
    const token = this.token;
    if (token === null) return { ok: false, fields: { reason: "not_held" } };
    try {
      const r = await this.ops.renew(token, this.config.lease_ms);
      if (r.ok) {
        this.lastOk = this.clock.now().getTime();
        return { ok: true };
      }
      this.token = null;
      return { ok: false, fields: { reason: "renew_refused", holder: r.holder } };
    } catch (err) {
      if (this.clock.now().getTime() - this.lastOk < this.config.lease_ms) return { ok: true };
      this.token = null;
      return { ok: false, fields: { reason: "renew_failed", error: errorMessage(err) } };
    }
  }

  /** Hands the lease over now instead of after lease_ms. Best effort: a failure leaves it to expire. */
  async release(): Promise<void> {
    const token = this.token;
    this.token = null;
    if (token !== null) await this.ops.release(token).catch(() => undefined);
  }

  /** Forgets the token without a store call: the holder learned it is no longer its (e.g. a refused write). */
  drop(): void {
    this.token = null;
  }
}

/** What a tick-driven holder knows: off (no lease needed), this replica holds `fence`, or another replica does. */
export type SyncState = { kind: "held"; fence: SyncFence } | { kind: "other"; holder: string | null };

/**
 * A lease held from a periodic loop instead of a background renewer (the sync lease): each `tick` makes at most
 * one store call per heartbeat_ms. The holder renews; any other replica tries to take it once the holder's
 * lease has expired or heartbeat_ms has passed, so a takeover comes within lease_ms of the holder's last renew.
 * Logs on a change of holder only, naming the lease by `label` (the name holds the project key, which logs never show).
 */
export class TickLease {
  private readonly lease: StoreLease;
  private lastCall = -Infinity;
  /** When the last holder seen elsewhere expires, ms; a take is tried at once from then. */
  private otherUntil = Infinity;
  private state: SyncState | null = null;
  /** The holder another replica's lease names, as of the last refused take. */
  private holder: string | null = null;

  constructor(
    private readonly name: string,
    ops: LeaseOps,
    private readonly clock: Clock,
    private readonly config: Pick<FactoryConfig, "lease_ms" | "heartbeat_ms">,
    owner: string,
    private readonly log: Logger,
    private readonly label: string,
  ) {
    this.lease = new StoreLease(ops, clock, config, owner);
  }

  /** The state as of the last tick; null before the first. */
  get current(): SyncState | null {
    return this.state;
  }

  async tick(): Promise<SyncState> {
    const now = this.clock.now().getTime();
    const due = now - this.lastCall >= this.config.heartbeat_ms || (this.lease.held === null && now >= this.otherUntil);
    if (this.state && !due) return this.state;
    this.lastCall = now;
    if (this.lease.held !== null) {
      const r = await this.lease.renew();
      if (!r.ok) this.log.warn("sync lease lost", { sync: this.label, owner: this.lease.owner, ...r.fields });
    }
    if (this.lease.held === null) await this.take();
    const token = this.lease.held;
    return this.enter(token !== null ? { kind: "held", fence: { name: this.name, token } } : { kind: "other", holder: this.holder });
  }

  /** Releases the lease when this replica holds it. */
  async release(): Promise<void> {
    await this.lease.release();
    this.state = null;
  }

  /** A fenced write was refused: the lease is gone; the next tick tries again. */
  lost(): void {
    if (this.lease.held === null) return;
    this.lease.drop();
    this.lastCall = -Infinity;
    this.log.warn("sync lease lost", { sync: this.label, owner: this.lease.owner, reason: "fenced_write_refused" });
    this.state = { kind: "other", holder: null };
  }

  private async take(): Promise<void> {
    try {
      const r = await this.lease.acquire();
      if (!r.ok) {
        this.holder = r.holder;
        this.otherUntil = r.expires_at ? Date.parse(r.expires_at) : Infinity;
      }
    } catch (err) {
      this.holder = null;
      this.otherUntil = Infinity;
      this.log.warn("sync lease check failed", { sync: this.label, error: errorMessage(err) });
    }
  }

  private enter(next: SyncState): SyncState {
    const prev = this.state;
    this.state = next;
    if (next.kind === "held" && (prev?.kind !== "held" || prev.fence.token !== next.fence.token)) {
      this.log.info("sync lease taken", { sync: this.label, owner: this.lease.owner, token: next.fence.token });
    } else if (next.kind === "other" && prev?.kind !== "other") {
      this.log.info("sync waiting: another replica holds the lease", { sync: this.label, holder: next.holder });
    }
    return next;
  }
}
