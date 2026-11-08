import { describe, expect, it } from "vitest";
import { DEFAULT_BATCHING } from "../../../../src/outbound/index.js";
import aggregateHandler from "../../../../src/outbound/handlers/aggregate/aggregate.handler.js";
import { DELIVERY_REQUESTED } from "../../../../src/outbound/topics/deliveries-requests.topic.js";
import { envelope } from "../../../../src/shared/envelope.js";
import { newStore } from "../../../helpers/store.js";

// The aggregator (RFC 0015 §7, §15.1): a DeliveryRequested's intents join one batch of their destination; in auto
// mode a quiet destination's batch is due at once, and a chatty one's next commit joins the open batch.

const NOW = "2026-11-08T00:00:00.000Z";
const DEST = "github_issue:o/r#1";

function request(commit: string, ids: string[], at = NOW) {
  return envelope(
    { type: DELIVERY_REQUESTED, subject: DEST, idempotency_key: commit, idempotency_key_ttl_ms: null,
      payload: { commit_id: commit, commit_count: ids.length, destination: DEST, intent_ids: ids, reply: false } },
    { id: null, correlation_id: commit, project_id: "p", passport_id: null, occurred_at: at },
    "test",
  );
}

async function harness() {
  const { store } = await newStore();
  const run = (m: ReturnType<typeof request>) =>
    store.db.transaction((tx) => aggregateHandler.handle(m, { tx, emit: () => {}, policy: () => DEFAULT_BATCHING, budget: () => null }));
  const batches = () => store.db.all("SELECT id, state, intent_count, flush_at FROM outbound_batches ORDER BY seq");
  return { store, run, batches };
}

describe("aggregate", () => {
  it("one commit is one batch, due at once on a quiet destination", async () => {
    const h = await harness();
    await h.run(request("c1", ["int_1", "act_2"]));
    expect(await h.batches()).toEqual([expect.objectContaining({ state: "open", intent_count: 2, flush_at: NOW })]);
    const rows = await h.store.db.all("SELECT intent_id FROM outbound_batch_intents ORDER BY seq");
    expect(rows.map((r) => r.intent_id)).toEqual(["int_1", "act_2"]);
  });

  it("a chatty destination's batch waits its debounce, and the next commit joins it", async () => {
    const h = await harness();
    for (let i = 0; i < 3; i++) {
      await h.store.db.run(
        `INSERT INTO outbound_batches (id, destination, idempotency_key, state, intent_count, opened_at, flush_at, sent_at)
         VALUES (?, ?, ?, 'sent', 1, ?, ?, ?)`,
        [`old${i}`, DEST, `k${i}`, NOW, NOW, NOW],
      );
    }
    await h.run(request("c1", ["int_1"]));
    await h.run(request("c2", ["int_2"], "2026-11-08T00:00:01.000Z"));
    const open = (await h.batches()).filter((b) => b.state === "open");
    expect(open).toEqual([expect.objectContaining({ intent_count: 2, flush_at: "2026-11-08T00:00:03.000Z" })]);
  });
});
