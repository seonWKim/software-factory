// Ported from src/core/settings.ts (RFC 0015 M10). Changes by a reviewed PR to factory.config.json only.

import { defineSetting } from "../../shared/setting.js";

export default defineSetting({
  key: "store",
  owner: "state",
  type: "object",
  default: null,
  description: "Where the factory keeps its state: the store's driver and location.",
  applies: null,
  direction: "free",
  changed_by: "review",
  scope: "global",
});
