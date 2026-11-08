import { definePlugin } from "../../plugin-api.js";
import { TimeBasedTicks } from "../../shared/ticks/plugins/time-based/time-based-tick-generator.js";

// The default: each schedule ticks on the system clock at its period (docs/plugins/tick-generator.md).
export default definePlugin({
  kind: "ticks",
  name: "time-based",
  default: true,
  create: () => new TimeBasedTicks(),
});
