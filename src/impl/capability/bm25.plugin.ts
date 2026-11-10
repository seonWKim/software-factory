import { definePlugin } from "../../plugin-api.js";
import { packSkillDirs } from "../../packs/packs.js";
import { Bm25CapabilitySearch } from "./bm25-capability-search.js";

// Every pack layer's skills/ folder is an extra root (design 11-packs.md).
export default definePlugin({
  kind: "capability",
  name: "bm25",
  create: (c) => new Bm25CapabilitySearch(c.loaded.codeRoot, packSkillDirs(c.loaded.packs)),
});
