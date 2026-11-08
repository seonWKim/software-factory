// A dead letter becomes an alarm (RFC 0015 §5.4, design 05-alarms): the bus announces each one on system.alerts,
// and this handler stores it as a `dead_letter` alert, which Needs you on the status page shows until the alarm
// window passes. One alert per dead letter: its key names the message and group, and it is kept as long as the
// notice is, so a notice delivered twice stores one alert.

import { DEAD_LETTERED, SYSTEM_ALERTS } from "../../../bus/index.js";
import type { Envelope } from "../../../shared/envelope.js";
import { defineHandler } from "../../../shared/handler.js";
import type { ControllerContext } from "../../index.js";

export default defineHandler<Envelope, ControllerContext>({
  name: "dead-letter-alarm",
  accepts: [DEAD_LETTERED],
  async handle(m, ctx) {
    const p = m.payload;
    await ctx.recordAlert(
      {
        pattern: "dead_letter",
        pattern_key: `dead_letter:${String(p.topic)}:${String(p.group)}:${String(p.seq)}`,
        error_code: String(p.error_code),
        count: Number(p.attempts),
        detail: `${String(p.message_type)} #${String(p.seq)} on ${String(p.topic)} for ${String(p.group)}: ${String(p.last_error)}`,
      },
      SYSTEM_ALERTS.retentionMs,
    );
  },
});
