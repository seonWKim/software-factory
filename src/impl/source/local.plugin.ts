import { definePlugin } from "../../plugin-api.js";
import { LocalSource } from "./local-source.js";

// Intake from the store's CLI command log; replies are stored as item messages (issue #199). No secrets.
export default definePlugin({
  kind: "source",
  name: "local",
  create: (c) => new LocalSource(c.store),
});
