import { describe, expect, it } from "vitest";
import { DONE_WINDOW_DAYS, type NewTask, doneWindow, localDate, taskViews } from "../src/core/tasks.js";
import type { Timestamp, UserId, WorkItemId } from "../src/core/types.js";
import { FakeClock } from "../src/impl/clock/fake-clock.js";
import { PatternEgressScanner } from "../src/impl/egress/pattern-egress-scanner.js";
import { HealthMonitor } from "../src/ui/health.js";
import { type ApiDeps, respond } from "../src/ui/server.js";
import { newCsrfToken } from "../src/ui/settings-api.js";
import { TASKS_PATH } from "../src/ui/tasks-api.js";
import { newStore } from "./helpers/store.js";

// Done tasks stay on the Tasks page (design 02-tasks, done tasks stay): GET /api/v1/tasks reads the open tasks and the
// done tasks of the last DONE_WINDOW_DAYS days (listDoneTasks over doneWindow) into the same views, each done row with
// its done_at. A task closed by its merged work item (closeLinkedTasks) stays too. Reopen is the existing reopenTask and
// its route, with the recurring rule of the undo decision: an open next occurrence is removed, a done one refuses (409).

const USER = "local:dev@example.com" as UserId;
const HOST = "127.0.0.1:4310";
const DAY = 24 * 60 * 60 * 1000;
/** The time each test reads at; the clock starts 100 days before it, as FakeClock moves forward only. */
const NOW = Date.parse("2026-11-14T12:00:00.000Z");

async function setup() {
  const clock = new FakeClock(new Date(NOW - 100 * DAY));
  const { store } = await newStore(clock);
  const token = newCsrfToken();
  const d: ApiDeps = {
    store, scanner: new PatternEgressScanner(async () => []), clock, lease_ms: 300_000, health: new HealthMonitor(async () => [], clock),
    commands: { actor: USER, source: "environment" as const, token },
  };
  /** GET /api/v1/tasks: All's rows (every task the read holds), each with its done_at. */
  const get = async () => {
    const r = await respond(d, { method: "GET", url: TASKS_PATH, host: HOST });
    const value = JSON.parse(r.body) as { projects: { list: string | null; tasks: { id: string; title: string; list: string | null; done_at: string | null }[] }[] };
    return { status: r.status, tasks: value.projects.flatMap((p) => p.tasks) };
  };
  const rows = () => store.db.all("SELECT * FROM controller_tasks ORDER BY id");
  const done = () => store.listDoneTasks(doneWindow(clock.now(), null));
  return { store, clock, get, rows, done };
}

const task = (id: string, over: Partial<NewTask> = {}): NewTask => ({
  id, title: id, list: null, priority: null, due: null, due_time: null, recurrence: null, created_by: USER, ...over,
});

/** Adds each task (on its list, if named) and completes it `days` days before NOW, oldest first; the clock ends at NOW. */
async function doneAgo(s: Awaited<ReturnType<typeof setup>>, entries: [string, number, string?][]) {
  for (const [id, days, list] of [...entries].sort((a, b) => b[1] - a[1])) {
    s.clock.advance(NOW - days * DAY - s.clock.now().getTime());
    await s.store.addTask(task(id, { list: list ?? null }));
    await s.store.completeTask(id);
  }
  s.clock.advance(NOW - s.clock.now().getTime());
}

describe("doneWindow", () => {
  it("is the DONE_WINDOW_DAYS days up to now with no upper bound, or the ones before `before`", () => {
    const now = new Date("2026-11-14T12:00:00.000Z");
    expect(DONE_WINDOW_DAYS).toBe(30);
    expect(doneWindow(now, null)).toEqual({ from: "2026-10-15T12:00:00.000Z", before: null });
    expect(doneWindow(now, "2026-10-20T08:00:00.000Z" as Timestamp)).toEqual({ from: "2026-09-20T08:00:00.000Z", before: "2026-10-20T08:00:00.000Z" });
  });
});

describe("listDoneTasks", () => {
  it("lists the done tasks most recently done first, with their done time; open tasks are left out", async () => {
    const s = await setup();
    await doneAgo(s, [["tk_a", 3], ["tk_b", 1], ["tk_c", 2]]);
    await s.store.addTask(task("tk_open"));
    const r = await s.done();
    expect(r.tasks.map((t) => t.id)).toEqual(["tk_b", "tk_c", "tk_a"]);
    expect(r.tasks[0]!.done_at).toBe("2026-11-13T12:00:00.000Z");
  });

  it("reads the last 30 days only", async () => {
    const s = await setup();
    await doneAgo(s, [["tk_new", 29], ["tk_old", 31]]);
    expect((await s.done()).tasks.map((t) => t.id)).toEqual(["tk_new"]);
  });
});

describe("GET /api/v1/tasks keeps the done tasks of the window", () => {
  it("answers the open tasks and the done tasks of the last 30 days, each with its done_at; no older done task; it writes nothing", async () => {
    const s = await setup();
    await doneAgo(s, [["tk_a", 2, "home"], ["tk_b", 1], ["tk_old", 31]]);
    await s.store.addTask(task("tk_open"));
    const before = await s.rows();
    const r = await s.get();
    expect(r.status).toBe(200);
    expect(Object.fromEntries(r.tasks.map((t) => [t.id, t.done_at]))).toEqual({
      tk_a: "2026-11-12T12:00:00.000Z", tk_b: "2026-11-13T12:00:00.000Z", tk_open: null,
    });
    expect(r.tasks.find((t) => t.id === "tk_a")!.list).toBe("home");
    expect(await s.rows()).toEqual(before);
  });

  it("a task closed by its merged work item (closeLinkedTasks) stays, with its done_at", async () => {
    const s = await setup();
    s.clock.advance(NOW - s.clock.now().getTime());
    await s.store.addTask(task("tk_merged"));
    await s.store.linkTask("tk_merged", "wi_merged" as WorkItemId);
    expect((await s.store.closeLinkedTasks("wi_merged" as WorkItemId)).map((t) => t.id)).toEqual(["tk_merged"]);
    const row = (await s.get()).tasks.find((t) => t.id === "tk_merged");
    expect(row?.done_at).toBe(new Date(NOW).toISOString());
  });
});

describe("taskViews with done tasks", () => {
  it("places a done task by its due date as an open one; overdue holds open tasks only, not one done today or before", async () => {
    const s = await setup();
    s.clock.advance(NOW - 3 * DAY - s.clock.now().getTime());
    const today = localDate(new Date(NOW));
    const ago = localDate(new Date(NOW), -5);
    for (const t of [
      task("tk_late_open", { due: { date: ago } }), task("tk_late_done_today", { due: { date: ago } }), task("tk_late_done_before", { due: { date: ago } }),
      task("tk_timed_done", { due: { date: today }, due_time: "10:00" }), task("tk_timed_open", { due: { date: today }, due_time: "11:00" }),
    ]) await s.store.addTask(t);
    await s.store.completeTask("tk_late_done_before");
    s.clock.advance(NOW - s.clock.now().getTime());
    for (const id of ["tk_late_done_today", "tk_timed_done"]) await s.store.completeTask(id);
    const all = [...await s.store.listTasks(100), ...(await s.done()).tasks];
    const v = taskViews(all, s.clock.now());
    expect(v.today.overdue.map((t) => t.id)).toEqual(["tk_late_open"]);
    // A past-due task done today is no longer overdue (design 02-tasks-page, done tasks are never overdue).
    expect(v.today.overdue.map((t) => t.id)).not.toContain("tk_late_done_today");
    expect(v.today.due.map((t) => t.id)).toEqual(["tk_timed_done", "tk_timed_open"]);
    expect(v.projects.flatMap((p) => p.tasks.map((t) => t.id))).toEqual(expect.arrayContaining(["tk_late_done_today", "tk_late_done_before", "tk_timed_done"]));
  });
});
