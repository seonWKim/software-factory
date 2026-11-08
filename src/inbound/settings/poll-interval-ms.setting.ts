// Ported from src/core/settings.ts (RFC 0015 M10). Settable at runtime (`factory settings set`).

import { defineSetting } from "../../shared/setting.js";

export default defineSetting({
  key: "poll_interval_ms",
  owner: "inbound",
  type: "integer",
  default: 30000,
  description: "How often the factory polls the forge for new work items and comments.",
  applies: "the next tick",
  direction: "free",
  changed_by: "runtime",
  scope: "global",
});
