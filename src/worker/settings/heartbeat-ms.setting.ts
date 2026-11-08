// Ported from src/core/settings.ts (RFC 0015 M10). Settable at runtime (`factory settings set`).

import { defineSetting } from "../../shared/setting.js";

export default defineSetting({
  key: "heartbeat_ms",
  owner: "worker",
  type: "integer",
  default: 60000,
  description: "How often a worker renews the lease on the step it runs.",
  applies: "the next lease renewal",
  direction: "free",
  changed_by: "runtime",
  scope: "global",
});
