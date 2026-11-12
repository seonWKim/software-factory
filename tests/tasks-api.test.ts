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
import { TASKS_PATH, TASK_EDIT_PATH, TASK_SCHEDULE_PATH } from "../src/ui/tasks-api.js";
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
