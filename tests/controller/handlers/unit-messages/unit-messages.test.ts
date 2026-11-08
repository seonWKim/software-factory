import { describe, expect, it } from "vitest";
import { MERGE_CHECK_TIMED_OUT, type Decisions } from "../../../../src/controller/index.js";
import handler from "../../../../src/controller/handlers/unit-messages/unit-messages.handler.js";
import { type Envelope, envelope } from "../../../../src/shared/envelope.js";
import { newStore } from "../../../helpers/store.js";

// A unit's own message on controller.events (RFC 0015 §7) goes back to the decisions, which hand it to the unit.

describe("unit-messages", () => {
  it("takes every controller.events type and hands the message to the decisions as it is", async () => {
    expect(handler.accepts).toEqual([MERGE_CHECK_TIMED_OUT]);
    const { store } = await newStore();
    const got: Envelope[] = [];
    const decisions: Decisions = { consumeEvent: async () => {}, consumeCommand: async () => {}, deliveryCompleted: async () => {}, receive: async (m) => void got.push(m) };
    const m = envelope(
      { type: MERGE_CHECK_TIMED_OUT, subject: "mq:p:main", idempotency_key: "e1:check:v1:timeout", idempotency_key_ttl_ms: 1_000, payload: { entry_id: "e1", run_key: "e1:check:v1" } },
      { id: null, correlation_id: "c", project_id: "p", passport_id: null, occurred_at: "2026-11-08T00:00:00.000Z" },
      "controller",
    );
    await handler.handle(m, { db: store.db, decisions, emit: () => {}, recordAlert: async () => {} });
    expect(got).toEqual([m]);
  });
});
