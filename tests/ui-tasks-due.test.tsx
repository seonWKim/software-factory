// @vitest-environment jsdom
/// <reference lib="dom" />
/// <reference lib="dom.iterable" />
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TasksPage, card, reset, row, s, show, teardown, view } from "./ui-tasks-fixtures.js";

void TasksPage;
beforeEach(reset);
afterEach(teardown);

// The row's due text drops the date its heading names and is in the browser locale, never the ISO text.
// Spaces are made plain: some ICU versions (Node 22's) put a narrow no-break space before "AM".
const dueOf = (id: string) => (card(id).querySelector("[data-details]")!.textContent ?? "").replace(/\s/g, " ");

describe("Tasks page: due text", () => {
  it("shows only the time under a dated heading or Today, and nothing for a task with no time", async () => {
    s.current = view({
      today: { overdue: [row("tk_late", { due_date: "2026-11-10" })], due: [row("tk_today", { due_date: "2026-11-12", due_time: "09:00" })] },
      projects: [{ list: null, tasks: [row("tk_day", { due_date: "2026-11-13", due_time: "09:00", priority: 1, list: "home" }), row("tk_plain", { due_date: "2026-11-13" })] }],
    });
    await show();
    expect(dueOf("tk_today")).toContain("due 9:00 AM");
    expect(dueOf("tk_day")).toContain("due 9:00 AM");
    expect(dueOf("tk_day")).toContain("!1");
    expect(dueOf("tk_day")).toContain("#home");
    expect(dueOf("tk_plain")).not.toContain("due");
    for (const id of ["tk_today", "tk_day", "tk_plain"]) expect(dueOf(id)).not.toMatch(/\d{4}-\d{2}-\d{2}/);
  });

  it("shows date and time under Overdue or Done, never the ISO text", async () => {
    s.current = view({
      today: { overdue: [row("tk_late", { due_date: "2026-11-10", due_time: "09:00" })], due: [] },
      projects: [{ list: null, tasks: [row("tk_done", { due_date: "2026-11-09", due_time: "09:00", done_at: "2026-11-09T10:00:00.000Z" })] }],
    });
    await show();
    expect(dueOf("tk_late")).toContain("due Nov 10, 9:00 AM");
    expect(dueOf("tk_done")).toContain("due Nov 9, 9:00 AM");
    expect(dueOf("tk_late")).not.toMatch(/\d{4}-\d{2}-\d{2}/);
  });
});
