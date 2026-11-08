// What outbound delivered comes back to the controller (RFC 0015 §7, M7): DeliveryCompleted names the batch's
// intents, and the outbox unit records each delivered thread entry on its item (its link field, e.g. the spec
// comment's URL). Recording is idempotent, so a redelivered result changes nothing.

import { DELIVERY_COMPLETED } from "../../../outbound/index.js";
import type { Envelope } from "../../../shared/envelope.js";
import { defineHandler } from "../../../shared/handler.js";
import type { ControllerContext } from "../../index.js";

export default defineHandler<Envelope, ControllerContext>({
  name: "delivery-results",
  accepts: [DELIVERY_COMPLETED],
  async handle(m, ctx) {
    const ids = Array.isArray(m.payload.intent_ids) ? m.payload.intent_ids.map(String) : [];
    if (ids.length > 0) await ctx.decisions.deliveryCompleted(ids);
  },
});
