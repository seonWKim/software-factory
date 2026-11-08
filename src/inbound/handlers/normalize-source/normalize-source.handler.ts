// The normalizer of every source (RFC 0015 §4 step 2, M4): an InboundReceived becomes the controller's command.
// A command row becomes CommandReceived{command_id}; a source's or the forge's event becomes
// SourceEventReceived{record_id, kind}. The adapters already parse their source's shape into these events (one
// comment mapping for every source, src/core/comment-event.ts), so nothing is parsed again here. The message
// keeps the record's stream as its subject, so a source's messages stay in order.

import { COMMAND_RECEIVED, SOURCE_EVENT_RECEIVED } from "../../../controller/index.js";
import type { Envelope } from "../../../shared/envelope.js";
import { defineHandler } from "../../../shared/handler.js";
import type { InboundContext } from "../../context.js";
import { RECORD_TTL_MS } from "../../intake.js";
import { readCommand, readRecord } from "../../records.js";
import { INBOUND_RECEIVED } from "../../topics/inbound-records.topic.js";

export default defineHandler<Envelope, InboundContext>({
  name: "normalize-source",
  accepts: [INBOUND_RECEIVED],
  async handle(m, ctx) {
    const id = String(m.payload.record_id);
    if (m.payload.kind === "command") {
      const c = await readCommand(ctx.tx, id);
      // A person's command: its key never expires (RFC 0015 §5.2). The command row keeps the edge key.
      if (c) ctx.emit({ type: COMMAND_RECEIVED, subject: m.subject, idempotency_key: c.id, idempotency_key_ttl_ms: null, payload: { command_id: c.id } });
      return;
    }
    const r = await readRecord(ctx.tx, id);
    if (!r) return;
    ctx.emit({
      type: SOURCE_EVENT_RECEIVED,
      subject: m.subject,
      idempotency_key: id,
      idempotency_key_ttl_ms: RECORD_TTL_MS,
      payload: { record_id: id, kind: r.event.kind },
    });
  },
});
