// The cleanup pass (design 08-cleanup). Every discovered handler lists this host's resources; each resource goes
// only when its item is CLOSED, `cleanup.keep_hours` passed since the close, nothing of the item is in use (the
// in-use guard below, shared by every handler) and its handler's own check passes. Each removal writes one line to
// the item's history; a failed one is logged and left for the next pass. This file names no resource kind.

import { closeChange } from "../core/notifications.js";
import { errorText, type Logger } from "../core/log.js";
import type { Run, Timestamp, WorkItemId } from "../core/types.js";
import type { FactoryStore } from "../interfaces/factory-store.js";
import type { CleanupConfig } from "./config.js";
import { cleanupHandlers } from "./discover.js";
import type { CleanupEnv, CleanupHandlerDescriptor, Resource } from "./handler.js";

/** What the pass reads and writes in the store: items, their runs and history, and the history line. */
export type CleanupStore = Pick<FactoryStore, "getWorkItem" | "listRuns" | "listStateChanges" | "listWorkItemsWhere" | "transition">;

export interface CleanerDeps {
  store: CleanupStore;
  env: CleanupEnv;
  config: CleanupConfig;
  clock: { now(): Date };
  log: Logger;
  /** This host's id: the daily sweep's lease and day mark are per host, as each host sweeps the folders it made. */
  host: string;
  /** Absent: the discovered handlers. */
  handlers?: () => Promise<readonly CleanupHandlerDescriptor[]>;
}

/** A resource and whether it goes: `keep` is the reason it stays, null when it goes. */
export interface Decision {
  readonly resource: Resource;
  readonly handler: CleanupHandlerDescriptor | null;
  /** The resource's item (a child's is its parent's), or null. */
  readonly item_id: string | null;
  readonly keep: string | null;
}

export interface PassResult {
  readonly removed: { resource: Resource; bytes: number | null }[];
  readonly kept: { resource: Resource; reason: string }[];
  readonly failed: { resource: Resource; error: string }[];
}

/** The history line's actor and reason. */
export const CLEANUP_ACTOR = "system:cleanup";
export const CLEANUP_REASON = "cleanup_removed";
const HOUR_MS = 3_600_000;
/** Closes the close step looks back over past keep_hours; an older one is the daily sweep's. */
const CLOSE_WINDOW_MS = 24 * HOUR_MS;
/** Closed items the close step reads per poll at most. */
const CLOSE_LIMIT = 500;
/** Tries of the history line when another writer moved the item's version first. */
const HISTORY_TRIES = 3;

export class Cleaner {
  /**
   * Items the close step handled, and when a not-yet-due one is next due, by id: a cache only, so a later poll reads
   * nothing for them. Not shared state: a restart reads them again, and the daily sweep covers what it skips.
   */
  private readonly handled = new Set<string>();
  private readonly dueAt = new Map<string, number>();

  constructor(private readonly d: CleanerDeps) {}

  get host(): string {
    return this.d.host;
  }

  enabled(): boolean {
    return this.d.config.enabled;
  }

  /** Every listed resource with its decision; `scope`: only resources of those items. Changes nothing. */
  async plan(scope?: ReadonlySet<string>): Promise<Decision[]> {
    const handlers = await (this.d.handlers ?? cleanupHandlers)();
    const listed: Resource[] = [];
    for (const h of handlers) {
      try {
        listed.push(...(await h.list(this.d.env)));
      } catch (err) {
        this.d.log.error("cleanup list failed", { handler: h.name, error: errorText(err) });
      }
    }
    const now = this.d.clock.now().getTime();
    const guards = new Map<string, Promise<string | null>>();
    const guard = (id: string) => guards.get(id) ?? guards.set(id, this.inUse(id as WorkItemId, now)).get(id)!;
    const byKey = new Map<string, Decision>();
    for (const r of listed.filter((x) => x.parent === undefined)) {
      if (scope && (r.item_id === null || !scope.has(r.item_id))) continue;
      const handler = handlers.find((h) => h.accepts(r)) ?? null;
      let keep = handler ? null : "no handler accepts it";
      if (keep === null && r.item_id === null) keep = r.idle_since === undefined ? r.unowned ?? "it belongs to no work item" : this.idle(r.idle_since, now);
      else if (keep === null) keep = await guard(r.item_id!);
      if (keep === null) keep = await handler!.keep(r, this.d.env).catch((err: unknown) => `its check failed: ${errorText(err)}`);
      byKey.set(r.key, { resource: r, handler, item_id: r.item_id, keep });
    }
    const children: Decision[] = [];
    for (const r of listed.filter((x) => x.parent !== undefined)) {
      const parent = byKey.get(r.parent!);
      if (scope && !parent) continue;
      const handler = handlers.find((h) => h.accepts(r)) ?? null;
      let keep = handler ? null : "no handler accepts it";
      if (keep === null && !parent) keep = r.unowned ?? "what it lives in is not removable";
      if (keep === null && parent!.keep !== null) keep = `${r.unowned ?? "what it lives in stays"}: ${parent!.resource.label} stays (${parent!.keep})`;
      if (keep === null) keep = await handler!.keep(r, this.d.env).catch((err: unknown) => `its check failed: ${errorText(err)}`);
      children.push({ resource: r, handler, item_id: parent?.item_id ?? null, keep });
    }
    const order = (x: Decision) => x.handler?.order ?? Number.MAX_SAFE_INTEGER;
    return [...children, ...byKey.values()].sort((a, b) => order(a) - order(b));
  }

  /** One pass over every resource (`dryRun`: decide only). Off (`cleanup.enabled` false): nothing, all empty. */
  async sweep(o: { dryRun?: boolean } = {}): Promise<PassResult> {
    if (!this.enabled()) return { removed: [], kept: [], failed: [] };
    return this.apply(await this.plan(), o.dryRun === true);
  }

  /**
   * The close callback, each poll interval: the items closed within the last keep_hours plus a day whose keep
   * passed. None due: no resource is listed. Each due item is handled once per process; a failure waits for the sweep.
   */
  async closeStep(): Promise<PassResult | null> {
    if (!this.enabled()) return null;
    const now = this.d.clock.now().getTime();
    const keepMs = this.d.config.keep_hours * HOUR_MS;
    const since = new Date(now - keepMs - CLOSE_WINDOW_MS).toISOString() as Timestamp;
    const due = new Set<string>();
    for (const item of await this.d.store.listWorkItemsWhere({ stage: "CLOSED", updated_since: since, limit: CLOSE_LIMIT })) {
      if (this.handled.has(item.id) || (this.dueAt.get(item.id) ?? 0) > now) continue;
      const at = Date.parse(await this.closedAt(item.id, item.updated_at)) + keepMs;
      if (at <= now) due.add(item.id);
      else this.dueAt.set(item.id, at);
    }
    if (due.size === 0) return null;
    const result = await this.apply(await this.plan(due), false);
    for (const id of due) {
      this.handled.add(id);
      this.dueAt.delete(id);
    }
    return result;
  }

  private async apply(plan: readonly Decision[], dryRun: boolean): Promise<PassResult> {
    const out: PassResult = { removed: [], kept: [], failed: [] };
    for (const p of plan) {
      if (p.keep !== null) out.kept.push({ resource: p.resource, reason: p.keep });
      else if (dryRun) out.removed.push({ resource: p.resource, bytes: null });
      else await this.remove(p, out);
    }
    if (!dryRun && (out.removed.length > 0 || out.failed.length > 0)) {
      this.d.log.info("cleanup pass", { removed: out.removed.length, failed: out.failed.length, kept: out.kept.length });
    }
    return out;
  }

  private async remove(p: Decision, out: PassResult): Promise<void> {
    let bytes: number | null;
    try {
      ({ bytes } = await p.handler!.cleanup(p.resource, this.d.env));
    } catch (err) {
      this.d.log.error("cleanup removal failed", { resource: p.resource.label, item_id: p.item_id, error: errorText(err) });
      out.failed.push({ resource: p.resource, error: errorText(err) });
      return;
    }
    out.removed.push({ resource: p.resource, bytes });
    if (p.item_id) await this.record(p.item_id as WorkItemId, p.resource, bytes).catch((err: unknown) => {
      this.d.log.error("cleanup history line failed", { resource: p.resource.label, item_id: p.item_id, error: errorText(err) });
    });
  }

  /** One history line on the item: what went and, when it has a size, the bytes freed. */
  private async record(id: WorkItemId, r: Resource, bytes: number | null): Promise<void> {
    const detail = { removed: r.label, kind: r.kind, ...(bytes !== null ? { bytes_freed: bytes } : {}) };
    for (let i = 0; i < HISTORY_TRIES; i++) {
      const item = await this.d.store.getWorkItem(id);
      if (!item) return;
      const res = await this.d.store.transition({
        id, expected_version: item.version, patch: {}, actor: { kind: "system", id: CLEANUP_ACTOR }, reason: CLEANUP_REASON, detail,
      });
      if (res.ok || res.reason !== "version_conflict") return;
    }
  }

  /** Why a resource of no item last used at `since` stays at `now`: unused less than keep_hours, else null. */
  private idle(since: number, now: number): string | null {
    const until = since + this.d.config.keep_hours * HOUR_MS;
    return until > now ? `used less than cleanup.keep_hours ago; kept until ${new Date(until).toISOString()}` : null;
  }

  /** When the item closed: its latest change to CLOSED, else `fallback` (its updated_at). */
  private async closedAt(id: WorkItemId, fallback: Timestamp): Promise<Timestamp> {
    return closeChange(await this.d.store.listStateChanges(id))?.at ?? fallback;
  }

  /**
   * The in-use guard, shared by every handler: why the item's resources must stay at `now`, or null. Not closed,
   * closed less than keep_hours ago, an open interactive session, a running run, or a run holding a lease.
   */
  private async inUse(id: WorkItemId, now: number): Promise<string | null> {
    const item = await this.d.store.getWorkItem(id);
    if (!item) return `its item ${id} is not in the store`;
    if (item.stage !== "CLOSED") return `its item ${id} is not closed (${item.stage})`;
    const until = Date.parse(await this.closedAt(id, item.updated_at)) + this.d.config.keep_hours * HOUR_MS;
    if (until > now) return `its item ${id} closed less than cleanup.keep_hours ago; kept until ${new Date(until).toISOString()}`;
    const runs = await this.d.store.listRuns(id);
    const open = (r: Run) => r.status === "queued" || r.status === "running";
    const session = runs.find((r) => r.kind === "interactive" && open(r));
    if (session) return `an interactive session of item ${id} is open (run ${session.id})`;
    const running = runs.find((r) => r.status === "running");
    if (running) return `run ${running.id} of item ${id} is running`;
    const leased = runs.find((r) => r.lease !== null && Date.parse(r.lease.expires_at) > now);
    if (leased) return `run ${leased.id} of item ${id} holds a lease until ${leased.lease!.expires_at}`;
    return null;
  }
}
