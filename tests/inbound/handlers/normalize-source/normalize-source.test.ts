import { describe, expect, it } from "vitest";
import { COMMAND_RECEIVED, SOURCE_EVENT_RECEIVED } from "../../../../src/controller/index.js";
import { INBOUND_RECEIVED } from "../../../../src/inbound/index.js";
import normalize from "../../../../src/inbound/handlers/normalize-source/normalize-source.handler.js";
import { storeRecord } from "../../../../src/inbound/records.js";
import { envelope, type Draft } from "../../../../src/shared/envelope.js";
import { newStore } from "../../../helpers/store.js";

const NOW = "2026-11-08T00:00:00.000Z";

function received(record_id: string, kind: "event" | "command", subject: string) {
  return envelope(
    { type: INBOUND_RECEIVED, subject, idempotency_key: record_id, idempotency_key_ttl_ms: null, payload: { record_id, kind } },
    { id: null, correlation_id: record_id, project_id: "p", passport_id: null, occurred_at: NOW },
    "inbound",
  );
}

async function handle(m: ReturnType<typeof received>) {
  const { store } = await newStore();
  return { store, run: async () => {
    const out: Draft[] = [];
    await normalize.handle(m, { tx: store.db, emit: (d) => void out.push(d) });
    return out;
  } };
}

describe("normalize-source", () => {
  it("a stored event becomes SourceEventReceived with its record id and kind, in its stream", async () => {
    const { store } = await newStore();
    const id = await store.db.transaction((tx) =>
      storeRecord(tx, "sqlite", { source_type: "github_issue", dedupe_key: "poll:x:0", event: { kind: "base_commit" } as never, received_at: NOW }),
    );
    const out: Draft[] = [];
    await normalize.handle(received(id, "event", "github_issue"), { tx: store.db, emit: (d) => void out.push(d) });
    expect(out).toEqual([
      expect.objectContaining({ type: SOURCE_EVENT_RECEIVED, subject: "github_issue", idempotency_key: id, payload: { record_id: id, kind: "base_commit" } }),
    ]);
  });

  it("a command row becomes CommandReceived keyed by the command's id, never expiring", async () => {
    const { store } = await newStore();
    const { command } = await store.appendCliCommand({ key: "cli:k1", actor: "local:alice", command: "approve", args: { item: "wi_1" } });
    const out: Draft[] = [];
    await normalize.handle(received(command.id, "command", "local"), { tx: store.db, emit: (d) => void out.push(d) });
    expect(out).toEqual([
      expect.objectContaining({ type: COMMAND_RECEIVED, subject: "local", idempotency_key: command.id, idempotency_key_ttl_ms: null, payload: { command_id: command.id } }),
    ]);
  });

  it("a record pruned before it was normalized emits nothing", async () => {
    const h = await handle(received("rec_999", "event", "github_issue"));
    expect(await h.run()).toEqual([]);
  });
});
