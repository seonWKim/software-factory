import { definePlugin } from "../../plugin-api.js";
import { PatternEgressScanner } from "./pattern-egress-scanner.js";

export default definePlugin({
  kind: "egress",
  name: "pattern",
  default: true,
  create: (c) => new PatternEgressScanner(() => c.secrets.valuesForScan()),
});
