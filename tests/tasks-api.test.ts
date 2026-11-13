// POST /api/v1/tasks (design 02-tasks and 09-desktop-app): the desktop quick-add box stores a plain task through the
// #606 quick-add parser and task store. Guarded like every write route (Host, Origin, Content-Type, CSRF token, body
// size, JSON), then the body; every refusal stores nothing. The caller chooses the task ID, so a retry stores one task.

import { describe, expect, it } from "vitest";
import type { UserId } from "../src/core/types.js";
import { FakeClock } from "../src/impl/clock/fake-clock.js";
import { PatternEgressScanner } from "../src/impl/egress/pattern-egress-scanner.js";
import { HealthMonitor } from "../src/ui/health.js";
import { type ApiDeps, type UiRequest, respond } from "../src/ui/server.js";
import { newCsrfToken } from "../src/ui/settings-api.js";
import { TASKS_PATH, TASK_DONE_PATH, TASK_EDIT_PATH, TASK_REOPEN_PATH, TASK_SCHEDULE_PATH, TASK_WRITES } from "../src/ui/tasks-api.js";
import { newStore } from "./helpers/store.js";

const HOST = "127.0.0.1:4310";
const ORIGIN = `http://${HOST}`;
const ACTOR = "local:owner@example.com" as UserId;

async function setup(opts: { actor?: UserId | null; wired?: boolean } = {}) {
  const clock = new FakeClock(new Date("2026-11-12T09:00:00"));
  const { store } = await newStore(clock);
  const token = newCsrfToken();
  const d: ApiDeps = {
    store,
    scanner: new PatternEgressScanner(async () => []),
    clock,
    lease_ms: 300_000,
    health: new HealthMonitor(async () => [], clock),
    ...(opts.wired === false ? {} : { commands: { actor: opts.actor === undefined ? ACTOR : opts.actor, source: "environment" as const, token } }),
  };
  const post = (body: unknown, over: Partial<UiRequest> = {}) =>
    respond(d, {
      method: "POST",
      url: TASKS_PATH,
      host: HOST,
      origin: ORIGIN,
      contentType: "application/json",
      csrfToken: token,
      body: typeof body === "string" ? body : JSON.stringify(body),
      ...over,
    });
  const tasks = () => store.listTasks(100);
  return { d, store, token, post, tasks };
}

const ID = "tk_0123456789abcdef";

describe("POST /api/v1/tasks", () => {
  it("stores one task with the parsed fields, created by the page's actor, and returns it", async () => {
    const s = await setup();
    const r = await s.post({ id: ID, words: "pay rent tomorrow 09:30 !1 #home every month" });
    expect(r.status).toBe(200);
    const stored = await s.tasks();
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({
      id: ID, title: "pay rent", list: "home", priority: 1, due_date: "2026-11-13", due_time: "09:30", recurrence: "month", created_by: ACTOR, done_at: null,
    });
    expect(JSON.parse(r.body)).toMatchObject({ task: { id: ID, title: "pay rent", list: "home", priority: 1, due_date: "2026-11-13" } });
  });

  it("the same task ID sent twice stores one task", async () => {
    const s = await setup();
    const first = await s.post({ id: ID, words: "call the bank" });
    const again = await s.post({ id: ID, words: "call the bank" });
    expect(first.status).toBe(200);
    expect(again.status).toBe(200);
    expect(JSON.parse(again.body).task).toEqual(JSON.parse(first.body).task);
    expect((await s.tasks()).map((t) => t.id)).toEqual([ID]);
  });

  it("refuses a request without the CSRF token, with a stale one, or with a foreign Origin, and stores nothing", async () => {
    const s = await setup();
    const body = { id: ID, words: "call the bank" };
    for (const over of [{ csrfToken: undefined }, { csrfToken: "stale" }, { origin: "https://evil.example" }, { origin: undefined }]) {
      const r = await s.post(body, over);
      expect(r.status, JSON.stringify(over)).toBe(403);
    }
    expect((await s.post(body, { contentType: "text/plain" })).status).toBe(415);
    expect((await s.post(body, { host: "evil.example" })).status).toBe(403);
    expect((await s.post(body, { bodyTooLarge: true })).status).toBe(413);
    expect(await s.tasks()).toEqual([]);
  });

  it("refuses a body that is not one task, or words the parser refuses, with the reason, and stores nothing", async () => {
    const s = await setup();
    const cases: [unknown, RegExp][] = [
      ["{", /JSON/],
      [[], /object/],
      [{ words: "x" }, /id/],
      [{ id: "bad id", words: "x" }, /id/],
      [{ id: ID }, /words/],
      [{ id: ID, words: "x", extra: 1 }, /unknown field "extra"/],
      [{ id: ID, words: "every fortnight call mum" }, /unknown recurrence/],
      [{ id: ID, words: "!1 #home" }, /title is empty/],
      [{ id: ID, words: "call 13pm" }, /not a time: 13pm/],
      [{ id: ID, words: "call 12:61pm" }, /not a time: 12:61pm/],
      [{ id: ID, words: "call at 3pm 0m" }, /a duration must be/],
    ];
    for (const [body, reason] of cases) {
      const r = await s.post(body);
      expect(r.status, JSON.stringify(body)).toBe(400);
      expect(JSON.parse(r.body).error).toMatch(reason);
    }
    expect(await s.tasks()).toEqual([]);
  });

  it("answers 503 with no actor and 405 when the commands route is not wired, storing nothing", async () => {
    const off = await setup({ actor: null });
    expect((await off.post({ id: ID, words: "x" })).status).toBe(503);
    expect(await off.tasks()).toEqual([]);
    const unwired = await setup({ wired: false });
    expect((await unwired.post({ id: ID, words: "x" })).status).toBe(405);
    expect(await unwired.tasks()).toEqual([]);
  });
});

describe("schedule a task from the Tasks page (design 02-tasks)", () => {
  it("quick add at 3pm stores a due time of 15:00, today, with no stored duration (planned as 30 minutes)", async () => {
    const s = await setup();
    expect((await s.post({ id: ID, words: "call the bank at 3pm" })).status).toBe(200);
    expect((await s.tasks())[0]).toMatchObject({ title: "call the bank", due_date: "2026-11-12", due_time: "15:00", duration_minutes: null });
  });

  it("POST /api/v1/tasks/schedule sets the due date, due time and an optional duration; a moved task keeps its duration", async () => {
    const s = await setup();
    await s.post({ id: ID, words: "call the bank 45m" });
    const r = await s.post({ id: ID, date: "2026-11-14", time: "15:30" }, { url: TASK_SCHEDULE_PATH });
    expect(r.status).toBe(200);
    expect(JSON.parse(r.body).task).toMatchObject({ id: ID, due_date: "2026-11-14", due_time: "15:30", duration_minutes: 45 });
    expect((await s.post({ id: ID, date: "2026-11-14", time: "09:00", duration_minutes: 90 }, { url: TASK_SCHEDULE_PATH })).status).toBe(200);
    expect((await s.tasks())[0]).toMatchObject({ due_date: "2026-11-14", due_time: "09:00", duration_minutes: 90 });
  });

  it("the duration is edited with the edit words; a refused edit or schedule writes nothing", async () => {
    const s = await setup();
    await s.post({ id: ID, words: "call the bank at 3pm" });
    const edit = (words: string) => s.post({ id: ID, words }, { url: TASK_EDIT_PATH });
    expect((await edit("1h30m")).status).toBe(200);
    expect((await s.tasks())[0]).toMatchObject({ title: "call the bank", due_time: "15:00", duration_minutes: 90 });
    const before = await s.tasks();
    for (const words of ["0m", "25h", "13pm"]) expect((await edit(words)).status, words).toBe(400);
    const cases: [unknown, RegExp][] = [
      [{ id: ID, date: "2026-02-30", time: "15:00" }, /real date/],
      [{ id: ID, date: "2026-11-14", time: "3pm" }, /HH:MM/],
      [{ id: ID, date: "2026-11-14", time: "24:00" }, /HH:MM/],
      [{ id: ID, date: "2026-11-14", time: "15:00", duration_minutes: 0 }, /duration must be/],
      [{ id: ID, date: "2026-11-14", time: "15:00", duration_minutes: "30" }, /duration must be/],
      [{ id: ID, date: "2026-11-14", time: "15:00", extra: 1 }, /unknown field "extra"/],
    ];
    for (const [body, reason] of cases) {
      const r = await s.post(body, { url: TASK_SCHEDULE_PATH });
      expect(r.status, JSON.stringify(body)).toBe(400);
      expect(JSON.parse(r.body).error).toMatch(reason);
    }
    expect((await s.post({ id: "tk_nope_nope", date: "2026-11-14", time: "15:00" }, { url: TASK_SCHEDULE_PATH })).status).toBe(404);
    expect(await s.tasks()).toEqual(before);
    await s.store.completeTask(ID);
    const done = await s.store.getTask(ID);
    expect((await s.post({ id: ID, date: "2026-11-14", time: "15:00" }, { url: TASK_SCHEDULE_PATH })).status).toBe(409);
    expect(await s.store.getTask(ID)).toEqual(done);
  });

  it("the schedule route answers 503 with no actor and refuses a request without the CSRF token, writing nothing", async () => {
    const s = await setup();
    await s.post({ id: ID, words: "call the bank" });
    const before = await s.tasks();
    expect((await s.post({ id: ID, date: "2026-11-14", time: "15:00" }, { url: TASK_SCHEDULE_PATH, csrfToken: "stale" })).status).toBe(403);
    expect(await s.tasks()).toEqual(before);
    const off = await setup({ actor: null });
    expect((await off.post({ id: ID, date: "2026-11-14", time: "15:00" }, { url: TASK_SCHEDULE_PATH })).status).toBe(503);
  });
});

describe("POST /api/v1/tasks/reopen: undo a completion (design 02-tasks)", () => {
  const reopen = (s: Awaited<ReturnType<typeof setup>>, body: unknown, over: Partial<UiRequest> = {}) => s.post(body, { url: TASK_REOPEN_PATH, ...over });

  it("is a task write route beside /done", () => {
    expect(Object.keys(TASK_WRITES)).toContain(TASK_REOPEN_PATH);
    expect(TASK_WRITES[TASK_REOPEN_PATH]).toBeTypeOf("function");
  });

  it("reopens a done task through the store's reopenTask; a second reopen answers reopened false and writes nothing", async () => {
    const s = await setup();
    await s.post({ id: ID, words: "call the bank" });
    await s.post({ id: ID }, { url: TASK_DONE_PATH });
    expect(await s.tasks()).toEqual([]);
    const r = await reopen(s, { id: ID });
    expect(r.status).toBe(200);
    expect(JSON.parse(r.body)).toEqual({ task_id: ID, reopened: true, removed_next: null });
    expect((await s.tasks()).map((t) => t.id)).toEqual([ID]);
    const before = await s.store.getTask(ID);
    expect(JSON.parse((await reopen(s, { id: ID })).body)).toMatchObject({ reopened: false });
    expect(await s.store.getTask(ID)).toEqual(before);
  });

  it("deletes a recurring task's open next occurrence; answers 409 when it is done, writing nothing", async () => {
    const s = await setup();
    await s.post({ id: ID, words: "water plants today every day" });
    const first = JSON.parse((await s.post({ id: ID }, { url: TASK_DONE_PATH })).body) as { next_id: string };
    expect(JSON.parse((await reopen(s, { id: ID })).body)).toMatchObject({ reopened: true, removed_next: first.next_id });
    expect(await s.store.getTask(first.next_id)).toBeNull();
    const second = JSON.parse((await s.post({ id: ID }, { url: TASK_DONE_PATH })).body) as { next_id: string };
    await s.store.completeTask(second.next_id);
    const before = await s.store.db.all("SELECT * FROM controller_tasks ORDER BY id");
    const r = await reopen(s, { id: ID });
    expect(r.status).toBe(409);
    expect(JSON.parse(r.body).error).toMatch(/next occurrence is done/);
    expect(await s.store.db.all("SELECT * FROM controller_tasks ORDER BY id")).toEqual(before);
  });

  it("answers 404 for an unknown task, 400 for a body that is not { id }, and 503 with no actor", async () => {
    const s = await setup();
    expect((await reopen(s, { id: "tk_nope_nope" })).status).toBe(404);
    expect((await reopen(s, { id: ID, extra: 1 })).status).toBe(400);
    expect((await reopen(s, {})).status).toBe(400);
    const off = await setup({ actor: null });
    expect((await reopen(off, { id: ID })).status).toBe(503);
  });

  it("takes the request guards of /done in the same order, and writes nothing on a refusal", async () => {
    const s = await setup();
    await s.post({ id: ID, words: "call the bank" });
    await s.store.completeTask(ID);
    const before = await s.store.getTask(ID);
    const bad: Partial<UiRequest>[] = [
      { host: "evil.example", origin: "https://evil.example", contentType: "text/plain", csrfToken: "stale", bodyTooLarge: true },
      { origin: "https://evil.example", contentType: "text/plain", csrfToken: "stale", bodyTooLarge: true },
      { contentType: "text/plain", csrfToken: undefined, bodyTooLarge: true },
      { csrfToken: "stale", bodyTooLarge: true },
      { bodyTooLarge: true },
      { body: "{not json" },
    ];
    for (const over of bad) {
      const done = await s.post({ id: ID }, { url: TASK_DONE_PATH, ...over });
      const r = await reopen(s, { id: ID }, over);
      expect(r.status, JSON.stringify(over)).toBe(done.status);
      expect(r.status, JSON.stringify(over)).toBeGreaterThanOrEqual(400);
    }
    expect(await s.store.getTask(ID)).toEqual(before);
  });
});

describe("GET /api/v1/tasks: the quick-add submit key (design 02-tasks, tasks_add_key)", () => {
  const get = (s: Awaited<ReturnType<typeof setup>>) => respond(s.d, { method: "GET", url: TASKS_PATH, host: HOST });
  const set = (s: Awaited<ReturnType<typeof setup>>, value: string, project = "") =>
    s.store.setSettingOverride({ key: "tasks_add_key", project, value, actor: ACTOR });

  it("answers add_key enter with no stored value, and the stored global choice once one is set", async () => {
    const s = await setup();
    expect(JSON.parse((await get(s)).body).add_key).toBe("enter");
    await set(s, JSON.stringify("cmd-enter"));
    expect(JSON.parse((await get(s)).body).add_key).toBe("cmd-enter");
    await set(s, JSON.stringify("enter"));
    expect(JSON.parse((await get(s)).body).add_key).toBe("enter");
  });

  it("ignores a stored value that is not one of the choices, or not JSON, and a project's row", async () => {
    for (const [value, project] of [[JSON.stringify("ctrl-enter"), ""], ["cmd-enter", ""], [JSON.stringify("cmd-enter"), "p1"]] as const) {
      const s = await setup();
      await set(s, value, project);
      expect(JSON.parse((await get(s)).body).add_key, `${value} ${project}`).toBe("enter");
    }
  });
});

describe("GET /api/v1/tasks/done: the Done tab's read (design 02-tasks, Done view)", () => {
  const get = (s: Awaited<ReturnType<typeof setup>>, query = "") => respond(s.d, { method: "GET", url: `${TASK_DONE_PATH}${query}`, host: HOST });

  it("lists the tasks the page completed, newest done first, with title, list and done time; it writes nothing", async () => {
    const s = await setup();
    const other = "tk_fedcba9876543210";
    await s.post({ id: ID, words: "call the bank #home" });
    await s.post({ id: other, words: "water plants" });
    await s.post({ id: ID }, { url: TASK_DONE_PATH });
    (s.d.clock as FakeClock).advance(60_000);
    await s.post({ id: other }, { url: TASK_DONE_PATH });
    const before = await s.store.db.all("SELECT * FROM controller_tasks ORDER BY id");
    const r = await get(s);
    expect(r.status).toBe(200);
    const body = JSON.parse(r.body) as { tasks: { id: string; title: string; list: string | null; done_at: string }[]; older: boolean };
    expect(body.tasks.map((t) => [t.id, t.title, t.list])).toEqual([[other, "water plants", null], [ID, "call the bank", "home"]]);
    expect(body.tasks.every((t) => typeof t.done_at === "string")).toBe(true);
    expect(body.older).toBe(false);
    expect(await s.store.db.all("SELECT * FROM controller_tasks ORDER BY id")).toEqual(before);
  });

  it("answers 400 for a `before` that is not a time, 200 for one that is", async () => {
    const s = await setup();
    expect((await get(s, "?before=soon")).status).toBe(400);
    expect((await get(s, "?before=2026-11-01T00:00:00.000Z")).status).toBe(200);
  });
});
