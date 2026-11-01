import { definePlugin } from "../../plugin-api.js";
import { SystemClock } from "./system-clock.js";

export default definePlugin({
  kind: "clock",
  name: "system",
  default: true,
  create: () => new SystemClock(),
});
