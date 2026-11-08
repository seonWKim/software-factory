// The controller units' shared kernel (RFC 0015 M5).

import { LiveSettings, type ProjectSettings, settingValues } from "../../core/settings.js";
import { LOCAL_SOURCE } from "../../core/local-merge.js";
import { type SourceRef, type SourceType, type WorkItem } from "../../core/types.js";
import type { Forge } from "../../interfaces/forge.js";
import type { SourceAdapter } from "../../interfaces/source-adapter.js";
import { type ControllerDeps, rateLimitWait } from "../../core/controller-deps.js";
import type { NewAction } from "../../outbound/index.js";
import type { SqlDriver } from "../../state/index.js";

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
const READS = [
  "getWorkItem", "getWorkItemBySource", "getWorkItemByPr", "listWorkItems", "listWorkItemsWhere", "listLabelStates", "listUnmirroredCliCommands",
  "listDeliveries", "listRuns", "listUnacknowledgedRuns", "listStateChanges", "listBudgetCheckpoints", "listClaimDecisions", "getTierHistory",
  "getMergeCheck", "getAppCommandRequest", "listItemMessages", "listPendingBasePushes", "listSettingChanges", "getWorkItemByMergeSha",
  "listVerdicts", "listStandingRules",
] as const;

/**
 * What a unit's `load` reads through: store reads, the egress scan (a check, no write), the forge's PR check reads
 * (remote reads, no write; null when config selects no forge) and the command suggester.
 */
export type ControllerReader = Pick<Store, (typeof READS)[number]> & Pick<ControllerDeps["scanner"], "scan"> & {
  readonly forge: Pick<Forge, "prChecks" | "prCheckResults"> | null;
  /** The provider that suggests a command for a plain comment (a query, no state change); null when none is configured. */
  readonly llm: NonNullable<ControllerDeps["llm"]> | null;
  /**
   * The permission checks (RFC 0015 §8): a person's command by the auth plugin of its origin (`local`: the CLI and the
   * local UI) under its passport, and the controller's automatic steps under its service passport (null: no
   * Identity, allowed). A check: it changes no controller state; Identity audits each decision.
   */
  readonly auth: { readonly forge: ControllerDeps["auth"]; readonly local: ControllerDeps["auth"] | null; readonly service: ControllerDeps["service_auth"] | null };
};

/**
 * One write a pure unit decided, committed by the router through `Kernel.commit`, in decision order. Each is one
 * conditional or keyed store write, so committing a decision twice (a crash between two writes, another replica)
 * changes nothing the first commit did.
 */
export type ControllerWrite =
  | { kind: "log"; level: "info" | "warn"; msg: string; fields: LogFields }
  /** A thread entry, keyed on its marker (and its outbox row unless the thread is the item's own surface). */
  | { kind: "thread_entry"; entry: Parameters<Store["recordItemMessage"]>[0] }
  /** A delivered thread entry's URL onto its item's link field (DeliveryCompleted). */
  | { kind: "link_delivery"; seq: number }
  /** An app request (the status page) handled: applied, or refused with `refusal`. Conditional on it being unhandled. */
  | { kind: "app_request_handled"; seq: number; refusal: string | null }
  /** A standing rule turned on or off (`/standing`), keyed on its gate and tier. */
  | { kind: "standing_rule"; rule: Parameters<Store["putStandingRule"]>[0] }
  /** A standing approval proposed, keyed on its gate, tier and run. */
  | { kind: "standing_proposal"; proposal: Parameters<Store["recordStandingProposal"]>[0] }
  /** A CLI command whose mirror on its item's issue was delivered (or that has nothing to mirror). */
  | { kind: "cli_mirrored"; key: string }
  /**
   * An auto mode stop (design 03-risk): the `auto_stopped` alert, and only when its conditional insert created it, the
   * mode set back to manual at `level` by `actor`, so a second stop (a re-run, another replica) writes nothing.
   */
  | { kind: "stop_auto"; alert: Parameters<Store["recordAlert"]>[0]; dedupe_ms: number; level: string; actor: string; mode_change: number | null }
  /** Runs whose lease expired, requeued after the retry backoff or failed at max_attempts (design §5 Restarts). */
  | { kind: "expire_leases"; max_attempts: number; backoff_ms: (attempt: number) => number };

export type ThreadEntry = Extract<ControllerWrite, { kind: "thread_entry" }>["entry"];

/**
 * The one builder of a factory message on an item's thread (every unit's reply, the outbox unit's `post` included):
 * the entry, with its outbox row unless the thread is the item's own surface (a local item). It goes only to the
 * item's own source: `target` (e.g. the item's PR) is used when it is of that source's type, else the item's source.
 */
export function threadEntry(
  it: WorkItem, target: SourceRef, body: string, marker: string, link: NonNullable<ThreadEntry["delivery"]>["link_field"] = null,
): ThreadEntry {
  const type = it.source.type;
  const delivery = type === LOCAL_SOURCE ? null : { source_type: type, target: target.type === type ? target : it.source, link_field: link };
  return { work_item_id: it.id, marker, body, delivery };
}

/**
 * The URL of the item's thread entry with `marker`, once outbound delivered it, from the item's deliveries (read in
 * `load`); null before. Read before the entry's write: a first write has no delivery yet, so it is null then too.
 */
export function deliveredUrl(deliveries: readonly { marker: string; url: string | null }[], marker: string): string | null {
  return deliveries.find((d) => d.marker === marker)?.url ?? null;
}

/** The store's conditional item writes, by the kind of an `ItemWrite`. */
interface ItemWrites {
  transition: Store["transition"];
  /** A budget checkpoint in a transition's place: the block and the checkpoint row in one transaction. */
  budget_checkpoint: Store["openBudgetCheckpoint"];
  /** A person's answer to a budget checkpoint (`/approve`, `/reject`). */
  budget_answer: Store["answerBudgetCheckpoint"];
  /** A person's approval of an implement run held by coordination cost. */
  claim_approval: Store["approveClaimHold"];
  /** A verdict on the item's change (`/verdict`, or an implicit one). */
  verdict: Store["recordVerdict"];
}

/** An item decision's one conditional write, at the version it was decided on. */
export type ItemWrite = { [K in keyof ItemWrites]: { kind: K; input: Parameters<ItemWrites[K]>[0] } }[keyof ItemWrites];

export type ItemCommitted<W extends ItemWrite> = Awaited<ReturnType<ItemWrites[W["kind"]]>>;

/** How the units hand writes to outbound (RFC 0015 M7): the role binds them to the store's driver and its bus. */
export interface Deliveries {
  record(a: NewAction, now: string): Promise<void>;
  announce(now: string): Promise<number>;
}

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

  constructor(readonly d: ControllerDeps, private readonly deliveries: Deliveries) {
    this.sources = checkSources(d);
    this.byType = new Map(this.sources.map((s) => [s.type, s]));
    this.forge = d.forge ?? null;
    this.live = d.settings ?? LiveSettings.fixed(d.config);
    const store = d.store;
    // Bound one by one, so a unit holding the reader cannot reach the store's writes through it.
    // Looked up at call time: a startup check may build the kernel over a store stub that has none of them.
    const reads = Object.fromEntries(READS.map((m) => [m, (...a: unknown[]) => (store[m] as (...a: unknown[]) => unknown).apply(store, a)]));
    const forge = this.forge;
    this.reader = {
      ...(reads as Pick<Store, (typeof READS)[number]>),
      scan: (channel, content) => d.scanner.scan(channel, content),
      forge: forge && { prChecks: (pr) => forge.prChecks(pr), prCheckResults: (pr) => forge.prCheckResults(pr) },
      llm: d.llm ?? null,
      auth: { forge: d.auth, local: d.local_auth ?? null, service: d.service_auth ?? null },
    };
  }

  /** A pure unit's decision, written in order (the router's commit). */
  async commit(decision: { readonly writes: readonly ControllerWrite[] }): Promise<void> {
    const { store, log } = this.d;
    for (const w of decision.writes) {
      if (w.kind === "log") log[w.level](w.msg, w.fields);
      else if (w.kind === "thread_entry") await store.recordItemMessage(w.entry);
      else if (w.kind === "link_delivery") await store.linkDelivery(w.seq);
      else if (w.kind === "cli_mirrored") await store.markCliCommandMirrored(w.key);
      else if (w.kind === "stop_auto") await this.stopAuto(w);
      else if (w.kind === "app_request_handled") await store.markAppCommandRequest(w.seq, w.refusal);
      else if (w.kind === "standing_rule") await store.putStandingRule(w.rule);
      else if (w.kind === "standing_proposal") await store.recordStandingProposal(w.proposal);
      else await this.expireLeases(w);
    }
  }

  /**
   * An item decision (RFC 0015 §7): the writes before it (each keyed, so a re-decide after a version conflict adds
   * nothing), then its conditional write. A version conflict comes back for the caller to decide again.
   */
  async commitItem<W extends ItemWrite>(before: readonly ControllerWrite[], w: W): Promise<ItemCommitted<W>> {
    await this.commit({ writes: before });
    const store = this.d.store;
    const write = { transition: store.transition, budget_checkpoint: store.openBudgetCheckpoint, budget_answer: store.answerBudgetCheckpoint, claim_approval: store.approveClaimHold, verdict: store.recordVerdict }[w.kind];
    return (write as (input: W["input"]) => Promise<ItemCommitted<W>>).call(store, w.input);
  }

  /** `/link <code>`: the code's one conditional redeem (used once, counted on a failure), committed here. */
  redeemLinkCode(...a: Parameters<Store["redeemLinkCode"]>): ReturnType<Store["redeemLinkCode"]> {
    return this.d.store.redeemLinkCode(...a);
  }

  /** Whether this process runs an adapter of `type` (a synced source's own command is applied only there). */
  hasAdapter(type: SourceType): boolean {
    return this.byType.has(type);
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

  private async stopAuto(w: Extract<ControllerWrite, { kind: "stop_auto" }>): Promise<void> {
    const r = await this.d.store.recordAlert(w.alert, w.dedupe_ms);
    if (!r.created) return;
    await this.d.store.setSettingOverride({ key: "mode", project: w.level, value: JSON.stringify("manual"), actor: w.actor });
    await this.live.refresh();
    this.d.log.warn("auto mode stopped; the mode is manual again", { cause: w.alert.error_code, alert_id: r.alert.id, mode_change: w.mode_change });
  }

  /** Stores an intent for outbound (RFC 0015 M7); the outbox step announces it. */
  async recordAction(a: NewAction): Promise<void> {
    await this.deliveries.record(a, this.d.clock.now().toISOString());
  }

  /** Announces every stored intent as DeliveryRequested on the controller's bus; returns how many. */
  announce(): Promise<number> {
    return this.deliveries.announce(this.d.clock.now().toISOString());
  }

  /** PR `pr` as a comment or label target on the forge (a pure mapping, no call); null when config selects no forge. */
  prRef(pr: number): SourceRef | null {
    return this.forge?.prRef(pr) ?? null;
  }

  /** The config with each settable key at its effective value as of the last refresh. */
  get cfg() {
    return this.live.config();
  }

  /** Now, in ms, from the injected clock: the role's ticks and the units' time-based decisions (no-clock follow-up). */
  nowMs(): number {
    return this.d.clock.now().getTime();
  }

  /** The SQL driver under the store, for the controller's own actor tables (the merge queue); null for another store. */
  get db(): SqlDriver | null {
    return (this.d.store as { db?: SqlDriver }).db ?? null;
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
