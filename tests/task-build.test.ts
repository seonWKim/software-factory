import { describe, expect, it } from "vitest";
import migration from "../src/controller/migrations/20261112T1500-controller-tasks-work-item.migration.js";
import { type CliAction, type LocalCliDeps, parseLocalCliArgs, runLocalCli } from "../src/core/local-cli.js";
import type { UserId, WorkItemId } from "../src/core/types.js";
import { FakeClock } from "../src/impl/clock/fake-clock.js";
import { PatternEgressScanner } from "../src/impl/egress/pattern-egress-scanner.js";
import { MIGRATIONS_TABLE, type MigrationDb, type SqlDriver, tableColumns } from "../src/state/index.js";
import { HealthMonitor } from "../src/ui/health.js";
import { type ApiDeps, type UiRequest, respond } from "../src/ui/server.js";
import { newCsrfToken } from "../src/ui/settings-api.js";
import { TASKS_PATH, TASK_BUILD_PATH } from "../src/ui/tasks-api.js";
import { PROJECT_KEY, newStore } from "./helpers/store.js";

// Build this (design 02-tasks, issue #607): `factory task build <task_id>` and the Tasks page's button send an open
// task to intake as one local work item and store its ID on the task. A second build makes no second item and writes
// nothing; a done task, or no stored project key, is refused with nothing written.

const USER = "local:dev@example.com" as UserId;

async function setup(project: string | null = PROJECT_KEY) {
  const clock = new FakeClock(new Date(2026, 10, 12, 9, 0));
  const { store } = await newStore(clock);
  let n = 0;
  const d: LocalCliDeps = {
    store, identity: { user: USER, from: "git user.email" }, project: async () => project, read: async () => "", newId: () => `id${++n}`,
  };
  const cli = (...args: string[]) => {
    const a = parseLocalCliArgs("task", args);
    if ("error" in a) throw new Error(a.error);
    return runLocalCli(d, a as CliAction);
  };
  /** Every row a build could write: tasks, work items, runs and state changes. */
  const snapshot = async () => ({
    tasks: await store.db.all("SELECT * FROM controller_tasks ORDER BY id"),
    items: await store.db.all("SELECT id, version, source_id FROM controller_work_items ORDER BY id"),
    runs: await store.db.all("SELECT id FROM worker_runs ORDER BY id"),
    changes: await store.db.all("SELECT id FROM controller_state_changes ORDER BY id"),
  });
  return { store, clock, cli, snapshot };
}

describe("factory task build", () => {
  it("creates one local work item in intake, its triage queued, and stores its ID on the task", async () => {
    const s = await setup();
    await s.cli("add", "pay", "rent", "#home");
    const r = await s.cli("build", "tk_id1");
    expect(r.code).toBe(0);
    const task = (await s.store.getTask("tk_id1"))!;
    expect(task.work_item_id).not.toBeNull();
    expect(r.lines).toEqual([`built tk_id1 as ${task.work_item_id}`]);
    const item = (await s.store.getWorkItem(task.work_item_id!))!;
    expect(item).toMatchObject({ stage: "NEW", title: "pay rent", project: PROJECT_KEY, requester_id: USER, source: { type: "local", id: "local-task-tk_id1" } });
    expect((await s.store.listRuns(item.id)).map((x) => x.kind)).toEqual(["triage"]);
    // The task stays open until its change merges.
    expect(task.done_at).toBeNull();
  });

  it("a second build of the same task creates no second item and changes nothing", async () => {
    const s = await setup();
    await s.cli("add", "pay", "rent");
    const first = await s.cli("build", "tk_id1");
    const before = await s.snapshot();
    s.clock.advance(60_000);
    const again = await s.cli("build", "tk_id1");
    expect(again.code).toBe(0);
    expect(again.lines[0]).toBe(`tk_id1 was already built as ${first.lines[0]!.split(" as ")[1]}`);
    expect(await s.snapshot()).toEqual(before);
    expect(before.items).toHaveLength(1);
  });

  it("a build retried after the item was made but before the link was stored makes no second item", async () => {
    const s = await setup();
    await s.cli("add", "pay", "rent");
    await s.cli("build", "tk_id1");
    const linked = (await s.store.getTask("tk_id1"))!.work_item_id;
    await s.store.db.run("UPDATE controller_tasks SET work_item_id = NULL");
    await s.cli("build", "tk_id1");
    expect((await s.store.getTask("tk_id1"))!.work_item_id).toBe(linked);
    expect((await s.snapshot()).items).toHaveLength(1);
  });

  it("refuses a done task, and writes nothing", async () => {
    const s = await setup();
    await s.cli("add", "pay", "rent");
    await s.cli("done", "tk_id1");
    const before = await s.snapshot();
    const r = await s.cli("build", "tk_id1");
    expect(r).toEqual({ code: 1, lines: ["tk_id1 is done: only an open task can be built"] });
    expect(await s.snapshot()).toEqual(before);
  });

  it("refuses a task when no project key is stored, and writes nothing", async () => {
    const s = await setup(null);
    await s.cli("add", "pay", "rent");
    const before = await s.snapshot();
    const r = await s.cli("build", "tk_id1");
    expect(r.code).toBe(1);
    expect(r.lines[0]).toContain("no project is stored yet");
    expect(await s.snapshot()).toEqual(before);
  });

  it("refuses an unknown task and a build with no task ID", async () => {
    const s = await setup();
    expect(await s.cli("build", "tk_nope")).toEqual({ code: 1, lines: ["no task tk_nope"] });
    expect(parseLocalCliArgs("task", ["build"])).toMatchObject({ error: expect.stringContaining("task build needs one task ID") });
  });

  it("a recurring task's next occurrence is not linked to the item its parent was built as", async () => {
    const s = await setup();
    await s.cli("add", "water", "plants", "today", "every", "week");
    await s.cli("build", "tk_id1");
    const r = await s.store.completeTask("tk_id1");
    expect(r).toMatchObject({ ok: true, next: { parent_id: "tk_id1", work_item_id: null } });
  });
});

const HOST = "127.0.0.1:4310";
const ACTOR = "local:owner@example.com" as UserId;

async function route(opts: { project?: string | null; actor?: UserId | null } = {}) {
  const s = await setup();
  const token = newCsrfToken();
  const project = opts.project === undefined ? PROJECT_KEY : opts.project;
  const d: ApiDeps = {
    store: s.store,
    scanner: new PatternEgressScanner(async () => []),
    clock: s.clock,
    lease_ms: 300_000,
    health: new HealthMonitor(async () => [], s.clock),
    commands: { actor: opts.actor === undefined ? ACTOR : opts.actor, source: "environment" as const, token },
    settings: {
      base: { defaults: {}, projects: {} } as never, repo: { owner: "o", name: "r" }, actor: ACTOR, csrfToken: newCsrfToken(),
      resolveProject: async () => (project === null ? null : { key: project, label: "o/r" } as never),
    },
  };
  const post = (body: unknown, over: Partial<UiRequest> = {}) =>
    respond(d, {
      method: "POST", url: TASK_BUILD_PATH, host: HOST, origin: `http://${HOST}`, contentType: "application/json", csrfToken: token,
      body: JSON.stringify(body), ...over,
    });
  const get = async () => JSON.parse((await respond(d, { method: "GET", url: TASKS_PATH, host: HOST })).body);
  return { ...s, token, post, get };
}

describe("POST /api/v1/tasks/build (Build this)", () => {
  it("builds the task once, as the page's actor; a second press answers the same item and writes nothing", async () => {
    const s = await route();
    await s.cli("add", "pay", "rent");
    const r = await s.post({ id: "tk_id1" });
    expect(r.status).toBe(200);
    const body = JSON.parse(r.body);
    expect(body).toMatchObject({ task_id: "tk_id1", created: true });
    expect(await s.store.getWorkItem(body.work_item_id as WorkItemId)).toMatchObject({ requester_id: ACTOR, stage: "NEW" });
    const before = await s.snapshot();
    const again = await s.post({ id: "tk_id1" });
    expect(JSON.parse(again.body)).toEqual({ ...body, created: false });
    expect(await s.snapshot()).toEqual(before);
  });

  it("takes the item commands route's guards: Origin, Content-Type, CSRF token, Host; every refusal writes nothing", async () => {
    const s = await route();
    await s.cli("add", "pay", "rent");
    const before = await s.snapshot();
    for (const over of [{ csrfToken: undefined }, { csrfToken: "stale" }, { origin: "https://evil.example" }, { host: "evil.example" }]) {
      expect((await s.post({ id: "tk_id1" }, over)).status, JSON.stringify(over)).toBe(403);
    }
    expect((await s.post({ id: "tk_id1" }, { contentType: "text/plain" })).status).toBe(415);
    expect((await s.post({ id: "tk_id1" }, { bodyTooLarge: true })).status).toBe(413);
    expect((await s.post({ id: 7 })).status).toBe(400);
    expect((await s.post({ id: "tk_id1", extra: 1 })).status).toBe(400);
    expect(await s.snapshot()).toEqual(before);
  });

  it("refuses a done task (409), no stored project (409) and no actor (503), writing nothing", async () => {
    const done = await route();
    await done.cli("add", "a");
    await done.cli("done", "tk_id1");
    const r1 = await done.post({ id: "tk_id1" });
    expect([r1.status, JSON.parse(r1.body).error]).toEqual([409, "tk_id1 is done: only an open task can be built"]);
    const noProject = await route({ project: null });
    await noProject.cli("add", "a");
    const before = await noProject.snapshot();
    const r2 = await noProject.post({ id: "tk_id1" });
    expect(r2.status).toBe(409);
    expect(JSON.parse(r2.body).error).toContain("no project is stored yet");
    expect(await noProject.snapshot()).toEqual(before);
    const noActor = await route({ actor: null });
    await noActor.cli("add", "a");
    expect((await noActor.post({ id: "tk_id1" })).status).toBe(503);
    expect((await noActor.store.getTask("tk_id1"))!.work_item_id).toBeNull();
  });
});

describe("GET /api/v1/tasks", () => {
  it("answers the open tasks' views at the server's clock, the token, and whether Build this is on", async () => {
    const s = await route();
    await s.cli("add", "inbox");
    await s.cli("add", "late", "2026-11-10");
    await s.cli("add", "now", "today");
    await s.cli("add", "soon", "tomorrow", "#home");
    const v = await s.get();
    expect(v).toMatchObject({ today_date: "2026-11-12", csrf_token: s.token, can_build: true });
    expect(v).not.toHaveProperty("inbox");
    expect(v.today.overdue.map((t: { title: string }) => t.title)).toEqual(["late"]);
    expect(v.today.due.map((t: { title: string }) => t.title)).toEqual(["now"]);
    expect(v.upcoming).toEqual([
      { date: "2026-11-12", tasks: [expect.objectContaining({ title: "now" })] },
      { date: "2026-11-13", tasks: [expect.objectContaining({ title: "soon", work_item_id: null })] },
    ]);
    expect(v.projects.map((p: { list: string | null; tasks: { title: string }[] }) => [p.list, p.tasks.map((t) => t.title)])).toEqual([["home", ["soon"]], [null, ["late", "now", "inbox"]]]);
  });
});

describe("migration: controller_tasks.work_item_id", () => {
  const ID = "20261112T1500-controller-tasks-work-item";
  const mdb = (db: SqlDriver): MigrationDb => ({ dialect: "sqlite", all: (q, p) => db.all(q, p), run: (q, p) => db.run(q, p) });

  it("a fresh store has the nullable column and the migration recorded", async () => {
    const { store } = await newStore();
    expect(await tableColumns(mdb(store.db), "controller_tasks")).toContain("work_item_id");
    expect(await store.db.all(`SELECT id FROM ${MIGRATIONS_TABLE} WHERE id = ?`, [ID])).toEqual([{ id: ID }]);
  });

  it("a store with the #606 table gets the column; its rows stay unlinked, and a rerun changes nothing", async () => {
    const { store } = await setup();
    await store.addTask({ id: "tk_old", title: "old", list: null, priority: null, due: null, due_time: null, recurrence: null, created_by: USER });
    await store.db.run("ALTER TABLE controller_tasks DROP COLUMN work_item_id");
    await store.db.run(`DELETE FROM ${MIGRATIONS_TABLE} WHERE id = ?`, [ID]);
    expect(await tableColumns(mdb(store.db), "controller_tasks")).not.toContain("work_item_id");
    await store.migrate();
    expect(await store.db.all(`SELECT id FROM ${MIGRATIONS_TABLE} WHERE id = ?`, [ID])).toEqual([{ id: ID }]);
    expect(await store.db.all("SELECT id, title, work_item_id FROM controller_tasks")).toEqual([{ id: "tk_old", title: "old", work_item_id: null }]);
    expect(migration).toMatchObject({ change: "additive" });
    await migration.up(mdb(store.db));
    expect(await store.getTask("tk_old")).toMatchObject({ id: "tk_old", work_item_id: null });
  });
});
