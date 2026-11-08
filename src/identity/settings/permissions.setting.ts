// Ported from src/core/settings.ts (RFC 0015 M10). Changes by a reviewed PR to factory.config.json only.

import { defineSetting } from "../../shared/setting.js";

export default defineSetting({
  key: "permissions",
  owner: "identity",
  type: "object",
  default: null,
  description: "Which grant sources decide who may act on the factory, and their settings.",
  applies: null,
  direction: "tighten-only",
  tighter: "fixed",
  changed_by: "review",
  scope: "global",
  dial: true,
});
