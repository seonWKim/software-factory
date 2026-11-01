import { definePlugin } from "../../plugin-api.js";
import { NoneUpdater } from "./none.js";

export default definePlugin({
  kind: "updater",
  name: "none",
  create: () => new NoneUpdater(),
});
