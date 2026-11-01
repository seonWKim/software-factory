import { definePlugin } from "../../plugin-api.js";
import { Bm25CapabilitySearch } from "./bm25-capability-search.js";

export default definePlugin({
  kind: "capability",
  name: "bm25",
  create: (c) => new Bm25CapabilitySearch(c.loaded.codeRoot),
});
