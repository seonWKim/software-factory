// Design 09-notifications: which kinds of wait on the owner raise a notice. Settable at runtime (`factory settings set`).

import { defineSetting } from "../../shared/setting.js";

export default defineSetting({
  key: "notice_kinds",
  owner: "controller",
  type: "list",
  default: ["spec", "merge", "failure", "other"],
  description: "Which waits on the owner raise a notice: spec, merge, failure, other; a kind left out raises none.",
  applies: "the next notifications pass (each poll)",
  direction: "free",
  changed_by: "runtime",
  scope: "global",
});
