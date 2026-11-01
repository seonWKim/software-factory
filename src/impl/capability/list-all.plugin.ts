import { definePlugin } from "../../plugin-api.js";
import { ListAllCapabilitySearch } from "./list-all-capability-search.js";

export default definePlugin({
  kind: "capability",
  name: "list-all",
  default: true,
  create: (c) => new ListAllCapabilitySearch(c.capabilities),
});
