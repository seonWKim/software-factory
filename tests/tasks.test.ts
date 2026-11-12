import { describe, expect, it } from "vitest";
import migration from "../src/controller/migrations/20261111T1610-controller-tasks.migration.js";
import { type CliAction, type LocalCliDeps, parseLocalCliArgs, runLocalCli } from "../src/core/local-cli.js";
import { DEFAULT_DURATION_MINUTES, type NewTask, type Task, localDate, planDay, taskDuration, taskViews } from "../src/core/tasks.js";
import type { Timestamp, UserId } from "../src/core/types.js";
import { FakeClock } from "../src/impl/clock/fake-clock.js";
import { MIGRATIONS_TABLE, type MigrationDb, type SqlDriver, tableExists } from "../src/state/index.js";
import { PROJECT_KEY, issue, newStore, system } from "./helpers/store.js";

// Plain tasks (design 02-tasks, issue #606): stored in controller_tasks, never a work item; quick-add on the CLI;
// conditional, idempotent writes; one next occurrence per recurring completion.

const USER = "local:dev@example.com" as UserId;
const DAY = 24 * 60 * 60 * 1000;

async function setup(clock = new FakeClock("2026-11-11T12:00:00.000Z")) {
  const { store } = await newStore(clock);
  let n = 0;
  const d: LocalCliDeps = {
    store, identity: { user: USER, from: "git user.email" }, project: async () => null, read: async () => "", newId: () => `id${++n}`,
  };
  /** As typed: `factory task <args...>`. */
  const cli = (...args: string[]) => {
    const a = parseLocalCliArgs("task", args);
    if ("error" in a) throw new Error(a.error);
    return runLocalCli(d, a as CliAction);
  };
  return { store, clock, d, cli };
}

const task = (over: Partial<NewTask> = {}): NewTask => ({
  id: "tk_1", title: "water plants", list: null, priority: null, due: { date: "2026-11-11" }, due_time: null, recurrence: null, created_by: USER, ...over,
});

describe("factory task add", () => {
  it("stores a task in controller_tasks with the words left as its title; no work item and no triage run", async () => {
    const { store, cli } = await setup();
    const r = await cli("add", "pay", "rent", "2026-12-01", "08:30", "!1", "#home", "every", "month");
    expect(r.code).toBe(0);
    const [stored] = await store.listTasks(10);
    expect(stored).toMatchObject({
      id: "tk_id1", title: "pay rent", list: "home", priority: 1, due_date: "2026-12-01", due_time: "08:30", recurrence: "month",
      done_at: null, parent_id: null,
    });
    expect(r.lines).toEqual(["tk_id1\tpay rent\t2026-12-01 08:30\t!1\t#home\tevery month"]);
    expect(await store.listWorkItems(10)).toEqual([]);
    expect(await store.db.all("SELECT id FROM worker_runs")).toEqual([]);
  });

  it("stores the CLI user's ID from the environment in created_by, never a display name", async () => {
    const { store, cli } = await setup();
    await cli("add", "call", "mum");
    expect((await store.listTasks(10))[0]!.created_by).toBe(USER);
    expect(await store.db.all("SELECT created_by FROM controller_tasks")).toEqual([{ created_by: USER }]);
  });

  it("refuses quick-add words the parser refuses, storing nothing", () => {
    expect(parseLocalCliArgs("task", ["add", "pay", "2026-13-01"])).toMatchObject({ error: expect.stringContaining("task add: not a date") });
    expect(parseLocalCliArgs("task", ["add"])).toMatchObject({ error: expect.stringContaining("the title is empty") });
  });

  it("today and tomorrow resolve against the injected Clock, not the system clock", async () => {
    const clock = new FakeClock("2020-02-28T12:00:00.000Z");
    const { store, cli } = await setup(clock);
    await cli("add", "a", "today");
    clock.advance(1000);
    await cli("add", "b", "tomorrow");
    const [a, b] = await store.listTasks(10);
    expect(a!.due_date).toBe(localDate(clock.now()));
    expect(b!.due_date).toBe(localDate(clock.now(), 1));
    expect(b!.due_date).toMatch(/^2020-0[23]-/);
    expect(a!.created_at).toBe("2020-02-28T12:00:00.000Z");
  });
});

describe("factory task list", () => {
  it("shows open tasks in a section after the work items; a done task is left out", async () => {
    const { store, cli, d } = await setup();
    await cli("add", "first");
    await cli("add", "second", "!2");
    await cli("done", "tk_id1");
    expect((await cli("list")).lines).toEqual(["no local work items", "", "Tasks", "tk_id2\tsecond\t-\t!2\t-\t-"]);
    await runLocalCli({ ...d, project: async () => PROJECT_KEY }, { action: "create", title: "Item", bodyFile: "b" });
    const lines = (await cli("list")).lines;
    expect(lines.indexOf("Tasks")).toBeGreaterThan(0);
    expect(lines[0]).toMatch(/\tItem\tNEW\t-$/);
    // A work item from another source is not a task either way.
    await store.createWorkItem(issue(1), system);
    expect((await store.listTasks(10)).map((t) => t.id)).toEqual(["tk_id2"]);
  });

  it("with no task the list is the work items alone", async () => {
    const { cli } = await setup();
    expect((await cli("list")).lines).toEqual(["no local work items"]);
  });
});

describe("factory task done and recurring completion", () => {
  it("completing a recurring task twice creates exactly one next occurrence", async () => {
    const { store, clock, cli } = await setup();
    await cli("add", "water", "plants", "every", "week", "2026-11-11", "#home");
    clock.advance(DAY);
    const first = await cli("done", "tk_id1");
    clock.advance(DAY);
    const second = await cli("done", "tk_id1");
    expect(first.lines[0]).toBe("done tk_id1");
    expect(second.lines[0]).toBe("tk_id1 was already done");
    const rows = await store.db.all("SELECT id, done_at, due_date, parent_id, list, recurrence FROM controller_tasks ORDER BY created_at");
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ id: "tk_id1", done_at: "2026-11-12T12:00:00.000Z" });
    expect(rows[1]).toMatchObject({ done_at: null, due_date: "2026-11-18", parent_id: "tk_id1", list: "home", recurrence: "week" });
    expect(first.lines[1]).toBe(second.lines[1]);
    expect(first.lines[1]).toContain(`next: ${String(rows[1]!.id)}\twater plants\t2026-11-18`);
  });

  it("a task that is not recurring gets no next occurrence; an unknown ID fails", async () => {
    const { store, cli } = await setup();
    await cli("add", "once");
    expect((await cli("done", "tk_id1")).lines).toEqual(["done tk_id1"]);
    expect(await store.listTasks(10)).toEqual([]);
    expect(await cli("done", "tk_nope")).toEqual({ code: 1, lines: ["no task tk_nope"] });
  });
});

describe("schedule a task: duration and recurrence (design 02-tasks)", () => {
  it("a timed task with no stored duration is planned as 30 minutes; a stored duration replaces it", async () => {
    const { store, clock } = await setup();
    const today = localDate(clock.now());
    const plain = await store.addTask(task({ id: "tk_a", due: { date: today }, due_time: "15:00" }));
    const long = await store.addTask(task({ id: "tk_b", due: { date: today }, due_time: "16:00", duration_minutes: 90 }));
    expect(plain.duration_minutes).toBeNull();
    expect(taskDuration(plain)).toBe(DEFAULT_DURATION_MINUTES);
    expect(DEFAULT_DURATION_MINUTES).toBe(30);
    expect(taskDuration(long)).toBe(90);
    const views = taskViews(await store.listTasks(10), clock.now());
    expect(views.timeline).toEqual([
      { kind: "task", id: "tk_a", title: "water plants", start: "15:00", end: "15:30", offset: 900, minutes: 30 },
      { kind: "task", id: "tk_b", title: "water plants", start: "16:00", end: "17:30", offset: 960, minutes: 90 },
    ]);
  });

  it("the timeline leaves untimed tasks and all-day events out, draws a timed event its length, and cuts a block at midnight", () => {
    const day = "2026-11-11";
    const at = (h: number, m = 0) => new Date(2026, 10, 11, h, m).toISOString();
    const late: Task = { ...task(), id: "tk_late", due_date: day, due_time: "23:45", created_at: at(1) as Timestamp, done_at: null, parent_id: null,
      work_item_id: null, parent_task_id: null, duration_minutes: null, reminded_at: null };
    const untimed = { ...late, id: "tk_untimed", due_time: null };
    const event = { kind: "event" as const, source: "work", id: "ev1", title: "standup", starts_at: at(9), ends_at: at(9, 15), all_day: false, time: "09:00" };
    const allDay = { ...event, id: "ev2", all_day: true, time: null };
    expect(planDay([allDay, event, late, untimed], day)).toEqual([
      { kind: "event", id: "work:ev1", title: "standup", start: "09:00", end: "09:15", offset: 540, minutes: 15 },
      { kind: "task", id: "tk_late", title: "water plants", start: "23:45", end: "00:15", offset: 1425, minutes: 15 },
    ]);
  });

  it("a recurring task's next occurrence keeps its due time and duration, its date counted from the old due date", async () => {
    const { store, clock } = await setup();
    await store.addTask(task({ due: { date: "2026-11-11" }, due_time: "15:00", duration_minutes: 45, recurrence: "week" }));
    clock.advance(3 * DAY);
    const r = await store.completeTask("tk_1");
    expect(r.ok && r.next).toMatchObject({ due_date: "2026-11-18", due_time: "15:00", duration_minutes: 45, reminded_at: null });
  });
});

describe("task writes are conditional and idempotent", () => {
  it("adding the same task twice stores one row and returns the stored one", async () => {
    const { store, clock } = await setup();
    const a = await store.addTask(task());
    clock.advance(DAY);
    const b = await store.addTask(task({ title: "something else" }));
    expect(b).toEqual(a);
    expect(await store.listTasks(10)).toEqual([a]);
  });

  it("completing twice leaves the same state; the second completion writes nothing", async () => {
    const { store, clock } = await setup();
    await store.addTask(task({ recurrence: "day" }));
    const first = await store.completeTask("tk_1");
    const after = await store.db.all("SELECT * FROM controller_tasks ORDER BY id");
    clock.advance(DAY);
    const second = await store.completeTask("tk_1");
    expect(first).toMatchObject({ ok: true, completed: true, next: { due_date: "2026-11-12", parent_id: "tk_1" } });
    expect(second).toEqual({ ...first, completed: false });
    expect(await store.db.all("SELECT * FROM controller_tasks ORDER BY id")).toEqual(after);
  });

  it("completes only a row whose done_at is unset: a row done elsewhere stays as it is", async () => {
    const { store } = await setup();
    await store.addTask(task({ recurrence: "month" }));
    await store.db.run("UPDATE controller_tasks SET done_at = ? WHERE id = ?", ["2026-01-01T00:00:00.000Z", "tk_1"]);
    expect(await store.completeTask("tk_1")).toMatchObject({ ok: true, completed: false, next: null, task: { done_at: "2026-01-01T00:00:00.000Z" } });
    expect(await store.db.all("SELECT id FROM controller_tasks")).toEqual([{ id: "tk_1" }]);
  });
});

describe("migration: controller_tasks", () => {
  const ID = "20261111T1610-controller-tasks";
  const mdb = (db: SqlDriver): MigrationDb => ({ dialect: "sqlite", all: (s, p) => db.all(s, p), run: (s, p) => db.run(s, p) });

  it("a fresh database has controller_tasks and the migration recorded", async () => {
    const { store } = await newStore();
    expect(await tableExists(mdb(store.db), "controller_tasks")).toBe(true);
    expect(await store.db.all(`SELECT id FROM ${MIGRATIONS_TABLE} WHERE id = ?`, [ID])).toEqual([{ id: ID }]);
  });

  it("a database at the previous version gets the table, keeps its rows, and a rerun changes nothing", async () => {
    const { store } = await newStore();
    const { item } = await store.createWorkItem(issue(1), system);
    await store.db.run("DROP TABLE controller_tasks");
    // The later column migrations on this table (#607, sub-tasks, schedule) run again too, as they would after this one on an older store.
    const later = ["20261112T1500-controller-tasks-work-item", "20261112T1800-controller-sub-tasks", "20261113T0900-controller-task-schedule"];
    await store.db.run(`DELETE FROM ${MIGRATIONS_TABLE} WHERE id IN (?, ?, ?, ?)`, [ID, ...later]);
    expect(await tableExists(mdb(store.db), "controller_tasks")).toBe(false);
    await store.migrate();
    expect(await tableExists(mdb(store.db), "controller_tasks")).toBe(true);
    expect(await store.db.all(`SELECT id FROM ${MIGRATIONS_TABLE} WHERE id = ?`, [ID])).toEqual([{ id: ID }]);
    expect((await store.getWorkItem(item.id))?.id).toBe(item.id);
    expect(migration).toMatchObject({ change: "additive" });
    await migration.up(mdb(store.db));
    expect(await store.addTask(task())).toMatchObject({ id: "tk_1", due_date: "2026-11-11" });
  });
});
