// The Check a page action (design 08-schedules, 08-routines): each fired occurrence of a routine's schedule row
// queues its `routine` run on the routine's carrier item, keyed on the slot, so a second call for that slot queues
// nothing. The claim pass planned it with the routine planner (runDueCheckPages, src/core/routines.ts): the merge
// trigger, the daily cap's hold and the token cap's checkpoint come before this action. It records nothing on the
// run row: the run's model calls are recorded there when the run finishes (the routines unit's recordFindings).

import type { ScheduleActionRoute } from "../ports.js";

export const checkPageAction: ScheduleActionRoute = async (_schedule, _occurrence_at, ports) => {
  await ports.queueRoutine();
};
