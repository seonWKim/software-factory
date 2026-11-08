// Ported from src/core/settings.ts (RFC 0015 M10). Changes by a reviewed PR to factory.config.json only.

import { defineSetting } from "../../shared/setting.js";

export default defineSetting({
  key: "egress",
  owner: "guards",
  type: "string",
  default: null,
  description: "Which scanner checks outgoing text and withholds what looks like a secret.",
  applies: null,
  direction: "tighten-only",
  tighter: "fixed",
  changed_by: "review",
  scope: "global",
  guard: true,
});
