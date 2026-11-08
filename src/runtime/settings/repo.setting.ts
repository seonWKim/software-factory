// Ported from src/core/settings.ts (RFC 0015 M10). Changes by a reviewed PR to factory.config.json only.

import { defineSetting } from "../../shared/setting.js";

export default defineSetting({
  key: "repo",
  owner: "runtime",
  type: "object",
  default: null,
  description: "The repository the factory works on, its base branch and its install and test commands.",
  applies: null,
  direction: "free",
  changed_by: "review",
  scope: "global",
});
