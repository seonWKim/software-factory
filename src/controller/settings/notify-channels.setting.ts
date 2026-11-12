// Design 09-notifications and 12-notification-channels: the source adapters that receive the owner's notices beside
// the dashboard and the desktop shell. Settable at runtime (`factory settings set`); one owner, so one list.

import { defineSetting } from "../../shared/setting.js";

export default defineSetting({
  key: "notify_channels",
  owner: "controller",
  type: "list",
  default: [],
  description: "Source plugins that also get the owner's notices, e.g. slack; one without notifyOwner gets none.",
  applies: "the next notifications pass (each poll)",
  direction: "free",
  changed_by: "runtime",
  scope: "global",
});
