// The build action (design 08-schedules): each fired occurrence files one local work item, its source ID from the
// schedule's ID and the slot, so running the same occurrence again files nothing more. Settings: `title` (else the
// schedule's title) and `body` (else empty). It calls no model; the item's own runs are counted on the item.

import type { ScheduleActionRoute } from "../ports.js";

const text = (v: unknown): string | null => (typeof v === "string" && v.trim() !== "" ? v.trim() : null);

export const buildAction: ScheduleActionRoute = async (schedule, _occurrence_at, ports) => {
  const title = text(schedule.settings.title) ?? schedule.title;
  const body = text(schedule.settings.body) ?? "";
  const filed = await ports.fileItem({ source_id: ports.occurrence_id, title, body });
  const output = filed === null ? "not filed: the leak scanner flagged the title or body" : `${filed.created ? "filed" : "already filed"} ${filed.id}`;
  await ports.record({ output, tokens: 0, cost_usd: null });
  if (filed === null) throw new Error(output);
};
