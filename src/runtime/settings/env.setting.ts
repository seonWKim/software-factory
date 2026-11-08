// Ported from src/core/settings.ts (RFC 0015 M10). Changes by a reviewed PR to factory.config.json only.

import { defineSetting } from "../../shared/setting.js";

export default defineSetting({
  key: "env",
  owner: "runtime",
  type: "enum",
  default: null,
  description: "Whether the factory runs locally or in the cloud.",
  applies: null,
  direction: "free",
  changed_by: "review",
  scope: "global",
});
