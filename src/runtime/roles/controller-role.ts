// The controller role (RFC 0015 §8, M4): what `factory controller` and `factory dev` run. It wires the bus into
// the legacy controller (strangler): inbound polls the sources and the forge, stores their records and announces
// them; its normalizer turns them into controller.commands; the controller's consumer hands each to the legacy
// decision code. Every part moves on its own TickGenerator (inbound: intake, relay, consume, records, prune;
// controller: relay, consume, prune; bus: retry, prune), never on a clock read here.
//
// The sync lease is made here and shared: inbound polls under it, the legacy controller fences its deliveries with
// it. Tests drive the same path one step at a time through tickIntake and tickCommands, which drain the bus.

import { join } from "node:path";
import {
  BUS_PERIODS, SqlBus, scheduleBus, scheduleComponent, type BusPlugin, type EventBus, type Inbox, type Relay, type RetryScheduler,
} from "../../bus/index.js";
import { CONTROLLER, type ControllerContext } from "../../controller/index.js";
import { Controller, type ControllerDeps, type GitHubBudgetStatus } from "../../core/controller.js";
import type { FactoryConfig } from "../../core/config.js";
import { TickLease, syncLeaseName, syncLeaseOps } from "../../core/lease.js";
import { Listener } from "../../core/listener.js";
import { GITHUB_RATE_LIMIT } from "../../core/policy.js";
import { LiveSettings } from "../../core/settings.js";
import type { SourceType } from "../../core/types.js";
import { INBOUND, Inbound, type InboundContext } from "../../inbound/index.js";
import { TimeBasedTicks } from "../../shared/ticks/plugins/time-based/time-based-tick-generator.js";
import { tickAt, type Tick, type TickSource } from "../../shared/ticks/tick-generator.js";
import type { SqlDriver } from "../../state/index.js";
import { ComponentConsumer } from "../consumer.js";
import { loadRegistry, type Registry } from "../registry/registry.js";
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

/** The discovered handlers and topics, loaded once per process; startup refuses a broken dispatch. */
async function registry(): Promise<Registry> {
  const r = await (discovered ??= loadRegistry(CODE_ROOT));
  const problems = r.problems();
  if (problems.length > 0) throw new Error(`message dispatch is broken: ${problems.join("; ")}`);
  return r;
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

/** The live settings and the sync lease, made once and shared by inbound and the legacy controller. */
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
}

export class ControllerRole extends Controller {
  private readonly role: Prepared;
  private wiring?: Promise<Wiring>;

  constructor(deps: ControllerRoleDeps) {
    const d = prepare(deps);
    super(d);
    this.role = d;
  }

  override async run(signal: AbortSignal): Promise<void> {
    const w = await this.wire();
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
    await Promise.all([super.run(signal), w.inbound.run(signal), inbound.run(signal), controller.run(signal), bus.run(signal)]);
    // Shutting down: hand the sync lease over now instead of after lease_ms.
    await this.role.sync?.release();
  }

  /** One intake step: every source and the forge polled now, then their records through the bus to the decisions. */
  override async tickIntake(): Promise<void> {
    await this.role.settings.refresh();
    const w = await this.wire();
    const t = this.tick("intake");
    await w.inbound.tick(t, true);
    await this.drain(t);
    await super.tickIntake();
  }

  /** One command step: the command rows after the cursor, through the bus to the decisions, then their mirrors. */
  override async tickCommands(): Promise<void> {
    await this.role.settings.refresh();
    const w = await this.wire();
    const t = this.tick("commands");
    await w.inbound.relayCommands(t);
    await this.drain(t);
    await super.tickCommands();
  }

  /** Removes inbound records past inbox_retention_days, as inbound's `records` tick does. */
  async tickRecords(): Promise<void> {
    await (await this.wire()).inbound.prune(this.tick("records"));
  }

  private tick(schedule: string): Tick {
    return tickAt(schedule, 1, this.nowMs());
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
        context: (_tx, emit) => ({ db, emit, legacy: this }),
      }),
    };
  }
}
