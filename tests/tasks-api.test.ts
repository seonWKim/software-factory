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
import { TASKS_PATH, TASK_DONE_PATH, TASK_EDIT_PATH, TASK_REOPEN_PATH, TASK_SCHEDULE_PATH, TASK_SUB_PATH, TASK_WRITES } from "../src/ui/tasks-api.js";
import { PROJECTS_PATH, TASK_PROJECT_PATH } from "../src/ui/projects-api.js";
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

describe("+slug on the dashboard's add, edit and sub routes (design 02-tasks, task projects)", () => {
  const links = (s: Awaited<ReturnType<typeof setup>>) => s.store.db.all("SELECT task_id, project_id FROM controller_task_projects ORDER BY task_id");

  async function withProjects() {
    const s = await setup();
    await s.store.createProject({ id: "pj_home", name: "Home", created_by: ACTOR });
    await s.store.createProject({ id: "pj_old", name: "Old", created_by: ACTOR });
    await s.store.archiveProject("pj_old");
    return s;
  }

  it("POST /api/v1/tasks answers 400 with the reason for an unknown or archived project and stores no task and no link", async () => {
    const s = await withProjects();
    for (const [words, error] of [["fix tap +nope", 'no project "nope"'], ["fix tap +home +old", 'project "old" is archived; restore it first']] as const) {
      const r = await s.post({ id: ID, words });
      expect(r.status, words).toBe(400);
      expect(JSON.parse(r.body)).toEqual({ error });
    }
    expect(await s.tasks()).toEqual([]);
    expect(await links(s)).toEqual([]);
    expect((await s.post({ id: ID, words: "fix tap +home" })).status).toBe(200);
    expect(await links(s)).toEqual([{ task_id: ID, project_id: "pj_home" }]);
  });

  it("POST /api/v1/tasks/edit answers 400 for an unknown or archived project, writing no edit and no link", async () => {
    const s = await withProjects();
    await s.post({ id: ID, words: "fix tap" });
    const before = await s.tasks();
    const edit = (words: string) => s.post({ id: ID, words }, { url: TASK_EDIT_PATH });
    for (const words of ["new title +nope", "new title +old"]) {
      const r = await edit(words);
      expect(r.status, words).toBe(400);
      expect(JSON.parse(r.body).error).toMatch(/^(no project "nope"|project "old" is archived; restore it first)$/);
    }
    expect(await s.tasks()).toEqual(before);
    expect(await links(s)).toEqual([]);
    expect((await edit("+home")).status).toBe(200);
    expect(await links(s)).toEqual([{ task_id: ID, project_id: "pj_home" }]);
  });

  it("POST /api/v1/tasks/sub answers 400 for an unknown project and stores no sub-task", async () => {
    const s = await withProjects();
    await s.post({ id: ID, words: "move house" });
    const r = await s.post({ parent: ID, id: "tk_sub_0123456789", words: "pack +nope" }, { url: TASK_SUB_PATH });
    expect(r.status).toBe(400);
    expect(JSON.parse(r.body)).toEqual({ error: 'no project "nope"' });
    expect(await s.store.getTask("tk_sub_0123456789")).toBeNull();
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

describe("the dashboard's task project routes (design 02-tasks and 09-dashboard-app, project dialog and switcher)", () => {
  type S = Awaited<ReturnType<typeof setup>>;
  const PJ = "pj_0123456789abcdef";
  const snapshot = async (s: S) => ({
    projects: await s.store.db.all("SELECT * FROM controller_projects ORDER BY id"),
    links: await s.store.db.all("SELECT * FROM controller_task_projects ORDER BY task_id, project_id"),
    tasks: await s.store.db.all("SELECT * FROM controller_tasks ORDER BY id"),
  });
  const create = (s: S, body: unknown, over: Partial<UiRequest> = {}) => s.post(body, { url: PROJECTS_PATH, ...over });
  const link = (s: S, body: unknown, over: Partial<UiRequest> = {}) => s.post(body, { url: TASK_PROJECT_PATH, ...over });
  const get = async (s: S, query = "") => respond(s.d, { method: "GET", url: `${TASKS_PATH}${query}`, host: HOST });

  /** Two tasks; Home holds the first, Old (archived) the second. */
  async function seeded() {
    const s = await setup();
    await s.post({ id: ID, words: "fix tap" });
    await s.post({ id: "tk_fedcba9876543210", words: "paint shed tomorrow" });
    await s.store.createProject({ id: "pj_home", name: "Home", created_by: ACTOR });
    await s.store.createProject({ id: "pj_old", name: "Old", created_by: ACTOR });
    await s.store.addTaskToProject("pj_home", ID);
    await s.store.addTaskToProject("pj_old", "tk_fedcba9876543210");
    await s.store.archiveProject("pj_old");
    return s;
  }

  it("both POST routes are task write routes", () => {
    expect(Object.keys(TASK_WRITES)).toEqual(expect.arrayContaining([PROJECTS_PATH, TASK_PROJECT_PATH]));
  });

  it("POST /api/v1/projects creates a project by the page's actor; a repeat with the same ID stores nothing more", async () => {
    const s = await setup();
    const r = await create(s, { id: PJ, name: "  Home   Repairs " });
    expect(r.status).toBe(200);
    expect(JSON.parse(r.body)).toEqual({ project: { id: PJ, slug: "home-repairs", name: "Home Repairs", archived_at: null } });
    expect(await s.store.getProject(PJ)).toMatchObject({ created_by: ACTOR });
    const before = await snapshot(s);
    const again = await create(s, { id: PJ, name: "  Home   Repairs " });
    expect(again.status).toBe(200);
    expect(JSON.parse(again.body)).toEqual(JSON.parse(r.body));
    expect(await snapshot(s)).toEqual(before);
  });

  it("POST /api/v1/projects answers 400 for an invalid name or body, 409 naming the holder of a taken slug, 503 with no actor; each writes nothing", async () => {
    const s = await setup();
    await create(s, { id: PJ, name: "Home" });
    const before = await snapshot(s);
    const empty = await create(s, { id: "pj_aaaaaaaaaaaa", name: "   " });
    expect(empty.status).toBe(400);
    expect(JSON.parse(empty.body).error).toBe("a project name must not be empty");
    expect((await create(s, { id: "pj_aaaaaaaaaaaa", name: "!!!" })).status).toBe(400);
    for (const body of [{ id: "nope", name: "Garden" }, { id: "pj_aaaaaaaaaaaa" }, { id: "pj_aaaaaaaaaaaa", name: 3 }, { id: "pj_aaaaaaaaaaaa", name: "Garden", x: 1 }, []]) {
      expect((await create(s, body)).status, JSON.stringify(body)).toBe(400);
    }
    const taken = await create(s, { id: "pj_bbbbbbbbbbbb", name: "HOME" });
    expect(taken.status).toBe(409);
    expect(JSON.parse(taken.body)).toMatchObject({ error: 'project "home" exists already', project: { id: PJ, slug: "home" } });
    const off = await setup({ actor: null });
    expect((await create(off, { id: PJ, name: "Home" })).status).toBe(503);
    expect(await off.store.listProjects("active")).toEqual([]);
    expect(await snapshot(s)).toEqual(before);
  });

  it("POST /api/v1/tasks/project adds and removes a task's link; changed is false when it was in that state", async () => {
    const s = await seeded();
    const other = "tk_fedcba9876543210";
    const add = await link(s, { id: other, project: "home", add: true });
    expect(add.status).toBe(200);
    expect(JSON.parse(add.body)).toEqual({ task_id: other, project: "home", changed: true });
    expect(JSON.parse((await link(s, { id: other, project: "home", add: true })).body)).toMatchObject({ changed: false });
    expect((await s.store.listTaskProjects(other)).map((p) => p.slug)).toEqual(["home"]);
    expect(JSON.parse((await link(s, { id: other, project: "home", add: false })).body)).toEqual({ task_id: other, project: "home", changed: true });
    expect(JSON.parse((await link(s, { id: other, project: "home", add: false })).body)).toMatchObject({ changed: false });
    expect(await s.store.listTaskProjects(other)).toEqual([]);
    // Removing from an archived project is allowed: only an add is refused.
    expect(JSON.parse((await link(s, { id: other, project: "old", add: false })).body)).toMatchObject({ changed: true });
  });

  it("POST /api/v1/tasks/project answers 400, 404 and the archived reason, and 503 with no actor; each writes nothing", async () => {
    const s = await seeded();
    const before = await snapshot(s);
    for (const body of [{ id: ID, project: "home" }, { id: ID, project: "Home", add: true }, { id: ID, project: "home", add: "yes" }, { id: "", project: "home", add: true }, { id: ID, project: "home", add: true, x: 1 }, "x"]) {
      expect((await link(s, body)).status, JSON.stringify(body)).toBe(400);
    }
    const noProject = await link(s, { id: ID, project: "garden", add: true });
    expect(noProject.status).toBe(404);
    expect(JSON.parse(noProject.body)).toEqual({ error: 'no project "garden"' });
    expect((await link(s, { id: "tk_nope_nope", project: "home", add: true })).status).toBe(404);
    expect((await link(s, { id: "tk_nope_nope", project: "home", add: false })).status).toBe(404);
    const archived = await link(s, { id: ID, project: "old", add: true });
    expect(archived.status).toBe(400);
    expect(JSON.parse(archived.body)).toEqual({ error: 'project "old" is archived; restore it first' });
    const off = await setup({ actor: null });
    expect((await link(off, { id: ID, project: "home", add: true })).status).toBe(503);
    expect(await snapshot(s)).toEqual(before);
  });

  it("both POST routes refuse a missing CSRF token (403) and a wrong Content-Type (415) and write nothing", async () => {
    const s = await seeded();
    const before = await snapshot(s);
    for (const send of [() => create(s, { id: PJ, name: "Garden" }, { csrfToken: undefined }), () => link(s, { id: ID, project: "home", add: false }, { csrfToken: undefined })]) {
      expect((await send()).status).toBe(403);
    }
    for (const send of [() => create(s, { id: PJ, name: "Garden" }, { contentType: "text/plain" }), () => link(s, { id: ID, project: "home", add: false }, { contentType: "text/plain" })]) {
      expect((await send()).status).toBe(415);
    }
    for (const over of [{ host: "evil.example" }, { origin: "https://evil.example" }, { bodyTooLarge: true }, { body: "{not json" }] as Partial<UiRequest>[]) {
      expect((await create(s, { id: PJ, name: "Garden" }, over)).status, JSON.stringify(over)).toBeGreaterThanOrEqual(400);
      expect((await link(s, { id: ID, project: "home", add: false }, over)).status, JSON.stringify(over)).toBeGreaterThanOrEqual(400);
    }
    expect(await snapshot(s)).toEqual(before);
  });

  it("GET /api/v1/tasks lists the active projects and each row's project slugs, and writes nothing", async () => {
    const s = await seeded();
    const before = await snapshot(s);
    const v = JSON.parse((await get(s)).body);
    expect(v.active_projects).toEqual([{ slug: "home", name: "Home" }]);
    expect(v.projects.flatMap((p: { tasks: { id: string; projects: string[] }[] }) => p.tasks).find((t: { id: string }) => t.id === ID).projects).toEqual(["home"]);
    // Old is archived: its link stays, but the row shows active projects only.
    expect(v.upcoming.flatMap((d: { tasks: { id: string; projects: string[] }[] }) => d.tasks).find((t: { id: string }) => t.id === "tk_fedcba9876543210").projects).toEqual([]);
    expect(await snapshot(s)).toEqual(before);
  });

  it("GET /api/v1/tasks?project=<slug> keeps only that project's tasks in every view; 404 unknown, 400 archived or not a slug", async () => {
    const s = await seeded();
    await s.post({ id: "tk_home_tomorrow1", words: "buy washers tomorrow +home" });
    const ids = (rows: { id?: string }[]) => rows.map((t) => t.id);
    const v = JSON.parse((await get(s, "?project=home")).body);
    expect(v).not.toHaveProperty("inbox");
    expect(ids(v.upcoming.flatMap((d: { tasks: { id: string }[] }) => d.tasks))).toEqual(["tk_home_tomorrow1"]);
    expect(v.projects.flatMap((p: { tasks: { id: string }[] }) => ids(p.tasks)).sort()).toEqual([ID, "tk_home_tomorrow1"].sort());
    const all = JSON.parse((await get(s)).body);
    expect(ids(all.upcoming.flatMap((d: { tasks: { id: string }[] }) => d.tasks))).toContain("tk_fedcba9876543210");
    const unknown = await get(s, "?project=garden");
    expect(unknown.status).toBe(404);
    expect(JSON.parse(unknown.body)).toEqual({ error: 'no project "garden"' });
    expect((await get(s, "?project=old")).status).toBe(400);
    expect((await get(s, "?project=Not%20A%20Slug")).status).toBe(400);
    expect((await get(s, "?project=")).status).toBe(400);
  });
});
