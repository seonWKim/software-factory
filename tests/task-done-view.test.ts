import { describe, expect, it } from "vitest";
import { DONE_WINDOW_DAYS, type NewTask, doneWindow } from "../src/core/tasks.js";
import type { Timestamp, UserId } from "../src/core/types.js";
import { FakeClock } from "../src/impl/clock/fake-clock.js";
import { PatternEgressScanner } from "../src/impl/egress/pattern-egress-scanner.js";
import { HealthMonitor } from "../src/ui/health.js";
import { type ApiDeps, respond } from "../src/ui/server.js";
import { newCsrfToken } from "../src/ui/settings-api.js";
import { TASK_DONE_PATH, TASK_REOPEN_PATH } from "../src/ui/tasks-api.js";
import { newStore } from "./helpers/store.js";

// The Tasks page's Done view (design 02-tasks, Done view): listDoneTasks reads the done tasks of a 30-day window, most
// recently done first, and says whether one was done before it (Show older). Reopen is the existing reopenTask and its
// route, with the recurring rule of the undo decision: an open next occurrence is removed, a done one refuses (409).

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
  const get = async (before?: string) => {
    const r = await respond(d, { method: "GET", url: before === undefined ? TASK_DONE_PATH : `${TASK_DONE_PATH}?before=${encodeURIComponent(before)}`, host: HOST });
    return { status: r.status, value: JSON.parse(r.body) as { tasks: { id: string; title: string; list: string | null; done_at: string }[]; older: boolean; next_before: string } };
  };
  const reopen = (id: string) =>
    respond(d, { method: "POST", url: TASK_REOPEN_PATH, host: HOST, origin: `http://${HOST}`, contentType: "application/json", csrfToken: token, body: JSON.stringify({ id }) });
  const rows = () => store.db.all("SELECT * FROM controller_tasks ORDER BY id");
  const done = (before: Timestamp | null = null) => store.listDoneTasks(doneWindow(clock.now(), before));
  return { store, clock, get, reopen, rows, done };
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
    expect(r.older).toBe(false);
  });

  it("reads the last 30 days only and says when an older done task exists", async () => {
    const s = await setup();
    await doneAgo(s, [["tk_new", 29], ["tk_old", 31]]);
    const r = await s.done();
    expect(r.tasks.map((t) => t.id)).toEqual(["tk_new"]);
    expect(r.older).toBe(true);
  });

  it("Show older reads the 30 days before the oldest row shown, then says none is older", async () => {
    const s = await setup();
    await doneAgo(s, [["tk_1", 10], ["tk_2", 35], ["tk_3", 41], ["tk_4", 70]]);
    const first = await s.done();
    expect(first.tasks.map((t) => t.id)).toEqual(["tk_1"]);
    const second = await s.done(first.tasks.at(-1)!.done_at);
    // The 30 days before day 10 reach back to day 40: day 41 is in the next read.
    expect(second.tasks.map((t) => t.id)).toEqual(["tk_2"]);
    expect(second.older).toBe(true);
    const third = await s.done(second.tasks.at(-1)!.done_at);
    expect(third.tasks.map((t) => t.id)).toEqual(["tk_3"]);
    const fourth = await s.done(third.tasks.at(-1)!.done_at);
    expect(fourth).toMatchObject({ tasks: [{ id: "tk_4" }], older: false });
  });

  it("is read-only", async () => {
    const s = await setup();
    await doneAgo(s, [["tk_a", 1], ["tk_b", 40]]);
    const before = await s.rows();
    await s.done();
    await s.done("2026-11-01T00:00:00.000Z" as Timestamp);
    await s.get();
    expect(await s.rows()).toEqual(before);
  });
});

describe("GET /api/v1/tasks/done and reopen from the Done view", () => {
  it("answers the window's tasks newest done first with their list, `older` and Show older's cursor", async () => {
    const s = await setup();
    await doneAgo(s, [["tk_a", 2, "home"], ["tk_b", 1], ["tk_old", 31]]);
    const r = await s.get();
    expect(r.status).toBe(200);
    expect(r.value.tasks.map((t) => [t.id, t.list, t.title, t.done_at])).toEqual([
      ["tk_b", null, "tk_b", "2026-11-13T12:00:00.000Z"],
      ["tk_a", "home", "tk_a", "2026-11-12T12:00:00.000Z"],
    ]);
    expect(r.value).toMatchObject({ older: true, next_before: "2026-11-12T12:00:00.000Z" });
    const older = await s.get(r.value.next_before);
    expect(older.value).toMatchObject({ tasks: [{ id: "tk_old" }], older: false });
  });

  it("an empty window's cursor is its start, so Show older still reaches older tasks", async () => {
    const s = await setup();
    await doneAgo(s, [["tk_old", 45]]);
    const r = await s.get();
    expect(r.value).toEqual({ as_of: "2026-11-14T12:00:00.000Z", tasks: [], older: true, next_before: "2026-10-15T12:00:00.000Z" });
    expect((await s.get(r.value.next_before)).value.tasks.map((t) => t.id)).toEqual(["tk_old"]);
  });

  it("answers 400 for a `before` that is not a time", async () => {
    const s = await setup();
    expect((await s.get("yesterday")).status).toBe(400);
  });

  it("a reopened task leaves the Done view and is open again", async () => {
    const s = await setup();
    await doneAgo(s, [["tk_a", 1]]);
    expect((await s.reopen("tk_a")).status).toBe(200);
    expect((await s.get()).value.tasks).toEqual([]);
    expect((await s.store.listTasks(10)).map((t) => t.id)).toEqual(["tk_a"]);
  });

  it("reopening a recurring task removes its open next occurrence", async () => {
    const s = await setup();
    await s.store.addTask(task("tk_r", { due: { date: "2026-11-14" }, recurrence: "week" }));
    const c = await s.store.completeTask("tk_r");
    const next = c.ok ? c.next! : null;
    const r = await s.reopen("tk_r");
    expect(JSON.parse(r.body)).toEqual({ task_id: "tk_r", reopened: true, removed_next: next!.id });
    expect(await s.store.getTask(next!.id)).toBeNull();
    expect((await s.get()).value.tasks).toEqual([]);
  });

  it("answers 409 and writes nothing when the next occurrence is done; the task stays in Done", async () => {
    const s = await setup();
    await s.store.addTask(task("tk_r", { due: { date: "2026-11-14" }, recurrence: "week" }));
    const c = await s.store.completeTask("tk_r");
    s.clock.advance(60_000);
    await s.store.completeTask(c.ok ? c.next!.id : "");
    const before = await s.rows();
    const r = await s.reopen("tk_r");
    expect(r.status).toBe(409);
    expect(JSON.parse(r.body).error).toMatch(/next occurrence is done/);
    expect(await s.rows()).toEqual(before);
    expect((await s.get()).value.tasks.map((t) => t.id)).toContain("tk_r");
  });
});
