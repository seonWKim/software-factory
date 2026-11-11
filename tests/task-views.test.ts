import { describe, expect, it } from "vitest";
import { type NewTask, type Task, taskViews } from "../src/core/tasks.js";
import type { UserId } from "../src/core/types.js";
import { FakeClock } from "../src/impl/clock/fake-clock.js";
import { newStore } from "./helpers/store.js";

// The Tasks page's views (design 02-tasks, issue #607): Inbox, Today (overdue first), Upcoming (the next 7 days, by day)
// and Projects, each task placed by its due date against the injected Clock's local calendar date, so the day ends at
// local midnight. Every time below is built in the process's own time zone, so the tests hold in any zone.

const USER = "local:dev@example.com" as UserId;
/** A local wall-clock time on 2026-11-<day>. */
const at = (day: number, h: number, m: number) => new Date(2026, 10, day, h, m);

const task = (id: string, over: Partial<NewTask> = {}): NewTask => ({
  id, title: id, list: null, priority: null, due: null, due_time: null, recurrence: null, created_by: USER, ...over,
});

async function setup(now: Date) {
  const clock = new FakeClock(now);
  const { store } = await newStore(clock);
  const views = async () => taskViews(await store.listTasks(100), clock.now());
  return { store, clock, views };
}

const ids = (ts: readonly Task[]) => ts.map((t) => t.id);

describe("task views: the day boundary at local midnight (injected Clock)", () => {
  it("a task due on the 12th, due at 23:59 or at 00:00, is Today until 23:59 and overdue from 00:00 on the 13th", async () => {
    const s = await setup(at(12, 9, 0));
    await s.store.addTask(task("late", { due: { date: "2026-11-12" }, due_time: "23:59" }));
    await s.store.addTask(task("early", { due: { date: "2026-11-12" }, due_time: "00:00" }));
    s.clock.advance(at(12, 23, 59).getTime() - s.clock.now().getTime());
    let v = await s.views();
    expect(v.today_date).toBe("2026-11-12");
    expect(ids(v.today.due)).toEqual(["early", "late"]);
    expect(v.today.overdue).toEqual([]);
    s.clock.advance(60_000); // 00:00 on the 13th
    v = await s.views();
    expect(v.today_date).toBe("2026-11-13");
    expect(ids(v.today.overdue)).toEqual(["early", "late"]);
    expect(v.today.due).toEqual([]);
  });

  it("a task due on the 13th is Upcoming at 23:59 on the 12th and Today at 00:00 on the 13th", async () => {
    const s = await setup(at(12, 23, 59));
    await s.store.addTask(task("t", { due: { date: "2026-11-13" } }));
    let v = await s.views();
    expect(v.upcoming).toEqual([{ date: "2026-11-13", tasks: [expect.objectContaining({ id: "t" })] }]);
    expect(v.today.due).toEqual([]);
    s.clock.advance(60_000);
    v = await s.views();
    expect(v.upcoming).toEqual([]);
    expect(ids(v.today.due)).toEqual(["t"]);
  });

  it("Upcoming ends 7 days after today: a task due 8 days out joins it only at the next local midnight", async () => {
    const s = await setup(at(12, 23, 59));
    await s.store.addTask(task("week", { due: { date: "2026-11-19" } }));
    await s.store.addTask(task("eight", { due: { date: "2026-11-20" } }));
    expect((await s.views()).upcoming.map((d) => d.date)).toEqual(["2026-11-19"]);
    s.clock.advance(60_000);
    expect((await s.views()).upcoming.map((d) => d.date)).toEqual(["2026-11-19", "2026-11-20"]);
  });

  it("today and tomorrow typed at 23:59 resolve against the Clock, and land in Today and Upcoming", async () => {
    const s = await setup(at(12, 23, 59));
    await s.store.addTask({ ...task("a"), due: { days_from_today: 0 } });
    await s.store.addTask({ ...task("b"), due: { days_from_today: 1 } });
    const v = await s.views();
    expect(ids(v.today.due)).toEqual(["a"]);
    expect(v.upcoming).toEqual([{ date: "2026-11-13", tasks: [expect.objectContaining({ id: "b" })] }]);
  });
});

describe("task views: placement", () => {
  it("Inbox holds the open tasks with no due date; Today lists overdue first, oldest due first, then today's", async () => {
    const s = await setup(at(12, 10, 0));
    await s.store.addTask(task("undated"));
    await s.store.addTask(task("today", { due: { date: "2026-11-12" } }));
    await s.store.addTask(task("yesterday", { due: { date: "2026-11-11" } }));
    await s.store.addTask(task("last-week", { due: { date: "2026-11-05" } }));
    await s.store.addTask(task("done", { due: { date: "2026-11-01" } }));
    await s.store.completeTask("done");
    const v = await s.views();
    expect(ids(v.inbox)).toEqual(["undated"]);
    expect(ids(v.today.overdue)).toEqual(["last-week", "yesterday"]);
    expect(ids(v.today.due)).toEqual(["today"]);
  });

  it("Upcoming groups the next 7 days by day, in date order, with only the days that have a task", async () => {
    const s = await setup(at(12, 10, 0));
    await s.store.addTask(task("c", { due: { date: "2026-11-15" } }));
    await s.store.addTask(task("a", { due: { date: "2026-11-13" }, due_time: "18:00" }));
    await s.store.addTask(task("b", { due: { date: "2026-11-13" }, due_time: "08:00" }));
    await s.store.addTask(task("today", { due: { date: "2026-11-12" } }));
    const v = await s.views();
    expect(v.upcoming.map((d) => [d.date, ids(d.tasks)])).toEqual([["2026-11-13", ["b", "a"]], ["2026-11-15", ["c"]]]);
  });

  it("Projects places every open task under its list by due date, undated last, and unlabelled tasks last", async () => {
    const s = await setup(at(12, 10, 0));
    await s.store.addTask(task("home-undated", { list: "home" }));
    await s.store.addTask(task("home-later", { list: "home", due: { date: "2026-12-01" } }));
    await s.store.addTask(task("home-overdue", { list: "home", due: { date: "2026-11-01" } }));
    await s.store.addTask(task("bank", { list: "bank", due: { date: "2026-11-20" } }));
    await s.store.addTask(task("none"));
    const v = await s.views();
    expect(v.projects.map((p) => [p.list, ids(p.tasks)])).toEqual([
      ["bank", ["bank"]],
      ["home", ["home-overdue", "home-later", "home-undated"]],
      [null, ["none"]],
    ]);
  });
});
