// Design 08-settings (2026-11-12): the owner turns an integration (an interface marked `integration` in src/plugins.ts,
// the tacit ledger today) on or off from the dashboard, with no restart. Owner only, set at runtime (`factory settings set`).

import { defineSetting } from "../../shared/setting.js";

export default defineSetting({
  key: "integrations",
  owner: "runtime",
  type: "object",
  default: {},
  description: "Which plugin each integration uses, over the plugins key in factory.config.json.",
  applies: "the next tick, and the next Rules page request",
  direction: "free",
  changed_by: "runtime",
  scope: "global",
});
