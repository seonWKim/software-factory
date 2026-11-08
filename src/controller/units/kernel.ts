// The controller units' shared kernel (RFC 0015 M5).

import { LiveSettings, type ProjectSettings, settingValues } from "../../core/settings.js";
import { LOCAL_SOURCE } from "../../core/local-merge.js";
import { type SourceRef, type SourceType, type WorkItem } from "../../core/types.js";
import type { Forge } from "../../interfaces/forge.js";
import type { SourceAdapter } from "../../interfaces/source-adapter.js";
import { type ControllerDeps, rateLimitWait } from "../../core/controller-deps.js";

/**
 * The sources a controller runs (design 2026-11-01): any number, no two of one type. PRs come from the forge,
 * so no source type is required (issue #273). Errors name `plugins.source`, the config key that lists them.
 */
function checkSources(d: Pick<ControllerDeps, "source" | "sources">): readonly SourceAdapter[] {
  if (d.source !== undefined && d.sources !== undefined) throw new Error("Controller takes `source` or `sources`, not both");
  // None is allowed (issue #282): items and commands live in the store, and messages wait in the outbox.
  const sources = d.sources ?? (d.source ? [d.source] : []);
  const seen = new Set<SourceType>();
  for (const s of sources) {
    if (seen.has(s.type)) {
      throw new Error(`plugins.source lists two sources of type "${s.type}"; each source type can be listed once`);
    }
    seen.add(s.type);
  }
  return sources;
}

type Store = ControllerDeps["store"];
type LogFields = NonNullable<Parameters<ControllerDeps["log"]["warn"]>[1]>;

/** The store reads a pure unit's `load` may use (RFC 0015 §6.2). Each a plain read: none writes or locks. */
const READS = ["getWorkItem", "listUnmirroredCliCommands", "listDeliveries", "listRuns", "listBudgetCheckpoints", "getTierHistory"] as const;

/** What a pure unit's `load` reads through: store reads and the egress scan (a check, no write). */
export type ControllerReader = Pick<Store, (typeof READS)[number]> & Pick<ControllerDeps["scanner"], "scan">;

/**
 * One write a pure unit decided, committed by the router through `Kernel.commit`, in decision order. Each is one
 * conditional or keyed store write, so committing a decision twice (a crash between two writes, another replica)
 * changes nothing the first commit did.
 */
export type ControllerWrite =
  | { kind: "log"; level: "info" | "warn"; msg: string; fields: LogFields }
  /** A thread entry, keyed on its marker (and its outbox row unless the thread is the item's own surface). */
  | { kind: "thread_entry"; entry: Parameters<Store["recordItemMessage"]>[0] }
  /** A CLI command whose mirror on its item's issue was delivered (or that has nothing to mirror). */
  | { kind: "cli_mirrored"; key: string }
  /** Runs whose lease expired, requeued after the retry backoff or failed at max_attempts (design §5 Restarts). */
  | { kind: "expire_leases"; max_attempts: number; backoff_ms: (attempt: number) => number };

type ThreadEntry = Extract<ControllerWrite, { kind: "thread_entry" }>["entry"];

/**
 * A factory message on an item's thread, with its outbox row unless the thread is the item's own surface (a local
 * item). It goes only to the item's own source: `target` (e.g. the item's PR) is used when it is of that source's
 * type, else the item's source.
 */
export function threadEntry(
  it: WorkItem, target: SourceRef, body: string, marker: string, link: NonNullable<ThreadEntry["delivery"]>["link_field"] = null,
): ThreadEntry {
  const type = it.source.type;
  const delivery = type === LOCAL_SOURCE ? null : { source_type: type, target: target.type === type ? target : it.source, link_field: link };
  return { work_item_id: it.id, marker, body, delivery };
}

/**
 * An item decision's one conditional write at the version it was decided on: a transition, or a budget checkpoint
 * in its place (the block and the checkpoint row in one transaction).
 */
export type ItemWrite =
  | { kind: "transition"; input: Parameters<Store["transition"]>[0] }
  | { kind: "budget_checkpoint"; input: Parameters<Store["openBudgetCheckpoint"]>[0] };

export type ItemCommitted = Awaited<ReturnType<Store["openBudgetCheckpoint"]>> | Awaited<ReturnType<Store["transition"]>>;

/**
 * What every unit shares (RFC 0015 M5): the legacy deps, the configured sources and forge, the live settings, and the
 * step guard. Built once per controller role; holds no decision.
 */
export class Kernel {
  /** The read-only accessors the router hands a pure unit's `load`. */
  readonly reader: ControllerReader;
  /** The configured sources, in config order. Fixed at construction; the same on every replica. */
  readonly sources: readonly SourceAdapter[];
  readonly byType: ReadonlyMap<SourceType, SourceAdapter>;
  /** Where PRs live, or null when config selects no forge. Fixed at construction. */
  readonly forge: Forge | null;
  /** The settings in effect: a cache of the config file plus the stored overrides, refreshed each tick. */
  readonly live: LiveSettings;

  constructor(readonly d: ControllerDeps) {
    this.sources = checkSources(d);
    this.byType = new Map(this.sources.map((s) => [s.type, s]));
    this.forge = d.forge ?? null;
    this.live = d.settings ?? LiveSettings.fixed(d.config);
    const store = d.store;
    // Bound one by one, so a unit holding the reader cannot reach the store's writes through it.
    // Looked up at call time: a startup check may build the kernel over a store stub that has none of them.
    const reads = Object.fromEntries(READS.map((m) => [m, (...a: unknown[]) => (store[m] as (...a: unknown[]) => unknown).apply(store, a)]));
    this.reader = { ...(reads as Pick<Store, (typeof READS)[number]>), scan: (channel, content) => d.scanner.scan(channel, content) };
  }

  /** A pure unit's decision, written in order (the router's commit). */
  async commit(decision: { readonly writes: readonly ControllerWrite[] }): Promise<void> {
    const { store, log } = this.d;
    for (const w of decision.writes) {
      if (w.kind === "log") log[w.level](w.msg, w.fields);
      else if (w.kind === "thread_entry") await store.recordItemMessage(w.entry);
      else if (w.kind === "cli_mirrored") await store.markCliCommandMirrored(w.key);
      else await this.expireLeases(w);
    }
  }

  /**
   * An item decision (RFC 0015 §7): the writes before it (each keyed, so a re-decide after a version conflict adds
   * nothing), then its conditional write. A version conflict comes back for the caller to decide again.
   */
  async commitItem(before: readonly ControllerWrite[], w: ItemWrite): Promise<ItemCommitted> {
    await this.commit({ writes: before });
    return w.kind === "transition" ? this.d.store.transition(w.input) : this.d.store.openBudgetCheckpoint(w.input);
  }

  /**
   * Each attempt the store's conditional update cut off gets its end line (issue #210): the run's last heartbeat is
   * its end. Only an expired lease is seen here, so the reason is always lease_expired.
   */
  private async expireLeases(w: Extract<ControllerWrite, { kind: "expire_leases" }>): Promise<void> {
    const log = this.d.log;
    const ids = await this.d.store.expireLeases(
      w.max_attempts,
      w.backoff_ms,
      (a) =>
        log.warn("run abandoned", {
          run_id: a.run_id,
          work_item_id: a.work_item_id,
          attempt: a.attempt,
          status: "abandoned",
          reason: "lease_expired",
          started_at: a.started_at,
          ended_at: a.ended_at,
          duration_ms: a.duration_ms,
        }),
    );
    for (const id of ids) log.warn("lease expired", { run_id: id });
  }

  /** The config with each settable key at its effective value as of the last refresh. */
  get cfg() {
    return this.live.config();
  }

  /** Now, in ms, from the injected clock: the role's ticks and the units' time-based decisions (no-clock follow-up). */
  nowMs(): number {
    return this.d.clock.now().getTime();
  }

  /** The configured repo's project key (design 2026-11-01): what every write and lookup uses. Never shown. */
  project(): string {
    return this.cfg.project.key;
  }

  /** The per-project gate settings of `project` (design 2026-11-01): the only way core reads them. */
  settings(project: string): ProjectSettings {
    return settingValues(project, this.cfg.settings, this.d.learned);
  }

  /** Whether this process can apply an item's transitions: it has the item's source adapter, or the item is local. */
  serves(type: SourceType): boolean {
    return type === LOCAL_SOURCE || this.byType.has(type);
  }

  /**
   * The adapter for `source`'s type. None configured (the source was removed from `plugins.source`): a
   * warning and null, so the call is skipped and the item keeps its state.
   */
  adapterFor(source: SourceRef, call: string): SourceAdapter | null {
    const adapter = this.byType.get(source.type);
    if (adapter) return adapter;
    // A local item's surface is the store itself: nothing to call, nothing to warn about.
    if (source.type === LOCAL_SOURCE) return null;
    this.d.log.warn("no source adapter for the item's source type; skipped", { source_type: source.type, source_id: source.id, call });
    return null;
  }

  async guard(what: string, fn: () => Promise<void>): Promise<void> {
    try {
      await fn();
    } catch (err) {
      // A forge call refused with no calls left is a wait for the reset, not a failure: the step runs again next
      // poll, and every other step (local work) goes on.
      const until = rateLimitWait(err);
      if (until) this.d.log.warn("waiting for the GitHub rate-limit reset", { step: what, until });
      else this.d.log.error("loop step failed", { step: what, error: err instanceof Error ? err.message.slice(0, 300) : "unknown" });
    }
  }
}
