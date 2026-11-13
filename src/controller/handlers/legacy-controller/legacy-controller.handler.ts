// The bridge from controller.commands to the controller units (RFC 0015 M4, M5): loads the record or the command a
// message names, through inbound's index.ts, and hands it to the router, whose unit decides and writes as a polled
// event or a command row always did. It goes when the units take messages with a pure load/decide split. Its name
// stays: it is the inbox consumer name of every message already handled.

import { readCommand, readRecord } from "../../../inbound/index.js";
import type { Envelope } from "../../../shared/envelope.js";
import { defineHandler } from "../../../shared/handler.js";
import type { ControllerContext } from "../../index.js";
import { COMMAND_RECEIVED, SOURCE_EVENT_RECEIVED } from "../../topics/controller-commands.topic.js";

export default defineHandler<Envelope, ControllerContext>({
  name: "legacy-controller",
  accepts: [COMMAND_RECEIVED, SOURCE_EVENT_RECEIVED],
  async handle(m, ctx) {
    if (m.type === COMMAND_RECEIVED) {
      const c = await readCommand(ctx.db, String(m.payload.command_id));
      if (c) await ctx.decisions.consumeCommand(c);
      return;
    }
    // A record pruned before it was handled (past inbox_retention_days) has nothing left to decide on.
    const r = await readRecord(ctx.db, String(m.payload.record_id));
    if (r) await ctx.decisions.consumeEvent(r.event);
  },
});
