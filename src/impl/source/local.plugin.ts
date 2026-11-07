import { definePlugin } from "../../plugin-api.js";
import { LocalSource } from "./local-source.js";

export default definePlugin({
  kind: "source",
  name: "local",
  secrets: [],
  create: (c) => new LocalSource(c.store),
});
