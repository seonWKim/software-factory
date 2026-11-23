// The build action (design 08-schedules): each fired occurrence files one local work item, its source ID from the
// schedule's ID and the slot, so running the same occurrence again files nothing more. Settings: `title` (else the
// schedule's title) and `body` (else empty). It calls no model; the item's own runs are counted on the item.

import type { ScheduleActionRoute } from "../ports.js";

/** The slot as an ID part: `2026-11-23T00:00:00.000Z` → `20261123T000000Z`. */
const slotPart = (occurrence_at: string) => occurrence_at.replace(/[-:]|\.\d+/g, "");

/** The source ID of the work item `schedule_id`'s occurrence at `occurrence_at` files. */
export const buildSourceId = (schedule_id: string, occurrence_at: string): string => `schedule-${schedule_id}-${slotPart(occurrence_at)}`;

const text = (v: unknown): string | null => (typeof v === "string" && v.trim() !== "" ? v.trim() : null);

export const buildAction: ScheduleActionRoute = async (schedule, occurrence_at, ports) => {
  const title = text(schedule.settings.title) ?? schedule.title;
  const body = text(schedule.settings.body) ?? "";
  const filed = await ports.fileItem({ source_id: buildSourceId(schedule.id, occurrence_at), title, body });
  const output = filed === null ? "not filed: the leak scanner flagged the title or body" : `${filed.created ? "filed" : "already filed"} ${filed.id}`;
  await ports.record({ output, tokens: 0, cost_usd: null });
  if (filed === null) throw new Error(output);
};
