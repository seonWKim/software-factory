// RFC 0015 §15.2: hooks are off until the owner enables each one. Changes by a reviewed PR to factory.config.json only.

import { defineSetting } from "../../shared/setting.js";

export default defineSetting({
  key: "hooks",
  owner: "runtime",
  type: "list",
  default: [],
  description: "Hook names the owner enabled; a hook runs only when listed here. Empty: no hook runs.",
  applies: null,
  direction: "tighten-only",
  tighter: "more",
  changed_by: "review",
  scope: "global",
});
