// Settable at runtime (`factory settings set`): design 08-settings, phase 1 of the live file-only keys.

import { defineSetting } from "../../shared/setting.js";

export default defineSetting({
  key: "intake_label",
  owner: "inbound",
  type: "string",
  default: null,
  description: "Label that takes a forge issue in as a new work item; an open item keeps the label it has.",
  applies: "the next item taken in",
  direction: "free",
  changed_by: "runtime",
  scope: "global",
});
