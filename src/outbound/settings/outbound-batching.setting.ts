// RFC 0015 §15.1 (owner decision 2026-11-08): how outbound batches each kind of destination.

import { defineSetting } from "../../shared/setting.js";

export default defineSetting({
  key: "outbound.batching",
  owner: "outbound",
  type: "object",
  default: {},
  description: "Per destination kind or `*`: batching mode (auto, commit, fixed), debounce, max_wait, max_messages.",
  applies: null,
  direction: "free",
  changed_by: "review",
  scope: "global",
});
