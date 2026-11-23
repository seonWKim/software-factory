import { definePlugin } from "../../plugin-api.js";
import { RoutedScheduleAction } from "./routed-action.js";

// The ScheduleAction that routes each fired occurrence to its schedule's action kind (docs/plugins/schedule-action.md):
// on when `plugins.schedule_action` is "routed". Not a default: the kind is optional and takes none.
export default definePlugin({
  kind: "schedule_action",
  name: "routed",
  create: (c) => new RoutedScheduleAction(c),
});
