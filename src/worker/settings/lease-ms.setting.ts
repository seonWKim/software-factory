// Ported from src/core/settings.ts (RFC 0015 M10). Settable at runtime (`factory settings set`).

import { defineSetting } from "../../shared/setting.js";

export default defineSetting({
  key: "lease_ms",
  owner: "worker",
  type: "integer",
  default: 300000,
  description: "How long a claimed step stays held by a worker without a lease renewal.",
  applies: "the next claim or lease renewal",
  direction: "free",
  changed_by: "runtime",
  scope: "global",
});
