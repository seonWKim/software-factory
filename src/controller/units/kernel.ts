// The controller units' shared kernel (RFC 0015 M5).

import { LiveSettings, type ProjectSettings, modeOf, settingValues } from "../../core/settings.js";
import { LOCAL_SOURCE, threadDelivery } from "../../core/local-merge.js";
import { errorText } from "../../core/log.js";
import { askDetail } from "../../core/owner-asks.js";
import { type Run, type SourceRef, type SourceType, type Timestamp, type UserId, type WorkItem, outcomeCost, runTokenCount } from "../../core/types.js";
import type { Forge } from "../../interfaces/forge.js";
import { type ControllerDeps, rateLimitWait } from "../../core/controller-deps.js";
import { type Routine, type SuggestionDecision, carrierSource, fingerprint, lastCost, overRunCap, routineFindings, routineOfCarrier, routineOfHold, slotOfRun } from "../../core/check-page.js";
import type { ActionRow, NewAction } from "../../outbound/index.js";
import type { Draft } from "../../shared/envelope.js";
import { CODE_ROOT, type SqlDriver, forgetOnFailure } from "../../state/index.js";
import { loadDescriptors } from "../../runtime/index.js";
import { type SignalDescriptor, uniqueSignals } from "../signals/signal.js";

/** A configured source, as the deps carry it. */
type SourceAdapter = NonNullable<ControllerDeps["source"]>;
/** The routines unit's constants and types (src/core/check-page.ts), through the kernel, which reads and writes for it. */
export { ROUTINE_CAP, ROUTINE_CAP_APPROVED, ROUTINE_CAP_REJECTED, SNOOZE_MS } from "../../core/check-page.js";
export type { RoutineSuggestion } from "../../core/check-page.js";
/** The core types the improve unit uses, through the kernel, so the unit adds no legacy import. */
export type { FiledPattern, Run, SourceRef, Timestamp, WorkItem } from "../../core/types.js";

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
  "listVerdicts", "listStandingRules", "latestSignalTimes", "listSignalRefs", "listStateChangesSince", "listVerdictsSince", "listRunsFinishedSince",
  "listNoticesFor", "listHeldNotices", "listDueReminders", "listMergeEvaluations", "getRoutine", "getRoutineSuggestion", "listRoutineSuggestions", "listScheduleRuns",
  "listAlerts",
] as const;

/**
 * What a unit's `load` reads through: store reads, the egress scan (a check, no write), the forge's PR and base check
 * reads and a failed CI job's log (remote reads, no write; null when config selects no forge) and the command
 * suggester. The one write it may make is the forge's `rerunFailedJobs`: the CI gate's rerun of a PR head's failed
 * jobs, made at most once per head, which changes no store state (design 05-ci-gate, Rerun once).
 */
export type ControllerReader = Pick<Store, (typeof READS)[number]> & Pick<ControllerDeps["scanner"], "scan"> & {
  readonly forge: Pick<Forge, "prChecks" | "prCheckResults" | "baseChecks" | "rerunFailedJobs" | "failedJobLog"> | null;
  /** The provider that suggests a command for a plain comment (a query, no state change); null when none is configured. */
  readonly llm: NonNullable<ControllerDeps["llm"]> | null;
  /**
   * The permission checks: a person's command by the owner check (`owner`, design 08-permissions, One owner), and the
   * controller's automatic steps under its service passport (null: no Identity, allowed). A check: it changes no
   * controller state; each decision is audited.
   */
  readonly auth: {
    readonly owner: ControllerDeps["auth"];
    readonly service: ControllerDeps["service_auth"] | null;
  };
  /** The discovered signal sources (`*.signal.ts`, design 11-signal-ledger), in path order. */
  signals(): Promise<readonly SignalDescriptor[]>;
  /**
   * The file paths under the folder `path` in the factory repo's local base branch, read from objects by the
   * sandbox (no checkout, no fetch); null when the sandbox cannot list, the branch is missing or the read fails (logged).
   */
  baseFiles(path: string): Promise<readonly string[] | null>;
  /**
   * A finished routine run's routine, its finding texts, whether it cost more than the per-run cap, and its model
   * calls with the slot whose schedule run row they go on (null when that row is gone or holds them already); null
   * for a run no routine carries.
   */
  routineRun(run: Run): Promise<{ routine: Routine; findings: string[]; over_run_cap: boolean; used: { slot: Timestamp; tokens: number; cost_usd: number | null } | null } | null>;
  /** The routine a hold item holds and the cost of its last run (what `/approve` adds); null for any other item. */
  routineHold(it: WorkItem): Promise<{ routine: Routine; last_cost: number } | null>;
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
  /** An alert (e.g. `red_main`, design 03-risk), stored unless its pattern key alerted within `dedupe_ms`. */
  | { kind: "alert"; alert: Parameters<Store["recordAlert"]>[0]; dedupe_ms: number }
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
  | { kind: "signal"; signal: Parameters<Store["recordSignal"]>[0] }
  /** An owner notice, skipped when its (work item, wait key) is stored (design 09-notifications). */
  | { kind: "notice"; notice: Parameters<Store["recordNotice"]>[0] }
  /** A task's reminder: its sent-marker's conditional write and its desktop notice, in one transaction (design 02-tasks). */
  | { kind: "task_reminder"; id: string; at: Parameters<Store["remindTask"]>[1]; notice: Parameters<Store["remindTask"]>[2] }
  /** What a schedule occurrence's run used, onto its run row (a routine run's model calls, for its token cap). */
  | { kind: "schedule_result"; schedule_id: string; occurrence_at: Timestamp; result: Parameters<Store["recordScheduleRunResult"]>[2] }
  /** A routine's marks or pause, conditional on the marks read. */
  | { kind: "routine_update"; id: string; read: Parameters<Store["updateRoutine"]>[1]; patch: Parameters<Store["updateRoutine"]>[2] }
  /** What `/approve` adds to a routine's daily cap, once per hold item. */
  | { kind: "routine_raise"; id: string; raise: Parameters<Store["raiseRoutineCap"]>[1] }
  /** A routine run's findings (scanned clean) as pending suggestions; duplicates skipped and counted. */
  | { kind: "routine_findings"; routine_id: string; run_id: string; texts: readonly string[] }
  /** A suggestion's answer; an accept first files it through the first source that can (`fileIssue`), keyed on its marker. */
  | { kind: "suggestion_answer"; id: string; decision: Exclude<SuggestionDecision, { to: "accepted" }> | { to: "accepted"; by: string; issue: Parameters<NonNullable<SourceAdapter["fileIssue"]>>[0] } }
  /**
   * The owner's answer to the coordinator limit question (design 06-spend): `approve <usd>` sets `setting` (the key
   * `spend.coordinator_daily_usd` and the amount) through the settings path by `actor` (one audit row), `reject` (null)
   * sets nothing; either dismisses the alert by `actor`, so the answer stays on it. A second commit sets the same value.
   */
  | { kind: "coordinator_limit_answer"; alert_id: string; setting: { key: string; value: number } | null; actor: UserId };

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
  /**
   * Reads change refs (reverts, fix-forwards) out of commit messages and item text: the selected forge, else the
   * reader the deps give (compose builds the local forge through the registry), else null: no text names a change.
   */
  readonly links: Pick<Forge, "parseLinks"> | null;
  /** The settings in effect: a cache of the config file plus the stored overrides, refreshed each tick. */
  readonly live: LiveSettings;

  /** `signal_root`: where the signal sources are discovered (a test's fixture folder); the code root by default. */
  constructor(readonly d: ControllerDeps, private readonly deliveries: Deliveries, readonly hooks: ControllerHooks, signal_root: string = CODE_ROOT) {
    this.sources = checkSources(d);
    this.byType = new Map(this.sources.map((s) => [s.type, s]));
    this.forge = d.forge ?? null;
    this.links = this.forge ?? d.links ?? null;
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
      forge: forge && {
        prChecks: (pr) => forge.prChecks(pr),
        prCheckResults: (pr) => forge.prCheckResults(pr),
        ...(forge.baseChecks ? { baseChecks: () => forge.baseChecks!() } : {}),
        ...(forge.rerunFailedJobs ? { rerunFailedJobs: (head_sha: string) => forge.rerunFailedJobs!(head_sha) } : {}),
        ...(forge.failedJobLog ? { failedJobLog: (head_sha: string) => forge.failedJobLog!(head_sha) } : {}),
      },
      llm: d.llm ?? null,
      auth: { owner: d.auth, service: d.service_auth ?? null },
      signals,
      routineRun: async (run) => {
        const carrier = await store.getWorkItem(run.work_item_id);
        const id = carrier && routineOfCarrier(carrier), routine = id ? await store.getRoutine(id) : null;
        if (!routine) return null;
        const data = run.outcome?.status === "succeeded" ? run.outcome.data.routine : null;
        const cost = outcomeCost(run.outcome), slot = slotOfRun(routine.id, run.idempotency_key);
        const row = slot === null ? undefined : (await store.listScheduleRuns(routine.id)).find((r) => r.occurrence_at === slot);
        const used = slot !== null && row && row.tokens === undefined ? { slot, tokens: runTokenCount(run), cost_usd: cost } : null;
        return { routine, findings: routineFindings(data), over_run_cap: overRunCap(routine, cost), used };
      },
      routineHold: async (it) => {
        const hold = routineOfHold(it), routine = hold ? await store.getRoutine(hold.routine_id) : null;
        if (!routine) return null;
        const carrier = await store.getWorkItemBySource("local", carrierSource(routine.id).id);
        return { routine, last_cost: lastCost(carrier ? await store.listRuns(carrier.id) : []) };
      },
      baseFiles: async (path) => {
        const sandbox = d.sandbox;
        if (!sandbox?.listLocalFiles) return null;
        const { repo } = this.live.config();
        try {
          return await sandbox.listLocalFiles({ repo: repo.path, ref: repo.base_branch, path });
        } catch (err) {
          d.log.warn("could not list the base branch's files", { path, error: errorText(err) });
          return null;
        }
      },
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
      else if (w.kind === "alert") await store.recordAlert(w.alert, w.dedupe_ms);
      else if (w.kind === "app_request_handled") await store.markAppCommandRequest(w.seq, w.refusal);
      else if (w.kind === "standing_rule") await store.putStandingRule(w.rule);
      else if (w.kind === "standing_proposal") await store.recordStandingProposal(w.proposal);
      else if (w.kind === "emit") await this.deliveries.emit(w.draft, this.d.clock.now().toISOString());
      else if (w.kind === "intent") await this.deliveries.record(w.action, this.d.clock.now().toISOString());
      else if (w.kind === "signal") await store.recordSignal(w.signal);
      else if (w.kind === "notice") await store.recordNotice(w.notice);
      else if (w.kind === "task_reminder") await store.remindTask(w.id, w.at, w.notice);
      else if (w.kind === "routine_findings" || w.kind === "suggestion_answer") await this.routineWrite(w);
      else if (w.kind === "schedule_result") await store.recordScheduleRunResult(w.schedule_id, w.occurrence_at, w.result);
      else if (w.kind === "routine_update") await store.updateRoutine(w.id, w.read, w.patch);
      else if (w.kind === "routine_raise") await store.raiseRoutineCap(w.id, w.raise);
      else if (w.kind === "coordinator_limit_answer") await this.limitAnswer(w);
      else await this.commit({ writes: w.then(await this.expireLeases(w)) });
    }
  }

  /** The routine writes with more than one store call: each call keyed or conditional, so a second commit adds nothing. */
  private async routineWrite(w: Extract<ControllerWrite, { kind: "routine_findings" | "suggestion_answer" }>): Promise<void> {
    const { store, log } = this.d;
    if (w.kind === "routine_findings") {
      const r = await store.addRoutineSuggestions(w.routine_id, w.run_id, w.texts.map((text) => ({ fingerprint: fingerprint(text), text })));
      log.info("routine findings stored as suggestions", { routine_id: w.routine_id, run_id: w.run_id, ...r });
    } else if (w.decision.to !== "accepted") await store.decideRoutineSuggestion(w.id, w.decision);
    else {
      const fileIssue = this.filingSource()?.fileIssue;
      if (!fileIssue) return log.warn("no source can file the accepted suggestion; it stays pending", { suggestion_id: w.id });
      const ref = await fileIssue(w.decision.issue);
      await store.decideRoutineSuggestion(w.id, { to: "accepted", by: w.decision.by, filed_ref: ref.id });
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
    return (write as (input: W["input"]) => Promise<ItemCommitted<W>>).call(store, await this.withAsk(w.input));
  }

  /**
   * An entry into an owner state (`blocked_on: "human"`) as an ask (design 06-efficiency): its state change's detail
   * gets the reason code and the item's tier after the patch (read only when the patch sets none). Other writes pass as they are.
   */
  private async withAsk<I extends ItemWrite["input"]>(input: I): Promise<I> {
    if (!("patch" in input) || input.patch.blocked_on !== "human") return input;
    const tier = input.patch.tier !== undefined ? input.patch.tier : ((await this.d.store.getWorkItem(input.id))?.tier ?? null);
    return { ...input, detail: { ...input.detail, ...askDetail(input.patch, tier) } };
  }

  /** `/link <code>`: the code's one conditional redeem (used once, counted on a failure), committed here. */
  redeemLinkCode(...a: Parameters<Store["redeemLinkCode"]>): ReturnType<Store["redeemLinkCode"]> {
    return this.d.store.redeemLinkCode(...a);
  }

  /**
   * The first configured source, in `plugins.source` order, that can file an item, with its `fileIssue` bound; null
   * when none can. The one lookup behind `filer()`, an accepted suggestion and the improve unit's filing.
   */
  filingSource(): { type: SourceType; fileIssue: NonNullable<SourceAdapter["fileIssue"]> } | null {
    const s = this.sources.find((x) => typeof x.fileIssue === "function");
    return s?.fileIssue ? { type: s.type, fileIssue: (input) => s.fileIssue!(input) } : null;
  }

  /** The type of the source that files an item (`filingSource`); null when none can. */
  filer(): SourceType | null {
    return this.filingSource()?.type ?? null;
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

  private async limitAnswer(w: Extract<ControllerWrite, { kind: "coordinator_limit_answer" }>): Promise<void> {
    if (w.setting !== null) {
      await this.d.store.setSettingOverride({ key: w.setting.key, project: "", value: JSON.stringify(w.setting.value), actor: w.actor });
      await this.live.refresh();
    }
    await this.d.store.dismissAlert(w.alert_id, w.actor);
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
