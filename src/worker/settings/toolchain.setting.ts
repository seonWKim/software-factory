// Ported from src/core/settings.ts (RFC 0015 M10). Changes by a reviewed PR to factory.config.json only.

import { defineSetting } from "../../shared/setting.js";

export default defineSetting({
  key: "toolchain",
  owner: "worker",
  type: "object",
  default: null,
  description: "Cache folders agents may read but not write, their extra env, and the command that warms them.",
  applies: null,
  direction: "free",
  changed_by: "review",
  scope: "global",
});
