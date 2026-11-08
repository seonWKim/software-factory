// Ported from src/core/settings.ts (RFC 0015 M10). Changes by a reviewed PR to factory.config.json only.

import { defineSetting } from "../../shared/setting.js";

export default defineSetting({
  key: "secrets",
  owner: "guards",
  type: "string",
  default: null,
  description: "Which secret store tools read credentials from; agents never see them.",
  applies: null,
  direction: "tighten-only",
  tighter: "fixed",
  changed_by: "review",
  scope: "global",
  guard: true,
});
