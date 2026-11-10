// The controller units' shared kernel (RFC 0015 M5).

import { LiveSettings, type ProjectSettings, modeOf, settingValues } from "../../core/settings.js";
import { LOCAL_SOURCE, threadDelivery } from "../../core/local-merge.js";
import { errorText } from "../../core/log.js";
import { type SourceRef, type SourceType, type WorkItem } from "../../core/types.js";
import type { Forge } from "../../interfaces/forge.js";
import type { SourceAdapter } from "../../interfaces/source-adapter.js";
import { type ControllerDeps, rateLimitWait } from "../../core/controller-deps.js";
import type { ActionRow, NewAction } from "../../outbound/index.js";
import type { Draft } from "../../shared/envelope.js";
import { CODE_ROOT, type SqlDriver, forgetOnFailure } from "../../state/index.js";
import { loadDescriptors } from "../../runtime/index.js";
import { type SignalDescriptor, uniqueSignals } from "../signals/signal.js";

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
  "getMergeCheck", "getAppCommandRequest", "listItemMessages", "listSettingChanges", "getWorkItemByMergeSha",
  "listVerdicts", "listStandingRules", "latestSignalAt", "listStateChangesSince", "listVerdictsSince", "listRunsFinishedSince",
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
  readonly auth: {
    readonly forge: ControllerDeps["auth"];
    readonly local: ControllerDeps["auth"] | null;
    /** Slack thread commands' plugin: `slack_auth`, else the local one (issue #498), else the forge's (issue #486). */
    readonly slack: ControllerDeps["auth"];
    readonly service: ControllerDeps["service_auth"] | null;
  };
  /** The discovered signal sources (`*.signal.ts`, design 11-signal-ledger), in path order. */
  signals(): Promise<readonly SignalDescriptor[]>;
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
   * mode set back to manual at `level` by `actor`. A second stop (a re-run, another replica) writes nothing once the
   * mode is manual; while it is still auto (the first stop's settings write failed) it sets manual.
   */
  | { kind: "stop_auto"; alert: Parameters<Store["recordAlert"]>[0]; dedupe_ms: number; project: string; level: string; actor: string; mode_change: number | null }
  /**
   * Runs whose lease expired, requeued after the retry backoff or failed at max_attempts (design §5 Restarts);
   * `then` decides the writes that follow from what expired (the reaper's log lines).
   */
  | { kind: "expire_leases"; max_attempts: number; backoff_ms: (attempt: number) => number; then: (r: ExpiredLeases) => readonly ControllerWrite[] }
  /** A message on the controller's bus (controller.events), delayed until `draft.not_before` when it is set. */
  | { kind: "emit"; draft: Draft }
  /** An intent for outbound (RFC 0015 M7): an action the outbox step announces; a keyed one is stored once. */
  | { kind: "intent"; action: NewAction }
  /** A signal ledger row, skipped when its (source, source_ref) is stored (design 11-signal-ledger). */
  | { kind: "signal"; signal: Parameters<Store["recordSignal"]>[0] };

/** What one lease expiry did: each attempt it cut off, and the runs it requeued or failed. */
export interface ExpiredLeases {
  readonly abandoned: readonly Parameters<NonNullable<Parameters<Store["expireLeases"]>[2]>>[0][];
  readonly run_ids: readonly string[];
}

export type ThreadEntry = Extract<ControllerWrite, { kind: "thread_entry" }>["entry"];

/**
 * The one builder of a factory message on an item's thread (every unit's reply, the outbox unit's `post` included):
 * the entry, with its outbox row unless the thread is the item's own surface (a local item). It goes only to the
 * item's own source: `target` (e.g. the item's PR) is used when it is of that source's type, else the item's source.
 */
export function threadEntry(
  it: WorkItem, target: SourceRef, body: string, marker: string, link: NonNullable<ThreadEntry["delivery"]>["link_field"] = null,
): ThreadEntry {
  return { work_item_id: it.id, marker, body, delivery: threadDelivery(it, target, link) };
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
  /** Publishes one message on the controller's bus, caused by the decision at `now`. */
  emit(d: Draft, now: string): Promise<void>;
  /** The action rows among delivered intent ids (DeliveryCompleted). */
  actions(intent_ids: readonly string[]): Promise<ActionRow[]>;
  /** The action stored under `key`, or null. */
  byKey(key: string): Promise<ActionRow | null>;
}

/** The hooks at the controller's points (RFC 0015 §8, M10): the role binds them to runHooks and the enabled names. */
export interface ControllerHooks {
  /** The `before_merge` hooks on the item about to land, after the guards; a veto, timeout or error refuses. */
  beforeMerge(subject: string, passport_id: string | null, at: string): Promise<{ allowed: true } | { allowed: false; reason: string }>;
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

  /** `signal_root`: where the signal sources are discovered (a test's fixture folder); the code root by default. */
  constructor(readonly d: ControllerDeps, private readonly deliveries: Deliveries, readonly hooks: ControllerHooks, signal_root: string = CODE_ROOT) {
    this.sources = checkSources(d);
    this.byType = new Map(this.sources.map((s) => [s.type, s]));
    this.forge = d.forge ?? null;
    this.live = d.settings ?? LiveSettings.fixed(d.config);
    const store = d.store;
    // Bound one by one, so a unit holding the reader cannot reach the store's writes through it.
    // Looked up at call time: a startup check may build the kernel over a store stub that has none of them.
    const reads = Object.fromEntries(READS.map((m) => [m, (...a: unknown[]) => (store[m] as (...a: unknown[]) => unknown).apply(store, a)]));
    const forge = this.forge;
    // Discovered by the runtime registry now, so a tick awaits a settled list instead of the imports; a failed
    // discovery is retried on the next call.
    let found: Promise<SignalDescriptor[]> | null = null;
    const discover = () => loadDescriptors<SignalDescriptor>(signal_root, "signal").then((l) => uniqueSignals(l.map((d) => d.descriptor)));
    const signals = () => (found ??= forgetOnFailure(discover(), () => (found = null)));
    signals().catch(() => undefined);
    this.reader = {
      ...(reads as Pick<Store, (typeof READS)[number]>),
      scan: (channel, content) => d.scanner.scan(channel, content),
      forge: forge && { prChecks: (pr) => forge.prChecks(pr), prCheckResults: (pr) => forge.prCheckResults(pr) },
      llm: d.llm ?? null,
      auth: { forge: d.auth, local: d.local_auth ?? null, slack: d.slack_auth ?? d.local_auth ?? d.auth, service: d.service_auth ?? null },
      signals,
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
      else if (w.kind === "emit") await this.deliveries.emit(w.draft, this.d.clock.now().toISOString());
      else if (w.kind === "intent") await this.deliveries.record(w.action, this.d.clock.now().toISOString());
      else if (w.kind === "signal") await store.recordSignal(w.signal);
      else await this.commit({ writes: w.then(await this.expireLeases(w)) });
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

  /** One lease expiry: what it cut off and which runs it moved, for the decision's `then`. */
  private async expireLeases(w: Extract<ControllerWrite, { kind: "expire_leases" }>): Promise<ExpiredLeases> {
    const abandoned: ExpiredLeases["abandoned"][number][] = [];
    const run_ids = await this.d.store.expireLeases(w.max_attempts, w.backoff_ms, (a) => void abandoned.push(a));
    return { abandoned, run_ids };
  }

  /** Publishes a unit's message on the controller's bus (the `emit` write, for a unit that still writes inline). */
  async emit(draft: Draft): Promise<void> {
    await this.commit({ writes: [{ kind: "emit", draft }] });
  }

  private async stopAuto(w: Extract<ControllerWrite, { kind: "stop_auto" }>): Promise<void> {
    const r = await this.d.store.recordAlert(w.alert, w.dedupe_ms);
    // A stop whose alert another replica (or a crashed earlier attempt) recorded still sets manual while the stored
    // mode is auto: else a failed settings write would leave auto mode on for the alert's whole dedupe window.
    if (!r.created) {
      await this.live.refresh();
      if (modeOf(this.live.resolved(), w.project).mode !== "auto") return;
    }
    await this.d.store.setSettingOverride({ key: "mode", project: w.level, value: JSON.stringify("manual"), actor: w.actor });
    await this.live.refresh();
    this.d.log.warn("auto mode stopped; the mode is manual again", { cause: w.alert.error_code, alert_id: r.created ? r.alert.id : null, mode_change: w.mode_change });
  }

  /** Announces every stored intent as DeliveryRequested on the controller's bus; returns how many. */
  announce(): Promise<number> {
    return this.deliveries.announce(this.d.clock.now().toISOString());
  }

  /** PR `pr` as a comment or label target on the forge (a pure mapping, no call); null when config selects no forge. */
  prRef(pr: number): SourceRef | null {
    return this.forge?.prRef(pr) ?? null;
  }

  /** The action a producer stored under `key` (a run's PR, RFC 0015 M7), delivered or not; null when none is. */
  actionByKey(key: string): Promise<ActionRow | null> {
    return this.deliveries.byKey(key);
  }

  /** The action rows among `intent_ids`, which outbound reported delivered. */
  deliveredActions(intent_ids: readonly string[]): Promise<ActionRow[]> {
    return this.deliveries.actions(intent_ids);
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

  /** Runs `fn`, logging a failure instead of throwing it; returns the failure (null when none) for a caller that retries. */
  async guard(what: string, fn: () => Promise<void>): Promise<unknown> {
    try {
      await fn();
      return null;
    } catch (err) {
      // A forge call refused with no calls left is a wait for the reset, not a failure: the step runs again next
      // poll, and every other step (local work) goes on.
      const until = rateLimitWait(err);
      if (until) this.d.log.warn("waiting for the GitHub rate-limit reset", { step: what, until });
      else this.d.log.error("loop step failed", { step: what, error: errorText(err) });
      return err;
    }
  }
}
