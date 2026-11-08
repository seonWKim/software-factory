// Ported from src/core/settings.ts (RFC 0015 M10). Settable at runtime (`factory settings set`).

import { defineSetting } from "../../shared/setting.js";

export default defineSetting({
  key: "hold_policy",
  owner: "controller",
  type: "object",
  default: {
    "mode": "hold"
  },
  description: "What a run held by coordination cost does: wait for /approve, start after some minutes, or start.",
  applies: "the next claim",
  direction: "free",
  changed_by: "runtime",
  scope: "global",
});
