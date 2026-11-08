// Ported from src/core/settings.ts (RFC 0015 M10). Settable at runtime (`factory settings set`).

import { defineSetting } from "../../shared/setting.js";

export default defineSetting({
  key: "workers",
  owner: "worker",
  type: "integer",
  default: 1,
  description: "Worker loops in each process that claim and run steps.",
  applies: "the worker pool's next tick",
  direction: "free",
  changed_by: "runtime",
  scope: "global",
});
