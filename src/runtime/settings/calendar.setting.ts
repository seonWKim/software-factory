// Design 08-settings (2026-11-13): the calendars the factory reads, a live setting read by each process like
// `integrations`. Connect and disconnect (`factory setup calendar <command>` and the dashboard's Calendar section) write
// it after the plugin's secrets; the file's top-level `calendar` key is its value until then. Owner only.

import { defineSetting } from "../../shared/setting.js";

export default defineSetting({
  key: "calendar",
  owner: "runtime",
  type: "list",
  default: [],
  description: "Calendar plugins the factory reads, in order, over the calendar key in factory.config.json.",
  applies: "the next tick (the controller's next sync)",
  direction: "free",
  changed_by: "runtime",
  scope: "global",
});
