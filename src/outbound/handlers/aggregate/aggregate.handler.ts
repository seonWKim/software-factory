// The aggregator's consumer (RFC 0015 §7 Outbound): each DeliveryRequested's intents join a batch of their
// destination, in the same transaction as the inbox row, so a redelivered request batches nothing twice.

import type { Envelope } from "../../../shared/envelope.js";
import { defineHandler } from "../../../shared/handler.js";
import { aggregate } from "../../aggregator/aggregator.js";
import type { OutboundContext } from "../../context.js";
import { DELIVERY_REQUESTED } from "../../topics/deliveries-requests.topic.js";

export default defineHandler<Envelope, OutboundContext>({
  name: "aggregate",
  accepts: [DELIVERY_REQUESTED],
  async handle(m, ctx) {
    const p = m.payload;
    const destination = String(p.destination);
    const intent_ids = (Array.isArray(p.intent_ids) ? p.intent_ids : []).map(String);
    if (intent_ids.length === 0) return;
    await aggregate(
      ctx.tx,
      { commit_id: String(p.commit_id), commit_count: Number(p.commit_count), destination, intent_ids, reply: p.reply === true },
      ctx.policy(destination),
      ctx.budget(destination),
      m.occurred_at,
    );
  },
});
