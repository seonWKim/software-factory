import { describe, expect, it } from "vitest";
import { type FactoryConfig, RETENTION_DEFAULTS, type RetentionDays, retentionConfig } from "../src/core/config.js";
import type { Timestamp } from "../src/core/types.js";
import type { FakeClock } from "../src/impl/clock/fake-clock.js";
import type { FactoryStore } from "../src/interfaces/factory-store.js";
import { ControllerRole } from "../src/runtime/roles/controller-role.js";
import { RETENTION } from "../src/controller/units/retention/retention.unit.js";
import { FakeAuth, cleanScanner, config, silent } from "./helpers/fakes.js";
import { issue, newStore, system, w1 } from "./helpers/store.js";

// The daily retention pass (design 08-retention): the controller role's `retention` tick, under the store lease
// `retention`, with the day mark in the store cursor `retention`. The guards of each class are the store's
// (tests/store-contract.test.ts, retention); here: the lease, the day mark, the zero case and running it twice.

const DAY = 86_400_000;

function controller(store: FactoryStore, clock: FakeClock, replica_id: string, retention: RetentionDays = RETENTION_DEFAULTS) {
  const cfg: FactoryConfig = { ...config, retention };
  return new ControllerRole({ store, auth: new FakeAuth(), clock, config: cfg, log: silent, scanner: cleanScanner, replica_id });
}

/** A store whose acquireSyncLease calls are counted. */
function counting(store: FactoryStore): { store: FactoryStore; leases: () => number } {
  let n = 0;
  const wrapped = new Proxy(store, {
    get(target, prop, receiver) {
      if (prop === "acquireSyncLease") return (...a: Parameters<FactoryStore["acquireSyncLease"]>) => (n++, target.acquireSyncLease(...a));
      const v = Reflect.get(target, prop, receiver) as unknown;
      return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(target) : v;
    },
  });
  return { store: wrapped, leases: () => n };
}

/** One row of each class, all old once the clock moves on: a delivered outbox row, a read command, a host sleep. */
async function seed(store: FactoryStore, clock: FakeClock, n = 1): Promise<void> {
  const { item } = await store.createWorkItem(issue(n), system, { enqueue: { kind: "triage", idempotency_key: `${n}:triage` } });
  await store.recordItemMessage({ work_item_id: item.id, marker: `<!-- m${n} -->`, body: "b", delivery: { source_type: "github_issue", target: issue(n).source } });
  for (const row of await store.listPendingDeliveries(["github_issue"], 10)) await store.finishDelivery(row.seq, (await store.claimDelivery(row.seq, 60_000))!, null);
  const { command } = await store.appendCliCommand({ key: `cli:${n}`, actor: "local:me", command: "approve", args: {} });
  const cursor = await store.getCursor("commands");
  await store.advanceCursor("commands", cursor, String(command.seq));
  await store.recordHostSleep({ worker_id: w1, woke_at: clock.now().toISOString() as Timestamp, gap_ms: 120_000, run_id: null });
}

/** Rows left per pruned table, from the store's table list. */
async function rows(store: FactoryStore): Promise<Record<string, number>> {
  const names = ["outbound_intents", "inbound_commands", "worker_host_sleeps"];
  return Object.fromEntries((await store.listTables()).filter((t) => names.includes(t.name)).map((t) => [t.name, t.rows]));
}

const NONE = { outbound_intents: 0, inbound_commands: 0, worker_host_sleeps: 0 };
const ONE = { outbound_intents: 1, inbound_commands: 1, worker_host_sleeps: 1 };

describe("the daily retention step", () => {
  it("prunes every class past its days, marks the UTC day in the cursor and releases the lease", async () => {
    const { store, clock } = await newStore();
    await seed(store, clock);
    clock.advance(100 * DAY);
    await controller(store, clock, "replica-a").tickRetention();
    expect(await rows(store)).toEqual(NONE);
    expect(await store.getCursor(RETENTION)).toBe(clock.now().toISOString().slice(0, 10));
    const lease = (await store.getSyncLease(RETENTION))!;
    expect(lease.owner).toBe("replica-a");
    expect(Date.parse(lease.expires_at)).toBeLessThanOrEqual(clock.now().getTime());
  });

  it("keeps rows younger than their days", async () => {
    const { store, clock } = await newStore();
    await seed(store, clock);
    clock.advance(29 * DAY);
    await controller(store, clock, "replica-a").tickRetention();
    expect(await rows(store)).toEqual(ONE);
  });

  it("a replica that holds no lease does nothing; two controllers on one store run one pass per day", async () => {
    const { store, clock } = await newStore();
    await seed(store, clock);
    clock.advance(100 * DAY);
    const a = controller(store, clock, "replica-a");
    const b = controller(store, clock, "replica-b");
    // B holds the lease (its pass is running): A deletes nothing and marks nothing.
    const held = await store.acquireSyncLease(RETENTION, "replica-b", 60_000);
    if (!held.ok) throw new Error("lease not taken");
    await a.tickRetention();
    expect(await rows(store)).toEqual(ONE);
    expect(await store.getCursor(RETENTION)).toBeNull();
    await store.releaseSyncLease(RETENTION, held.lease.token);

    await a.tickRetention();
    expect(await rows(store)).toEqual(NONE);
    // Rows that turn old later the same day wait for the next day: B reads the mark and deletes nothing.
    await seed(store, clock, 2);
    clock.advance(DAY / 4);
    const marked = await store.getCursor(RETENTION);
    await b.tickRetention();
    expect(await rows(store)).toEqual(ONE);
    expect(await store.getCursor(RETENTION)).toBe(marked);
    clock.advance(100 * DAY);
    await b.tickRetention();
    expect(await rows(store)).toEqual(NONE);
  });

  it("caches the day it finished: a second tick that day makes no store call", async () => {
    const { store: raw, clock } = await newStore();
    const { store, leases } = counting(raw);
    clock.advance(DAY);
    const c = controller(store, clock, "replica-a");
    await c.tickRetention();
    await c.tickRetention();
    expect(leases()).toBe(1);
    clock.advance(DAY);
    await c.tickRetention();
    expect(leases()).toBe(2);
  });

  it("a class set to 0 is skipped entirely; the others still run", async () => {
    const { store, clock } = await newStore();
    await seed(store, clock);
    clock.advance(400 * DAY);
    await controller(store, clock, "replica-a", { outbox_days: 0, commands_days: 30, records_days: 0 }).tickRetention();
    expect(await rows(store)).toEqual({ outbound_intents: 1, inbound_commands: 0, worker_host_sleeps: 1 });
  });

  it("is safe to run twice: a second pass on the same rows deletes nothing and does not fail", async () => {
    const { store, clock } = await newStore();
    await seed(store, clock);
    clock.advance(100 * DAY);
    const unit = await controller(store, clock, "replica-a").unit("retention");
    await Promise.all([unit.retentionStep(store), controller(store, clock, "replica-b").tickRetention()]);
    expect(await rows(store)).toEqual(NONE);
    // A new day, the same (pruned) rows: nothing more, no error.
    clock.advance(DAY);
    await expect(unit.retentionStep(store)).resolves.toBeUndefined();
    expect(await rows(store)).toEqual(NONE);
  });

  it("loops a class while a batch comes back full", async () => {
    const { store, clock } = await newStore();
    for (let n = 1; n <= 3; n++) await store.recordHostSleep({ worker_id: w1, woke_at: new Date(clock.now().getTime() + n).toISOString() as Timestamp, gap_ms: 1, run_id: null });
    clock.advance(100 * DAY);
    const calls: number[] = [];
    const small = new Proxy(store, {
      get(target, prop, receiver) {
        if (prop === "pruneRecords") {
          return async (ms: number) => {
            const r = await target.pruneRecords(ms, 1);
            calls.push(r.worker_host_sleeps!);
            // Reported as full while it deleted one, as a batch at the limit would be.
            return r.worker_host_sleeps === 1 ? { worker_host_sleeps: 500 } : r;
          };
        }
        const v = Reflect.get(target, prop, receiver) as unknown;
        return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(target) : v;
      },
    });
    await (await controller(store, clock, "replica-a").unit("retention")).retentionStep(small);
    expect(calls).toEqual([1, 1, 1, 0]);
    expect((await rows(store)).worker_host_sleeps).toBe(0);
  });
});

describe("the retention config", () => {
  it("absent, it gives 30, 30 and 90 days; set keys override, 0 included", () => {
    expect(retentionConfig(undefined)).toEqual({ outbox_days: 30, commands_days: 30, records_days: 90 });
    expect(retentionConfig({ commands_days: 0 })).toEqual({ outbox_days: 30, commands_days: 0, records_days: 90 });
  });

  it("a negative or non-integer value fails with a message that names the key", () => {
    expect(() => retentionConfig({ outbox_days: -1 })).toThrow(/retention\.outbox_days must be an integer of 0 or more/);
    expect(() => retentionConfig({ records_days: 2.5 })).toThrow(/retention\.records_days/);
    expect(() => retentionConfig({ commands_days: "30" })).toThrow(/retention\.commands_days/);
    expect(() => retentionConfig([])).toThrow(/retention must be an object/);
  });
});
