// Ported from src/core/settings.ts (RFC 0015 M10). Settable at runtime (`factory settings set`).

import { defineSetting } from "../../shared/setting.js";

export default defineSetting({
  key: "models",
  owner: "worker",
  type: "object",
  default: {
    "cheap": "haiku",
    "standard": "sonnet",
    "strong": "opus"
  },
  description: "The model name used for each model class: cheap, standard and strong.",
  applies: "the next run that starts",
  direction: "free",
  changed_by: "runtime",
  scope: "global",
});
