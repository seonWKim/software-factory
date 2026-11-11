// Design 04-agents, "The owner's message style": the owner's wording and tone, appended after the role
// instructions of each model call that writes owner text. Settable at runtime (`factory settings set`); egress-scanned
// on write, at most 1000 characters.

import { defineSetting } from "../../shared/setting.js";

export default defineSetting({
  key: "message_style",
  owner: "worker",
  type: "string",
  default: "",
  description: "The owner's wording and tone for text the agents write, added after each role's instructions.",
  applies: "the next model call",
  direction: "free",
  changed_by: "runtime",
  scope: "global",
});
