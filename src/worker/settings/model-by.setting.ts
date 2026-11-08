// Ported from src/core/settings.ts (RFC 0015 M10). Settable at runtime (`factory settings set`).

import { defineSetting } from "../../shared/setting.js";

export default defineSetting({
  key: "model_by",
  owner: "worker",
  type: "object",
  default: {
    "triage": "cheap",
    "implement": {
      "1": "standard",
      "2": "standard",
      "3": "strong",
      "4": "strong",
      "5": "strong"
    },
    "review": "standard",
    "resolve": {
      "1": "standard",
      "2": "standard",
      "3": "strong",
      "4": "strong",
      "5": "strong"
    },
    "retry_up": true
  },
  description: "Which model class each run kind uses per tier, and whether a retry goes one class up.",
  applies: "the next run that starts",
  direction: "free",
  changed_by: "runtime",
  scope: "global",
});
