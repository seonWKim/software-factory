// Ported from src/core/settings.ts (RFC 0015 M10). Changes by a reviewed PR to factory.config.json only.

import { defineSetting } from "../../shared/setting.js";

export default defineSetting({
  key: "auth",
  owner: "identity",
  type: "string",
  default: null,
  description: "Which auth plugin checks who a request comes from.",
  applies: null,
  direction: "tighten-only",
  tighter: "fixed",
  changed_by: "review",
  scope: "global",
  dial: true,
});
