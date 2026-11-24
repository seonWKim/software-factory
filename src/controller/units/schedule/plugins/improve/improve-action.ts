// The improve action (design 08-schedules, 07-self-improvement): each fired occurrence queues the daily improve run
// of its slot's UTC day, under the key the controller's daily step uses (`improve:<project>:daily:<day>`), so a second
// occurrence that day, or the controller's own daily step, queues nothing more. No settings; it calls no model: the
// improve run's own model calls are counted on the run.

import type { DailyImproveQueue, ScheduleActionRoute } from "../ports.js";

/** The improve route over `queue` (compose binds it to the store and the project). */
export const improveAction = (queue: DailyImproveQueue): ScheduleActionRoute => async (_schedule, occurrence_at, ports) => {
  const { run, created } = await queue(occurrence_at);
  await ports.record({ output: `${created ? "queued" : "already queued"} improve run ${run.id} (${run.idempotency_key})`, tokens: 0, cost_usd: null });
};
