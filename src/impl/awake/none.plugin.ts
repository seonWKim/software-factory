import { definePlugin } from "../../plugin-api.js";
import { NoKeepAwake } from "./no-keep-awake.js";

export default definePlugin({
  kind: "awake",
  name: "none",
  /** Every platform but darwin, where caffeinate claims the default. */
  default: true,
  create: () => new NoKeepAwake(),
});
