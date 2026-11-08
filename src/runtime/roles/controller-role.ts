// The controller role (RFC 0015 §8, M4–M5): what `factory controller` and `factory dev` run. Inbound polls the
// sources and the forge, stores their records and announces them; its normalizer turns them into
// controller.commands; the controller's consumer hands each to the router, which gives each event to the unit that
// accepts its kind. The units (src/controller/units/, discovered) decide; their steps run on the controller's tick.
// Inbound and the bus move on their own TickGenerators.
//
// The sync lease is made here and shared: inbound polls under it, the sync unit fences deliveries with it. Tests
// drive the same path one step at a time through the tick* methods, which drain the bus.

import { join } from "node:path";
import {
  BUS_PERIODS, SqlBus, scheduleBus, scheduleComponent, type BusPlugin, type EventBus, type Inbox, type Relay, type RetryScheduler,
} from "../../bus/index.js";
import {
  CONTROLLER, type ControllerContext, type ControllerEvent, type Decisions, type ControllerUnits, Kernel, Router, type UnitName, type UnitOperations,
} from "../../controller/index.js";
import type { ControllerDeps, GitHubBudgetStatus } from "../../core/controller-deps.js";
import type { FactoryConfig } from "../../core/config.js";
import { TickLease, syncLeaseName, syncLeaseOps } from "../../core/lease.js";
import { Listener } from "../../core/listener.js";
import { GITHUB_RATE_LIMIT } from "../../core/policy.js";
import { LiveSettings } from "../../core/settings.js";
import type { Run, SourceType, WorkItemId } from "../../core/types.js";
import type { IdentityRuntime } from "../../identity/index.js";
import { INBOUND, Inbound, type InboundContext } from "../../inbound/index.js";
import {
  DEFAULT_BATCHING, OUTBOUND, OUTBOUND_FLUSH_MS, Outbound, type OutboundContext, announce, buildTargets, recordAction,
} from "../../outbound/index.js";
import { TimeBasedTicks } from "../../shared/ticks/plugins/time-based/time-based-tick-generator.js";
import { tickAt, type Tick, type TickSource } from "../../shared/ticks/tick-generator.js";
import type { SqlDriver } from "../../state/index.js";
import { ComponentConsumer } from "../consumer.js";
import { loadDescriptors, loadRegistry, type Registry } from "../registry/registry.js";
import { ensureDiscoveredTopicTables } from "../registry/topic-tables.js";

export interface ControllerRoleDeps extends ControllerDeps {
  /**
   * The forge client's budget (`GitHubClient.status`): inbound stores it after each poll, so the status page shows
   * remaining calls, the reset and this process's count. Absent: nothing is stored.
   */
  github_budget?: () => GitHubBudgetStatus | null;
  /** `plugins.bus` and `plugins.ticks`, built by compose through the plugin registry. Absent: `sql` and `time-based`. */
  bus?: BusPlugin;
  ticks?: TickSource;
  /** Identity (M9): inbound gives a command row without a passport its actor's edge passport. Absent: none. */
  identity?: Pick<IdentityRuntime, "commandPassport">;
}

type ComponentBus = EventBus & Inbox & Relay;

/** The sync lease's owner with no replica_id (tests, a solo process): such roles in one process act as one replica. */
const SYNC_OWNER = "controller";
/** The forge's source type: the one synced type (design 05-coordination). */
const SYNCED: SourceType = "github_issue";
/** Where discovery looks: src/ (dist/ once built). */
const CODE_ROOT = join(import.meta.dirname, "..", "..");
/** Rounds of relay and consume one manual step runs at most before it leaves the rest to the next. */
const MAX_DRAIN_ROUNDS = 50;

let discovered: Promise<Registry> | null = null;
let discoveredUnits: Promise<ControllerUnits> | null = null;

/** The discovered handlers and topics, loaded once per process; startup refuses a broken dispatch. */
async function registry(): Promise<Registry> {
  const r = await (discovered ??= loadRegistry(CODE_ROOT));
  const problems = r.problems();
  if (problems.length > 0) throw new Error(`message dispatch is broken: ${problems.join("; ")}`);
  return r;
}

/** The discovered controller units, loaded once per process. */
function units(): Promise<ControllerUnits> {
  return (discoveredUnits ??= loadDescriptors<ControllerUnits[number]>(CODE_ROOT, "unit").then((l) => l.map((u) => u.descriptor)));
}

/** The SQL driver under the store: the bus and inbound write in its transactions. */
function driverOf(store: ControllerDeps["store"]): SqlDriver {
  const db = (store as { db?: SqlDriver }).db;
  if (!db) throw new Error("the controller role needs a SQL store (sqlite or mysql)");
  return db;
}

/** lease_ms and heartbeat_ms as getters over the live settings, so a change applies at the next renew. */
function leaseTimings(live: LiveSettings): Pick<FactoryConfig, "lease_ms" | "heartbeat_ms"> {
  return { get lease_ms() { return live.config().lease_ms; }, get heartbeat_ms() { return live.config().heartbeat_ms; } };
}

type Prepared = ControllerRoleDeps & { settings: LiveSettings; sync: TickLease | null };

/** The live settings and the sync lease, made once and shared by inbound and the controller units. */
function prepare(deps: ControllerRoleDeps): Prepared {
  const settings = deps.settings ?? LiveSettings.fixed(deps.config);
  const sources = deps.sources ?? (deps.source ? [deps.source] : []);
  const synced = sources.some((s) => s.type === SYNCED) || deps.forge?.ref_type === SYNCED;
  const name = syncLeaseName(SYNCED, settings.config().project.key);
  const sync = synced
    ? new TickLease(name, syncLeaseOps(deps.store, name), deps.clock, leaseTimings(settings), deps.replica_id ?? SYNC_OWNER, deps.log, SYNCED)
    : null;
  return { ...deps, settings, sync };
}

interface Wiring {
  readonly inbound: Inbound;
  readonly inboundBus: ComponentBus;
  readonly controllerBus: ComponentBus;
  readonly scheduler: RetryScheduler;
  readonly normalizers: ComponentConsumer<InboundContext>;
  readonly decisions: ComponentConsumer<ControllerContext>;
  readonly outboundBus: ComponentBus;
  readonly outbound: Outbound;
  readonly aggregator: ComponentConsumer<OutboundContext>;
}

/** The local merge's `who`: the CLI's local identity or the app request's factory user ID. */
type MergeBy = Parameters<UnitOperations["local-merge"]["mergeLocal"]>[1];

export class ControllerRole implements Decisions {
  private readonly role: Prepared;
  /** What every unit shares: the deps, the configured sources, the live settings. */
  readonly kernel: Kernel;
  private wiring?: Promise<Wiring>;
  private routed?: Promise<Router<Kernel, ControllerEvent>>;

  constructor(deps: ControllerRoleDeps) {
    this.role = prepare(deps);
    const db = () => driverOf(this.role.store);
    this.kernel = new Kernel(this.role, {
      record: (a, now) => recordAction(db(), a, now),
      // The intents go out on the controller's bus; wired before its transaction opens.
      announce: async (now) => announce(db(), (await this.wire()).controllerBus, this.role.settings.config().project.key, now, CONTROLLER),
    });
  }

  /** Outbound delivered these intents: the outbox unit records them on their items. */
  async deliveryCompleted(intent_ids: readonly string[]): Promise<void> {
    await (await this.router()).unit("outbox").delivered(intent_ids);
  }

  /**
   * The outbox step, then outbound at once (tests and the manual ticks): the intents announced, batched, sent, and
   * their results recorded, as outbound's ticks do over time.
   */
  private async outboxStep(): Promise<void> {
    await (await this.router()).unit("outbox").outboxStep();
    await this.drain(this.tick("outbound-flush"));
  }

  /**
   * The decision loop: each tick_ms the units' `tick` steps, and their `poll` steps once a poll interval passed.
   * Inbound polls the sources and the forge, and the bus delivers their records and the command rows.
   */
  async run(signal: AbortSignal): Promise<void> {
    const w = await this.wire();
    const r = await this.router();
    const onError = (schedule: string, err: unknown) =>
      this.role.log.error("loop step failed", { step: schedule, error: err instanceof Error ? err.message.slice(0, 300) : "unknown" });
    const ticks = this.role.ticks ?? new TimeBasedTicks();
    const inbound = ticks.create(onError);
    inbound.schedule("intake", this.role.settings.config().tick_ms, (t) => w.inbound.tick(t));
    inbound.schedule("consume", BUS_PERIODS.consume, async () => void (await w.normalizers.consume()));
    inbound.schedule("records", BUS_PERIODS.prune, (t) => w.inbound.prune(t));
    scheduleComponent(inbound, w.inboundBus);
    const controller = ticks.create(onError);
    controller.schedule("consume", BUS_PERIODS.consume, async () => void (await w.decisions.consume()));
    scheduleComponent(controller, w.controllerBus);
    const bus = ticks.create(onError);
    scheduleBus(bus, w.scheduler);
    const outbound = ticks.create(onError);
    outbound.schedule("consume", BUS_PERIODS.consume, async () => void (await w.aggregator.consume()));
    outbound.schedule("outbound-flush", OUTBOUND_FLUSH_MS, async (t) => void (await w.outbound.flush(t)));
    scheduleComponent(outbound, w.outboundBus);
    await Promise.all([
      this.decide(r, signal), w.inbound.run(signal), inbound.run(signal), controller.run(signal), bus.run(signal), outbound.run(signal),
    ]);
    // Shutting down: hand the sync lease over now instead of after lease_ms.
    await this.role.sync?.release();
  }

  /** The units' steps on the controller's tick (the injected clock's, so tests move it by hand). */
  private async decide(r: Router<Kernel, ControllerEvent>, signal: AbortSignal): Promise<void> {
    const k = this.kernel;
    // The label, never the key: log lines and comments name a project by its readable path.
    k.d.log.info("controller started", { project: k.cfg.project.label });
    let lastPoll = -Infinity;
    while (!signal.aborted) {
      await k.live.refresh();
      const now = k.nowMs();
      const due = now - lastPoll >= k.cfg.poll_interval_ms;
      if (due) lastPoll = now;
      await r.tick(due ? ["tick", "poll"] : ["tick"]);
      await k.d.clock.sleep(k.cfg.tick_ms, signal).catch(() => undefined);
    }
  }

  /** One intake step: every source and the forge polled now, then their records through the bus to the units. */
  async tickIntake(): Promise<void> {
    await this.role.settings.refresh();
    const w = await this.wire();
    const t = this.tick("intake");
    await w.inbound.tick(t, true);
    await this.drain(t);
    const r = await this.router();
    await this.kernel.guard("sync", () => r.unit("sync").syncStep());
    await r.unit("closes").afterPoll();
    await this.outboxStep();
  }

  /** One command step: the command rows after the cursor, through the bus to the units, then their mirrors. */
  async tickCommands(): Promise<void> {
    await this.role.settings.refresh();
    const w = await this.wire();
    const t = this.tick("commands");
    await w.inbound.relayCommands(t);
    await this.drain(t);
    const r = await this.router();
    await r.unit("mirror").mirrorStep();
    await this.outboxStep();
  }

  /** Removes inbound records past inbox_retention_days, as inbound's `records` tick does. */
  async tickRecords(): Promise<void> {
    await (await this.wire()).inbound.prune(this.tick("records"));
  }

  /**
   * One outbox step (issue #282): every pending thread entry of a configured source type is delivered to its
   * target source once. The only caller of a source's postComment.
   */
  async tickOutbox(): Promise<void> {
    await this.step(async () => undefined);
  }

  async tickRuns(): Promise<void> {
    await this.step((r) => r.unit("run-results").runsStep());
  }

  async tickModelProbe(): Promise<void> {
    await this.step((r) => r.unit("model-probe").probeStep());
  }

  async tickReaper(): Promise<void> {
    await this.step((r) => r.unit("reaper").reaperStep());
  }

  async tickMergeCheck(): Promise<void> {
    await this.step((r) => r.unit("merge-check").mergeCheckStep());
  }

  async tickCoordination(): Promise<void> {
    await this.step((r) => r.unit("coordination").coordinationStep());
  }

  async tickChecks(): Promise<void> {
    await this.step((r) => r.unit("checks-gate").checksStep());
  }

  /** One alarm step (design 05-alarms) with the settings as of this tick. */
  async tickAlarms(): Promise<void> {
    await this.kernel.live.refresh();
    await (await this.router()).unit("alarms").alarmsStep();
  }

  /** One daily improve step (design §7): the current UTC day's improve run, queued once. */
  async tickImprove(): Promise<void> {
    await this.kernel.live.refresh();
    await (await this.router()).unit("improve").improveStep();
  }

  async tickPhases(): Promise<void> {
    await (await this.router()).unit("phases").tickPhases();
  }

  async tickSourceCloses(): Promise<void> {
    await (await this.router()).unit("closes").tickSourceCloses();
  }

  /** The start-up status catch-up (issue #254); false while the request budget defers it. */
  async catchUpStatus(): Promise<boolean> {
    const done = await (await this.router()).unit("outbox").catchUpStatus();
    await this.outboxStep();
    return done;
  }

  /** A finished run's outcome, then the outbox. */
  async applyRun(run: Run): Promise<void> {
    const r = await this.router();
    await r.unit("run-results").apply(run);
    await this.outboxStep();
  }

  /** The local merge (design 05-sources, Local items); returns the refusal, or null when the item merged. */
  async mergeLocal(id: WorkItemId, who: MergeBy, key: string, detail: Record<string, unknown> = {}): Promise<string | null> {
    return (await this.router()).unit("local-merge").mergeLocal(id, who, key, detail);
  }

  /** One event decided at once (tests and the status catch-up path), then the outbox. */
  async handleEvent(e: ControllerEvent): Promise<void> {
    const r = await this.router();
    await r.dispatch(e);
    await this.outboxStep();
  }

  /**
   * One event a source or the forge reported, delivered by the bus (RFC 0015 M4). A failure is logged and passed,
   * as a polled event's always was: the next poll or the person's next comment brings it again.
   */
  async consumeEvent(e: ControllerEvent): Promise<void> {
    const r = await this.router();
    await this.kernel.guard(`event:${e.kind}`, () => r.dispatch(e));
  }

  /**
   * One command row (issue #282), delivered by the bus in its stream's order (the commands unit). Throws when its
   * handling failed (a store error): the bus retries it, and the commands after it in its stream wait.
   */
  async consumeCommand(c: Parameters<Decisions["consumeCommand"]>[0]): Promise<void> {
    try {
      await (await this.router()).unit("commands").handleInboxCommand(c);
    } catch (err) {
      this.role.log.error("command failed; retried next tick", { command_seq: c.seq, error: err instanceof Error ? err.message.slice(0, 300) : "unknown" });
      throw err;
    }
  }

  /** One unit's operations, for a test that drives a single step. */
  async unit<N extends UnitName>(name: N): Promise<UnitOperations[N]> {
    return (await this.router()).unit(name);
  }

  /** Settings refreshed, one unit step, then the outbox: the shape of every manual tick. */
  private async step(fn: (r: Router<Kernel, ControllerEvent>) => Promise<unknown>): Promise<void> {
    await this.kernel.live.refresh();
    const r = await this.router();
    await fn(r);
    await this.outboxStep();
  }

  private tick(schedule: string): Tick {
    return tickAt(schedule, 1, this.kernel.nowMs());
  }

  private router(): Promise<Router<Kernel, ControllerEvent>> {
    return (this.routed ??= units().then((list) => {
      const r = new Router<Kernel, ControllerEvent>(list, this.kernel, { guard: (what, fn) => this.kernel.guard(what, fn) });
      const problems = r.problems();
      if (problems.length > 0) throw new Error(`controller units are broken: ${problems.join("; ")}`);
      return r;
    }));
  }

  /** Relays and consumes until nothing moves: what the role's ticks do over time, done at once. */
  private async drain(t: Tick): Promise<void> {
    const w = await this.wire();
    for (let round = 0; round < MAX_DRAIN_ROUNDS; round++) {
      await w.scheduler.release(t);
      let moved = await w.inboundBus.relay(t);
      moved += await w.normalizers.consume();
      moved += await w.inboundBus.relay(t);
      moved += await w.decisions.consume();
      moved += await w.controllerBus.relay(t);
      moved += await w.aggregator.consume();
      moved += await w.outbound.flush(t);
      moved += await w.outboundBus.relay(t);
      if (moved === 0) return;
    }
  }

  private wire(): Promise<Wiring> {
    return (this.wiring ??= this.build());
  }

  private async build(): Promise<Wiring> {
    const d = this.role;
    const db = driverOf(d.store);
    const dialect = db.dialect.name;
    const r = await registry();
    const topics = r.topics.map((t) => t.descriptor);
    await ensureDiscoveredTopicTables(dialect, db, CODE_ROOT);
    const consumerId = d.replica_id ?? SYNC_OWNER;
    const bus = d.bus ?? new SqlBus();
    const inboundBus = bus.component({ db, component: INBOUND, topics, consumerId });
    const controllerBus = bus.component({ db, component: CONTROLLER, topics, consumerId });
    const outboundBus = bus.component({ db, component: OUTBOUND, topics, consumerId });
    const sync = (await this.router()).unit("sync");
    const outbound = new Outbound({
      db,
      bus: outboundBus,
      store: d.store,
      targets: buildTargets({ byType: this.kernel.byType, forge: this.kernel.forge }),
      scanner: d.scanner,
      log: d.log,
      config: () => {
        const c = d.settings.config();
        return { lease_ms: c.lease_ms, retry_base_ms: c.retry_base_ms, retry_max_ms: c.retry_max_ms, project_key: c.project.key };
      },
      // Only the sync lease's holder writes the synced type (design 05-coordination), whatever the budget.
      canSend: (type) => type !== SYNCED || !sync.syncedElsewhere(),
      fenceFor: (type) => sync.fenceFor(type),
      fenceRefused: (fence) => sync.fenceRefused(fence),
    });
    const owner = d.replica_id ?? `controller:${Math.random().toString(36).slice(2, 12)}`;
    const inbound = new Inbound({
      db,
      dialect,
      bus: inboundBus,
      sources: d.sources ?? (d.source ? [d.source] : []),
      forge: d.forge ?? null,
      config: () => {
        const c = d.settings.config();
        return { poll_interval_ms: c.poll_interval_ms, inbox_retention_days: c.inbox_retention_days, project_key: c.project.key };
      },
      sync: d.sync ? { lease: d.sync, type: SYNCED } : null,
      forgePaused: async () => (await d.store.getClaimPause(GITHUB_RATE_LIMIT)) !== null,
      ...(d.github_budget ? { budget: d.github_budget } : {}),
      ...(d.refresh_forge_budget ? { refreshBudget: d.refresh_forge_budget } : {}),
      ...(d.replica_id ? { replica_id: d.replica_id } : {}),
      ...(d.identity ? { passportFor: d.identity.commandPassport } : {}),
      // Each stream source gets its own listener; its store lease (per source type) lets only one replica subscribe.
      listen: (source, signal) =>
        new Listener({ store: d.store, source, clock: d.clock, config: leaseTimings(d.settings), log: d.log, owner }).run(signal),
      log: d.log,
    });
    return {
      inbound,
      inboundBus,
      controllerBus,
      scheduler: bus.scheduler(db, topics),
      normalizers: new ComponentConsumer<InboundContext>({
        db, bus: inboundBus, registry: r, component: INBOUND, transactional: true,
        context: (tx, emit) => ({ tx: tx!, emit }),
      }),
      decisions: new ComponentConsumer<ControllerContext>({
        db, bus: controllerBus, registry: r, component: CONTROLLER, transactional: false,
        context: (_tx, emit) => ({
          db, emit, decisions: this,
          recordAlert: async (alert, dedupe_ms) => {
            const scan = alert.detail === null ? null : await d.scanner.scan("ui", alert.detail);
            await d.store.recordAlert({ ...alert, detail: scan?.clean ? alert.detail : null }, dedupe_ms);
          },
        }),
      }),
      outboundBus,
      outbound,
      aggregator: new ComponentConsumer<OutboundContext>({
        db, bus: outboundBus, registry: r, component: OUTBOUND, transactional: true,
        context: (tx, emit) => ({
          tx: tx!, emit,
          policy: () => DEFAULT_BATCHING,
          budget: (destination) => {
            const b = destination.startsWith(`${SYNCED}:`) ? d.github_budget?.() : null;
            return b ? { remaining: b.remaining, limit: b.limit } : null;
          },
        }),
      }),
    };
  }
}
