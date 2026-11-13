import { describe, expect, it } from "vitest";
import { type CliAction, type LocalCliDeps, parseLocalCliArgs, runLocalCli } from "../src/core/local-cli.js";
import type { NewTask } from "../src/core/tasks.js";
import type { UserId } from "../src/core/types.js";
import { FakeClock } from "../src/impl/clock/fake-clock.js";
import { issue, newStore, system } from "./helpers/store.js";

// Undo a task's completion (design 02-tasks): reopenTask sets done_at back to NULL where it is set, in one transaction;
// a recurring task's open next occurrence is deleted with it, a done one refuses it. Plain tasks only: work items stay final.

const USER = "local:dev@example.com" as UserId;
const DAY = 24 * 60 * 60 * 1000;

async function setup() {
  const clock = new FakeClock("2026-11-11T12:00:00.000Z");
  const { store } = await newStore(clock);
  const d: LocalCliDeps = { store, identity: { user: USER, from: "git user.email" }, project: async () => null, read: async () => "", newId: () => "x" };
  const cli = (...args: string[]) => {
    const a = parseLocalCliArgs("task", args);
    if ("error" in a) throw new Error(a.error);
    return runLocalCli(d, a as CliAction);
  };
  const rows = () => store.db.all("SELECT * FROM controller_tasks ORDER BY id");
  return { store, clock, cli, rows };
}

const task = (over: Partial<NewTask> = {}): NewTask => ({
  id: "tk_1", title: "water plants", list: null, priority: null, due: { date: "2026-11-11" }, due_time: null, recurrence: null, created_by: USER, ...over,
});

describe("reopenTask", () => {
  it("sets done_at back to NULL on a done task, which is listed open again", async () => {
    const { store, clock } = await setup();
    const added = await store.addTask(task());
    await store.completeTask("tk_1");
    clock.advance(DAY);
    const r = await store.reopenTask("tk_1");
    expect(r).toEqual({ ok: true, task: added, reopened: true, removed_next: null });
    expect((await store.listTasks(10)).map((t) => t.id)).toEqual(["tk_1"]);
  });

  it("an open task writes nothing and answers reopened false; an unknown ID answers not_found", async () => {
    const { store, rows } = await setup();
    await store.addTask(task());
    const before = await rows();
    expect(await store.reopenTask("tk_1")).toMatchObject({ ok: true, reopened: false, removed_next: null, task: { id: "tk_1", done_at: null } });
    expect(await rows()).toEqual(before);
    expect(await store.reopenTask("tk_nope")).toEqual({ ok: false, reason: "not_found" });
  });

  it("a second reopen writes nothing", async () => {
    const { store, rows } = await setup();
    await store.addTask(task({ recurrence: "week" }));
    await store.completeTask("tk_1");
    expect(await store.reopenTask("tk_1")).toMatchObject({ reopened: true });
    const after = await rows();
    expect(await store.reopenTask("tk_1")).toMatchObject({ ok: true, reopened: false, removed_next: null });
    expect(await rows()).toEqual(after);
  });

  it("a recurring task's open next occurrence is deleted in the same reopen, so completing again makes one", async () => {
    const { store, rows } = await setup();
    await store.addTask(task({ recurrence: "week" }));
    const done = await store.completeTask("tk_1");
    const next = done.ok ? done.next! : null;
    expect(next).not.toBeNull();
    const r = await store.reopenTask("tk_1");
    expect(r).toMatchObject({ ok: true, reopened: true, removed_next: next!.id, task: { done_at: null } });
    expect(await store.getTask(next!.id)).toBeNull();
    expect((await rows()).map((x) => x.id)).toEqual(["tk_1"]);
    const again = await store.completeTask("tk_1");
    expect(again).toMatchObject({ ok: true, completed: true, next: { parent_id: "tk_1", due_date: "2026-11-18" } });
  });

  it("the deleted occurrence's sub-tasks move under the reopened task", async () => {
    const { store } = await setup();
    await store.addTask(task({ recurrence: "week" }));
    const done = await store.completeTask("tk_1");
    const nextId = done.ok ? done.next!.id : "";
    await store.addSubTask(nextId, task({ id: "tk_sub", recurrence: null }));
    await store.reopenTask("tk_1");
    expect(await store.getTask("tk_sub")).toMatchObject({ parent_task_id: "tk_1" });
  });

  it("refuses with next_done, writing nothing, when the next occurrence is done", async () => {
    const { store, rows } = await setup();
    await store.addTask(task({ recurrence: "day" }));
    const done = await store.completeTask("tk_1");
    const nextId = done.ok ? done.next!.id : "";
    await store.completeTask(nextId);
    const before = await rows();
    expect(await store.reopenTask("tk_1")).toMatchObject({ ok: false, reason: "next_done", next: { id: nextId } });
    expect(await rows()).toEqual(before);
  });

  it("leaves work items final: a closed work item is not reopened", async () => {
    const { store } = await setup();
    const { item } = await store.createWorkItem(issue(1), system);
    expect(await store.reopenTask(item.id)).toEqual({ ok: false, reason: "not_found" });
    expect((await store.getWorkItem(item.id))!.stage).toBe(item.stage);
  });
});

describe("factory task reopen", () => {
  it("reopens a done task, says when it was open already, and fails for an unknown ID or a done next occurrence", async () => {
    const { store, cli } = await setup();
    await store.addTask(task());
    await store.completeTask("tk_1");
    expect(await cli("reopen", "tk_1")).toEqual({ code: 0, lines: ["reopened tk_1"] });
    expect(await cli("reopen", "tk_1")).toEqual({ code: 0, lines: ["tk_1 was not done"] });
    expect(await cli("reopen", "tk_nope")).toEqual({ code: 1, lines: ["no task tk_nope"] });
    await store.addTask(task({ id: "tk_2", recurrence: "day" }));
    const done = await store.completeTask("tk_2");
    const nextId = done.ok ? done.next!.id : "";
    expect((await cli("reopen", "tk_2")).lines).toEqual(["reopened tk_2", `removed its next occurrence ${nextId}`]);
    const again = await store.completeTask("tk_2");
    await store.completeTask(again.ok ? again.next!.id : "");
    expect((await cli("reopen", "tk_2")).code).toBe(1);
  });

  it("takes exactly one task ID", () => {
    expect(parseLocalCliArgs("task", ["reopen"])).toMatchObject({ error: expect.stringContaining("task reopen needs one task ID") });
    expect(parseLocalCliArgs("task", ["reopen", "a", "b"])).toMatchObject({ error: expect.stringContaining("task reopen needs one task ID") });
  });
});
