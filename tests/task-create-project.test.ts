import { describe, expect, it } from "vitest";
import { type CliAction, type LocalCliDeps, parseLocalCliArgs, runLocalCli } from "../src/core/local-cli.js";
import type { UserId, WorkItemId } from "../src/core/types.js";
import { FakeClock } from "../src/impl/clock/fake-clock.js";
import { PatternEgressScanner } from "../src/impl/egress/pattern-egress-scanner.js";
import { HealthMonitor } from "../src/ui/health.js";
import { type ApiDeps, type UiRequest, respond } from "../src/ui/server.js";
import { newCsrfToken } from "../src/ui/settings-api.js";
import { TASK_CREATE_PATH } from "../src/ui/tasks-api.js";
import { PROJECT_KEY, newStore } from "./helpers/store.js";

// Create under a project (design 02-tasks): `factory task create --title <t> --body-file <f> --project <slug>` and the
// dashboard's POST /api/v1/tasks/create store a task in that project linked to a new local work item, as `task build`
// links one. Without --project, `task create` makes the work item only. An unknown or archived project is refused with
// nothing written.

const USER = "local:dev@example.com" as UserId;
const ACTOR = "local:owner@example.com" as UserId;
const HOST = "127.0.0.1:4310";

async function setup(project: string | null = PROJECT_KEY) {
  const clock = new FakeClock(new Date(2026, 10, 15, 9, 0));
  const { store } = await newStore(clock);
  let n = 0;
  const d: LocalCliDeps = {
    store, identity: { user: USER, from: "git user.email" }, project: async () => project, read: async () => "  the body  \n", newId: () => `id${++n}`,
  };
  const run = (word: string, ...args: string[]) => {
    const a = parseLocalCliArgs(word, args);
    if ("error" in a) throw new Error(a.error);
    return runLocalCli(d, a as CliAction);
  };
  const cli = (...args: string[]) => run("task", ...args);
  /** Every row a create could write: tasks, their project links, work items, runs and state changes. */
  const snapshot = async () => ({
    tasks: await store.db.all("SELECT * FROM controller_tasks ORDER BY id"),
    links: await store.listTaskProjectSlugs((await store.listTasks(100)).map((t) => t.id)),
    items: await store.db.all("SELECT id, version, source_id FROM controller_work_items ORDER BY id"),
    runs: await store.db.all("SELECT id FROM worker_runs ORDER BY id"),
    changes: await store.db.all("SELECT id FROM controller_state_changes ORDER BY id"),
  });
  await run("project", "create", "Improve Factory");
  await run("project", "create", "Old");
  await run("project", "archive", "old");
  return { store, clock, cli, snapshot };
}

const create = ["create", "--title", "Design rules checked", "--body-file", "body.md"];

describe("factory task create --project", () => {
  it("without --project: the work item only, its ID printed, no task", async () => {
    const s = await setup();
    const r = await s.cli(...create);
    expect(r.code).toBe(0);
    expect(r.lines).toHaveLength(1);
    const item = (await s.store.getWorkItem(r.lines[0] as WorkItemId))!;
    expect(item).toMatchObject({ title: "Design rules checked", problem: "Design rules checked\n\nthe body", source: { type: "local" } });
    expect(item.source.id).not.toContain("local-task-");
    expect(await s.store.listTasks(100)).toEqual([]);
  });

  it("with --project: a task in the project linked to the new work item, as task build links one", async () => {
    const s = await setup();
    const r = await s.cli(...create, "--project", "improve-factory");
    expect(r.code).toBe(0);
    const [task] = await s.store.listTasks(100);
    expect(task).toMatchObject({ title: "Design rules checked", created_by: USER, done_at: null });
    expect(r.lines).toEqual([task!.work_item_id, `task ${task!.id} in +improve-factory`]);
    const item = (await s.store.getWorkItem(task!.work_item_id!))!;
    expect(item).toMatchObject({ stage: "NEW", title: "Design rules checked", problem: "Design rules checked\n\nthe body", project: PROJECT_KEY, requester_id: USER, source: { type: "local", id: `local-task-${task!.id}` } });
    expect((await s.store.listRuns(item.id)).map((x) => x.kind)).toEqual(["triage"]);
    expect(await s.store.listTaskProjectSlugs([task!.id])).toEqual({ [task!.id]: ["improve-factory"] });
  });

  it("task list --project <slug> shows the created item", async () => {
    const s = await setup();
    await s.cli(...create, "--project", "+Improve-Factory");
    const [task] = await s.store.listTasks(100);
    const listed = await s.cli("list", "--project", "improve-factory");
    expect(listed.code).toBe(0);
    expect(listed.lines.some((l) => l.includes(task!.id) && l.includes("Design rules checked") && l.includes("+improve-factory"))).toBe(true);
  });

  it("refuses an unknown or archived project, and no stored project key, writing nothing", async () => {
    const s = await setup();
    const before = await s.snapshot();
    expect(await s.cli(...create, "--project", "nope")).toEqual({ code: 1, lines: ['no project "nope"'] });
    expect(await s.cli(...create, "--project", "old")).toEqual({ code: 1, lines: ['project "old" is archived; restore it first'] });
    expect(await s.snapshot()).toEqual(before);
    const none = await setup(null);
    const noneBefore = await none.snapshot();
    const r = await none.cli(...create, "--project", "improve-factory");
    expect(r.code).toBe(1);
    expect(r.lines[0]).toContain("no project is stored yet");
    expect(await none.snapshot()).toEqual(noneBefore);
  });

  it("refuses a --project with no slug and a repeated --project", () => {
    expect(parseLocalCliArgs("task", [...create, "--project", "+"])).toMatchObject({ error: expect.stringContaining("--project needs a project slug") });
    expect(parseLocalCliArgs("task", [...create, "--project", "a", "--project", "b"])).toMatchObject({ error: expect.stringContaining("unexpected") });
    expect(parseLocalCliArgs("task", [...create, "--project"])).toMatchObject({ error: expect.stringContaining("unexpected") });
  });
});

async function route(opts: { project?: string | null; actor?: UserId | null } = {}) {
  const s = await setup(opts.project === undefined ? PROJECT_KEY : opts.project);
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
      method: "POST", url: TASK_CREATE_PATH, host: HOST, origin: `http://${HOST}`, contentType: "application/json", csrfToken: token,
      body: JSON.stringify(body), ...over,
    });
  return { ...s, post };
}

const ID = "tk_0123456789abcdef";
const body = { id: ID, title: "Design rules checked", body: "the body", project: "improve-factory" };

describe("POST /api/v1/tasks/create (the dashboard's create flow)", () => {
  it("makes the same linked task and project membership as the CLI, as the page's actor; a retry adds nothing", async () => {
    const s = await route();
    const r = await s.post(body);
    expect(r.status).toBe(200);
    const v = JSON.parse(r.body);
    const task = (await s.store.getTask(ID))!;
    expect(v).toEqual({ task_id: ID, work_item_id: task.work_item_id, created: true });
    expect(task).toMatchObject({ title: "Design rules checked", created_by: ACTOR });
    expect(await s.store.getWorkItem(task.work_item_id!)).toMatchObject({
      stage: "NEW", requester_id: ACTOR, problem: "Design rules checked\n\nthe body", source: { type: "local", id: `local-task-${ID}` },
    });
    expect(await s.store.listTaskProjectSlugs([ID])).toEqual({ [ID]: ["improve-factory"] });
    const listed = await s.cli("list", "--project", "improve-factory");
    expect(listed.lines.some((l) => l.includes(ID))).toBe(true);
    const before = await s.snapshot();
    const again = await s.post(body);
    expect(JSON.parse(again.body)).toEqual({ ...v, created: false });
    expect(await s.snapshot()).toEqual(before);
  });

  it("refuses an unknown or archived project (409), no stored project key (409), a bad body (400) and no actor (503), writing nothing", async () => {
    const s = await route();
    const before = await s.snapshot();
    const unknown = await s.post({ ...body, project: "nope" });
    expect([unknown.status, JSON.parse(unknown.body).error]).toEqual([409, 'no project "nope"']);
    const archived = await s.post({ ...body, project: "old" });
    expect([archived.status, JSON.parse(archived.body).error]).toEqual([409, 'project "old" is archived; restore it first']);
    for (const bad of [{ ...body, project: "Not A Slug" }, { ...body, title: " " }, { ...body, body: 7 }, { ...body, id: "bad" }, { ...body, extra: 1 }, { id: ID, title: "t", body: "" }]) {
      expect((await s.post(bad)).status, JSON.stringify(bad)).toBe(400);
    }
    expect((await s.post(body, { csrfToken: "stale" })).status).toBe(403);
    expect(await s.snapshot()).toEqual(before);
    const none = await route({ project: null });
    const noneBefore = await none.snapshot();
    const r = await none.post(body);
    expect(r.status).toBe(409);
    expect(JSON.parse(r.body).error).toContain("no project is stored yet");
    expect(await none.snapshot()).toEqual(noneBefore);
    const noActor = await route({ actor: null });
    expect((await noActor.post(body)).status).toBe(503);
    expect(await noActor.store.getTask(ID)).toBeNull();
  });
});
