import { describe, expect, it } from "vitest";
import { COMMAND_RECEIVED, SOURCE_EVENT_RECEIVED, type Decisions } from "../../../../src/controller/index.js";
import legacy from "../../../../src/controller/handlers/legacy-controller/legacy-controller.handler.js";
import { storeRecord } from "../../../../src/inbound/records.js";
import { envelope } from "../../../../src/shared/envelope.js";
import { newStore } from "../../../helpers/store.js";

const NOW = "2026-11-08T00:00:00.000Z";

function message(type: string, payload: Record<string, string>, passport_id: string | null = null) {
  return envelope(
    { type, subject: "local", idempotency_key: Object.values(payload)[0]!, idempotency_key_ttl_ms: null, payload },
    { id: null, correlation_id: "c", project_id: "p", passport_id, occurred_at: NOW },
    "normalize-source",
  );
}

async function harness() {
  const { store } = await newStore();
  const calls: unknown[] = [];
  const decisions: Decisions = {
    consumeEvent: async (e) => void calls.push(["event", e]),
    consumeCommand: async (c) => void calls.push(["command", c.key]),
    deliveryCompleted: async () => {},
    receive: async () => {},
  };
  const run = (m: ReturnType<typeof message>) => legacy.handle(m, { db: store.db, decisions, emit: () => {}, recordAlert: async () => {} });
  return { store, calls, run };
}

describe("legacy-controller", () => {
  it("hands a command row to the legacy decision code", async () => {
    const h = await harness();
    const { command } = await h.store.appendCliCommand({ key: "cli:k1", actor: "local:alice", command: "approve", args: { item: "wi_1" } });
    await h.run(message(COMMAND_RECEIVED, { command_id: command.id }));
    expect(h.calls).toEqual([["command", "cli:k1"]]);
  });

  it("hands a stored event to the legacy decision code", async () => {
    const h = await harness();
    const event = { kind: "base_commit", sha: "abc" };
    const id = await h.store.db.transaction((tx) =>
      storeRecord(tx, "sqlite", { source_type: "github_issue", dedupe_key: "poll:x:0", event: event as never, received_at: NOW }),
    );
    await h.run(message(SOURCE_EVENT_RECEIVED, { record_id: id, kind: "base_commit" }));
    expect(h.calls).toEqual([["event", event]]);
  });

  it("a stream command event reaches the controller as stored: no passport, even on a message that names one", async () => {
    const h = await harness();
    const source = { type: "slack_thread", id: "C1/1", link: "https://slack.example/archives/C1/p1" };
    const who = { provider: "slack", subject: "7" };
    const received_at = "2026-11-01T00:00:00.000Z";
    const events = [
      { kind: "spec_approved", source, comment_id: "c1", approver: who, note: "" },
      { kind: "retry_requested", source, comment_id: "c2", requester: who },
      { kind: "plain_comment", source, comment_id: "c3", author: who, body: "hi" },
    ];
    for (const [i, event] of events.entries()) {
      const id = await h.store.db.transaction((tx) =>
        storeRecord(tx, "sqlite", { source_type: "slack_thread", dedupe_key: `ev${i}`, event: event as never, received_at }),
      );
      await h.run(message(SOURCE_EVENT_RECEIVED, { record_id: id, kind: event.kind }, "pp_1"));
    }
    expect(h.calls).toEqual(events.map((e) => ["event", e]));
  });

  it("a record or command that is gone decides nothing", async () => {
    const h = await harness();
    await h.run(message(SOURCE_EVENT_RECEIVED, { record_id: "rec_404", kind: "base_commit" }));
    await h.run(message(COMMAND_RECEIVED, { command_id: "cmd_missing" }));
    expect(h.calls).toEqual([]);
  });
});
