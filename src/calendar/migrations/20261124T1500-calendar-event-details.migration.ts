// An event's details (design 09-dashboard-tasks-calendar, event details, 2026-11-24): `details` on `calendar_events`,
// one JSON text of what the source's read already answers beyond the title and times (its calendar's name, place,
// notes, people, meeting and event links; src/calendar/event-details.ts). Neutral: no provider's fields. Additive: one
// nullable column, no backfill (the next sync, within 5 minutes, fills it), safe to rerun.

import { defineMigration, tableColumns } from "../../state/index.js";

export default defineMigration({
  change: "additive",
  tables: [],
  async up(db) {
    if (!(await tableColumns(db, "calendar_events")).includes("details")) await db.run("ALTER TABLE calendar_events ADD COLUMN details TEXT");
  },
});
