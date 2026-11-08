// Ported from src/core/settings.ts (RFC 0015 M10). Changes by a reviewed PR to factory.config.json only.

import { defineSetting } from "../../shared/setting.js";

export default defineSetting({
  key: "broker",
  owner: "guards",
  type: "string",
  default: null,
  description: "Which tool broker runs the forge actions agents ask for, such as a push.",
  applies: null,
  direction: "tighten-only",
  tighter: "fixed",
  changed_by: "review",
  scope: "global",
  guard: true,
});
