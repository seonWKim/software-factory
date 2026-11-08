import { describe, expect, it } from "vitest";
import type { Decisions } from "../../../../src/controller/index.js";
import handler from "../../../../src/controller/handlers/delivery-results/delivery-results.handler.js";
import { DELIVERY_COMPLETED } from "../../../../src/outbound/index.js";
import { envelope } from "../../../../src/shared/envelope.js";
import { newStore } from "../../../helpers/store.js";

// DeliveryCompleted comes back to the controller (RFC 0015 M7): its intent ids go to the decisions, which record
// them on their items.

describe("delivery-results", () => {
  it("hands the batch's intent ids to the decisions", async () => {
    const { store } = await newStore();
    const got: string[][] = [];
    const decisions: Decisions = { consumeEvent: async () => {}, consumeCommand: async () => {}, deliveryCompleted: async (ids) => void got.push([...ids]) };
    const m = envelope(
      { type: DELIVERY_COMPLETED, subject: "d", idempotency_key: "b1", idempotency_key_ttl_ms: null, payload: { batch_id: "b1", destination: "d", intent_ids: ["int_3", "act_4"] } },
      { id: null, correlation_id: "b1", project_id: "p", passport_id: null, occurred_at: "2026-11-08T00:00:00.000Z" },
      "outbound",
    );
    await handler.handle(m, { db: store.db, decisions, emit: () => {}, recordAlert: async () => {} });
    expect(got).toEqual([["int_3", "act_4"]]);
  });
});
