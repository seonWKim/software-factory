import { describe, expect, it } from "vitest";
import { COMMAND_RECEIVED, SOURCE_EVENT_RECEIVED, type LegacyDecisions } from "../../../../src/controller/index.js";
import legacy from "../../../../src/controller/handlers/legacy-controller/legacy-controller.handler.js";
import { storeRecord } from "../../../../src/inbound/records.js";
import { envelope } from "../../../../src/shared/envelope.js";
import { newStore } from "../../../helpers/store.js";

const NOW = "2026-11-08T00:00:00.000Z";

function message(type: string, payload: Record<string, string>) {
  return envelope(
    { type, subject: "local", idempotency_key: Object.values(payload)[0]!, idempotency_key_ttl_ms: null, payload },
    { id: null, correlation_id: "c", project_id: "p", passport_id: null, occurred_at: NOW },
    "normalize-source",
  );
}

async function harness() {
  const { store } = await newStore();
  const calls: unknown[] = [];
  const decisions: LegacyDecisions = {
    consumeEvent: async (e) => void calls.push(["event", e]),
    consumeCommand: async (c) => void calls.push(["command", c.key]),
  };
  const run = (m: ReturnType<typeof message>) => legacy.handle(m, { db: store.db, legacy: decisions, emit: () => {} });
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

  it("a record or command that is gone decides nothing", async () => {
    const h = await harness();
    await h.run(message(SOURCE_EVENT_RECEIVED, { record_id: "rec_404", kind: "base_commit" }));
    await h.run(message(COMMAND_RECEIVED, { command_id: "cmd_missing" }));
    expect(h.calls).toEqual([]);
  });
});
