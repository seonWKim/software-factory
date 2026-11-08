import { definePlugin } from "../../plugin-api.js";
import { ManualTicks } from "../../shared/ticks/plugins/manual/manual-tick-generator.js";

// For tests: nothing ticks until the test calls tick() (docs/plugins/tick-generator.md).
export default definePlugin({
  kind: "ticks",
  name: "manual",
  create: () => new ManualTicks(),
});
