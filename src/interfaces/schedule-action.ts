// What a fired schedule occurrence does (design 08-schedules, phase 2): the ScheduleAction plugin kind
// (`plugins.schedule_action`, docs/plugins/schedule-action.md), optional with no default. The controller's schedule
// unit claims each due occurrence once (runDueSchedules, src/core/schedule.ts) and hands each fired one to the
// selected action. With no action selected, nothing is claimed.

import type { Schedule } from "../core/schedule.js";
import type { Timestamp } from "../core/types.js";

export interface ScheduleAction {
  /**
   * Runs one fired occurrence of `schedule`, due at `occurrence_at` (the slot, not the time it was claimed). Must be
   * safe to run twice for the same (schedule, occurrence_at): a crash after the claim and before the run ends may
   * hand it over again. A throw is that occurrence's failure; the schedule's run still ends.
   */
  run(schedule: Schedule, occurrence_at: Timestamp): Promise<void>;
}
