// Ported from src/core/settings.ts (RFC 0015 M10). Changes by a reviewed PR to factory.config.json only.

import { defineSetting } from "../../shared/setting.js";

export default defineSetting({
  key: "plugins",
  owner: "runtime",
  type: "object",
  default: null,
  description: "Which named implementation the factory uses for each interface.",
  applies: null,
  direction: "free",
  changed_by: "review",
  scope: "global",
});
