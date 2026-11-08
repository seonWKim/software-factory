import { describe, expect, it } from "vitest";
import type { SourceRef } from "../../src/core/types.js";
import { Outbound, recordAction } from "../../src/outbound/index.js";
import type { Delivery, DeliveryTarget } from "../../src/outbound/targets/target.js";
import { tickAt } from "../../src/shared/ticks/tick-generator.js";
import { cleanScanner, silent } from "../helpers/fakes.js";
import { newStore } from "../helpers/store.js";

// A flush sends at most 50 batches. Batches for a destination kind this process cannot write (no adapter here, or
// the sync lease is another replica's) stay due; they must not fill those 50 and starve the kinds it can write.

const NOW = Date.parse("2026-11-09T01:00:00Z");
const at = new Date(NOW - 1000).toISOString();

type Db = Parameters<typeof recordAction>[0];
const status = { action: "status", args: { status: "implementing", change_ref: null } } as const;

async function batch(db: Db, n: number, target: SourceRef, a: { action: "status" | "post"; args: Record<string, string | null> } = status): Promise<void> {
  await recordAction(db, { ...a, target }, at);
  const [{ seq }] = (await db.all("SELECT MAX(seq) AS seq FROM outbound_actions")) as { seq: number }[];
  const id = `b${n}`;
  await db.run(
    "INSERT INTO outbound_batches (id, destination, idempotency_key, state, intent_count, opened_at, flush_at) VALUES (?, ?, ?, 'open', 1, ?, ?)",
    [id, `${target.type}:${target.id}`, `k${n}`, at, at],
  );
  await db.run("INSERT INTO outbound_batch_intents (intent_id, batch_id, commit_id, commit_count) VALUES (?, ?, ?, 1)", [`act_${seq}`, id, `c${n}`]);
}

function outboundOver(db: Db, store: ConstructorParameters<typeof Outbound>[0]["store"], sent: Delivery[]): Outbound {
  const local: DeliveryTarget = {
    name: "local",
    accepts: (d) => d.kind === "action" && d.row.target.type === "local",
    deliver: async (d) => (sent.push(d), { url: null }),
  };
  return new Outbound({
    db: db as ConstructorParameters<typeof Outbound>[0]["db"], store, targets: [local], scanner: cleanScanner, log: silent,
    bus: { publish: async () => {} } as unknown as ConstructorParameters<typeof Outbound>[0]["bus"],
    config: () => ({ lease_ms: 60_000, retry_base_ms: 1000, retry_max_ms: 60_000, project_key: "p" }),
    canSend: () => true,
    kinds: () => ["local"],
    fenceFor: () => null,
    fenceRefused: async () => {},
  });
}

describe("outbound flush", () => {
  it("sends a kind it can write although 60 destinations of a kind it cannot are due first", async () => {
    const { store } = await newStore();
    const db = store.db;
    for (let i = 0; i < 60; i++) await batch(db, i, { type: "slack_thread", id: `slack:T:C:${i}`, link: "l" });
    await batch(db, 60, { type: "local", id: "local-1", link: "l" });

    const sent: Delivery[] = [];
    const outbound = outboundOver(db, store, sent);

    expect(await outbound.flush(tickAt("outbound-flush", 250, NOW))).toBe(1);
    expect(sent.map((d) => d.kind === "action" && d.row.target.id)).toEqual(["local-1"]);
  });

  it("a post the egress scan flags goes out once as a withheld notice, and the destination's next batch follows", async () => {
    const { store } = await newStore();
    const target: SourceRef = { type: "local", id: "local-1", link: "l" };
    await batch(store.db, 0, target, { action: "post", args: { body: `push with ghp_${"a".repeat(36)}`, marker: "m0" } });
    await batch(store.db, 1, target, { action: "post", args: { body: "all clear", marker: "m1" } });
    const sent: Delivery[] = [];
    const outbound = outboundOver(store.db, store, sent);

    await outbound.flush(tickAt("outbound-flush", 250, NOW));
    await outbound.flush(tickAt("outbound-flush", 250, NOW + 1));
    await outbound.flush(tickAt("outbound-flush", 250, NOW + 3_600_000));

    const bodies = sent.map((d) => (d.kind === "action" ? String(d.row.args.body) : ""));
    expect(bodies).toEqual([expect.stringMatching(/^A factory message was withheld by the leak scanner \(.+\)\./), "all clear"]);
    expect(JSON.stringify(sent)).not.toContain("ghp_");
  });
});
