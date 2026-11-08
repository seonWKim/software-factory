// RFC 0015 §7 Merge queue: the speculative depth. Solo default 1 (RFC 0009); enterprise speculative depth N, 2 typical.

import { defineSetting } from "../../shared/setting.js";

export default defineSetting({
  key: "merge_queue.depth",
  owner: "controller",
  type: "integer",
  default: 1,
  description: "Merge queue entries checked at once from the head, each on the base plus those ahead (1 to 10).",
  applies: null,
  direction: "free",
  changed_by: "review",
  scope: "global",
});
