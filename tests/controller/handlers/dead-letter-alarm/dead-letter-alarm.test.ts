import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SqlBus } from "../../../../src/bus/index.js";
import { CONTROLLER, type ControllerContext, type LegacyDecisions } from "../../../../src/controller/index.js";
import { INBOUND, INBOUND_RECEIVED } from "../../../../src/inbound/index.js";
import { ComponentConsumer } from "../../../../src/runtime/consumer.js";
import { loadRegistry } from "../../../../src/runtime/registry/registry.js";
import { ensureDiscoveredTopicTables } from "../../../../src/runtime/registry/topic-tables.js";
import { envelope } from "../../../../src/shared/envelope.js";
import { tickAt } from "../../../../src/shared/ticks/tick-generator.js";
import { alarmCommand, alarmText, openAlarms } from "../../../../src/ui/alarms.js";
import { newStore } from "../../../helpers/store.js";

// The whole path of a dead letter (RFC 0015 §5.4): the bus dead-letters a message and announces it on
// system.alerts; the controller's consumer hands the notice to dead-letter-alarm; the alarm shows in Needs you.

const SRC = join(import.meta.dirname, "..", "..", "..", "..", "src");
const NOW = "2026-11-08T00:00:00.000Z";

async function harness() {
  const { store, clock } = await newStore();
  await ensureDiscoveredTopicTables("sqlite", store.db, SRC);
  const registry = await loadRegistry(SRC);
  const topics = registry.topics.map((t) => t.descriptor);
  const bus = new SqlBus();
  const inbound = bus.component({ db: store.db, component: INBOUND, topics, consumerId: "t" });
  const controllerBus = bus.component({ db: store.db, component: CONTROLLER, topics, consumerId: "t" });
  const legacy: LegacyDecisions = { consumeEvent: async () => {}, consumeCommand: async () => {} };
  const flagged: string[] = [];
  const alarms = new ComponentConsumer<ControllerContext>({
    db: store.db,
    bus: controllerBus,
    registry,
    component: CONTROLLER,
    transactional: false,
    context: (_tx, emit) => ({
      db: store.db,
      emit,
      legacy,
      // As the controller role does: a detail the scanner flags is dropped.
      recordAlert: async (alert, dedupe_ms) => {
        const clean = alert.detail !== null && !flagged.some((f) => alert.detail!.includes(f));
        await store.recordAlert({ ...alert, detail: clean ? alert.detail : null }, dedupe_ms);
      },
    }),
  });
  /** Publishes one inbound record, claims it as group `g` and dead-letters it. */
  const deadLetter = async (subject: string, code = "bad_input") => {
    const m = envelope(
      { type: INBOUND_RECEIVED, subject, idempotency_key: `rec:${subject}`, idempotency_key_ttl_ms: null, payload: { record_id: subject } },
      { id: null, correlation_id: "c", project_id: "p", passport_id: null, occurred_at: NOW },
      "test",
    );
    await store.db.transaction((tx) => inbound.publish(tx, [m]));
    await inbound.relay(tickAt("relay", 1, Date.parse(NOW)));
    const [c] = await inbound.consume("g", "inbound.records", 1);
    await inbound.nack(c!, { retryable: false, code, detail: `no record ${subject}` });
  };
  return { store, clock, alarms, deadLetter, flagged };
}

describe("dead-letter-alarm", () => {
  it("turns a dead letter's notice into an open alarm that names the topic and why", async () => {
    const h = await harness();
    await h.deadLetter("rec_1");
    expect(await h.alarms.consume()).toBe(1);

    const [alarm, ...rest] = await openAlarms(h.store, h.clock.now());
    expect(rest).toEqual([]);
    expect(alarm).toMatchObject({
      pattern: "dead_letter",
      pattern_key: expect.stringMatching(/^dead_letter:inbound\.records:g:\d+$/),
      error_code: "non_retryable",
      count: 1,
      detail: expect.stringContaining("InboundReceived"),
    });
    expect(alarm!.detail).toContain("bad_input: no record rec_1");
    expect(alarmText(alarm!)).toBe("Alarm: a message on inbound.records was dead-lettered (it failed in a way a retry cannot fix)");
    expect(alarmCommand(alarm!)).toContain("bus_inbound_records_dead_letters");
    // Handled once: nothing left to claim.
    expect(await h.alarms.consume()).toBe(0);
  });

  it("stores one alarm per dead letter, and drops a detail the scanner flags", async () => {
    const h = await harness();
    h.flagged.push("rec_secret");
    await h.deadLetter("rec_2");
    await h.deadLetter("rec_secret");
    // One topic's notices share a partition, handed out one at a time.
    expect(await h.alarms.consume()).toBe(1);
    expect(await h.alarms.consume()).toBe(1);
    const alerts = await h.store.listAlerts({ limit: 10 });
    expect(alerts).toHaveLength(2);
    expect(alerts.map((a) => a.detail === null).sort()).toEqual([false, true]);
  });
});
