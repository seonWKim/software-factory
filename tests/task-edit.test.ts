import { describe, expect, it } from "vitest";
import { COMMAND_TABLE, chatCliArgv, parseChatCommand } from "../src/core/command-table.js";
import { type CliAction, type LocalCliDeps, parseLocalCliArgs, runLocalCli } from "../src/core/local-cli.js";
import { parseQuickEdit } from "../src/core/quick-add.js";
import type { UserId, WorkItemId } from "../src/core/types.js";
import { FakeClock } from "../src/impl/clock/fake-clock.js";
import { issue, newStore, system } from "./helpers/store.js";

// Managing plain tasks (design 02-tasks): edit with quick-add words, hard delete, and one level of sub-tasks, from the
// CLI and chat. The store methods themselves are covered in tests/store-contract.test.ts.

const USER = "local:dev@example.com" as UserId;

async function setup() {
  const clock = new FakeClock("2026-11-11T12:00:00.000Z");
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
  /** As typed in chat after a mention of the bot. */
  const chat = (text: string) => {
    const c = parseChatCommand(text);
    if (c?.kind !== "command") throw new Error(`not a chat command: ${text}`);
    const argv = chatCliArgv(c, null);
    const a = parseLocalCliArgs(argv.word, argv.args);
    if ("error" in a) throw new Error(a.error);
    return runLocalCli(d, a as CliAction);
  };
  const rows = () => store.db.all("SELECT * FROM controller_tasks ORDER BY id");
  return { store, clock, cli, chat, rows };
}

describe("parseQuickEdit", () => {
  it("names only the fields the words give; words with no title leave the title out", () => {
    expect(parseQuickEdit("!1")).toEqual({ ok: true, edit: { priority: 1 } });
    expect(parseQuickEdit("#work 09:00")).toEqual({ ok: true, edit: { list: "work", due_time: "09:00" } });
    expect(parseQuickEdit("pay the rent tomorrow")).toEqual({ ok: true, edit: { title: "pay the rent", due: { days_from_today: 1 } } });
    expect(parseQuickEdit("every week")).toEqual({ ok: true, edit: { recurrence: "week" } });
  });

  it("refuses what quick-add refuses, and no words at all", () => {
    expect(parseQuickEdit("2026-13-01")).toMatchObject({ ok: false, reason: "not a date: 2026-13-01" });
    expect(parseQuickEdit("!4")).toMatchObject({ ok: false });
    expect(parseQuickEdit("!1 !2")).toMatchObject({ ok: false, reason: expect.stringContaining("given twice") });
    expect(parseQuickEdit("  ")).toMatchObject({ ok: false, reason: expect.stringContaining("nothing to change") });
  });
});

describe("factory task edit", () => {
  it("changes only the fields the words name; every other field keeps its stored value", async () => {
    const { store, cli } = await setup();
    await cli("add", "pay", "rent", "2026-12-01", "08:30", "!2", "#home");
    const before = (await store.getTask("tk_id1"))!;
    const r = await cli("edit", "tk_id1", "!1");
    expect(r).toEqual({ code: 0, lines: ["edited tk_id1\tpay rent\t2026-12-01 08:30\t!1\t#home\t-"] });
    expect(await store.getTask("tk_id1")).toEqual({ ...before, priority: 1 });
    await cli("edit", "tk_id1", "#work", "every", "month");
    expect(await store.getTask("tk_id1")).toEqual({ ...before, priority: 1, list: "work", recurrence: "month" });
  });

  it("words with a title replace it; words with none keep it", async () => {
    const { store, cli } = await setup();
    await cli("add", "pay", "rent");
    await cli("edit", "tk_id1", "2026-12-24");
    expect(await store.getTask("tk_id1")).toMatchObject({ title: "pay rent", due_date: "2026-12-24" });
    await cli("edit", "tk_id1", "pay", "the", "rent");
    expect(await store.getTask("tk_id1")).toMatchObject({ title: "pay the rent", due_date: "2026-12-24" });
  });

  it("an unknown ID, a done task or refused words write nothing and say why", async () => {
    const { cli, rows } = await setup();
    await cli("add", "once");
    await cli("add", "twice");
    await cli("done", "tk_id2");
    const before = await rows();
    expect(await cli("edit", "tk_nope", "!1")).toEqual({ code: 1, lines: ["no task tk_nope"] });
    expect(await cli("edit", "tk_id2", "!1")).toEqual({ code: 1, lines: ["tk_id2 is done: a done task cannot be edited"] });
    expect(parseLocalCliArgs("task", ["edit", "tk_id1", "25:00"])).toMatchObject({ error: expect.stringContaining("task edit: not a time: 25:00") });
    expect(parseLocalCliArgs("task", ["edit", "tk_id1"])).toMatchObject({ error: expect.stringContaining("task edit needs a task ID and quick-add words") });
    // A recurrence with no due date, stored or given, is refused as quick-add refuses it.
    expect(await cli("edit", "tk_id1", "every", "day")).toEqual({ code: 1, lines: ["every day needs a due date (today, tomorrow or YYYY-MM-DD)"] });
    expect(await rows()).toEqual(before);
  });

  it("edits the duration (45m, 1h30m) and the time (3pm); a refused duration or time writes nothing (design 02-tasks)", async () => {
    const { store, cli, rows } = await setup();
    await cli("add", "call", "the", "bank", "at", "3pm");
    expect(await store.getTask("tk_id1")).toMatchObject({ title: "call the bank", due_time: "15:00", duration_minutes: null });
    expect((await cli("edit", "tk_id1", "45m")).code).toBe(0);
    expect(await store.getTask("tk_id1")).toMatchObject({ title: "call the bank", due_time: "15:00", duration_minutes: 45 });
    expect((await cli("edit", "tk_id1", "at", "4:30pm", "1h30m")).code).toBe(0);
    expect(await store.getTask("tk_id1")).toMatchObject({ title: "call the bank", due_time: "16:30", duration_minutes: 90 });
    const before = await rows();
    expect(parseLocalCliArgs("task", ["edit", "tk_id1", "0m"])).toMatchObject({ error: expect.stringContaining("a duration must be 1 to 1440 minutes") });
    expect(parseLocalCliArgs("task", ["edit", "tk_id1", "13pm"])).toMatchObject({ error: expect.stringContaining("not a time: 13pm") });
    expect(await rows()).toEqual(before);
  });

  it("chat `task edit <task_id> <words>` does the same", async () => {
    const { store, cli, chat } = await setup();
    await cli("add", "pay", "rent");
    expect((await chat("task edit tk_id1 !3 #home")).code).toBe(0);
    expect(await store.getTask("tk_id1")).toMatchObject({ title: "pay rent", priority: 3, list: "home" });
  });
});

describe("factory task delete", () => {
  it("removes the row; a second delete says not found and writes nothing", async () => {
    const { cli, rows } = await setup();
    await cli("add", "one");
    await cli("add", "two");
    expect(await cli("delete", "tk_id1")).toEqual({ code: 0, lines: ["deleted tk_id1"] });
    expect((await rows()).map((r) => r.id)).toEqual(["tk_id2"]);
    const before = await rows();
    expect(await cli("delete", "tk_id1")).toEqual({ code: 1, lines: ["no task tk_id1"] });
    expect(await rows()).toEqual(before);
  });

  it("is refused while the task has open sub-tasks, naming them, with nothing written", async () => {
    const { cli, rows } = await setup();
    await cli("add", "move");
    await cli("sub", "tk_id1", "pack");
    await cli("sub", "tk_id1", "label", "boxes");
    await cli("done", "tk_id2");
    const before = await rows();
    expect(await cli("delete", "tk_id1")).toEqual({ code: 1, lines: ["tk_id1 has open sub-tasks: tk_id3; complete or delete them first"] });
    expect(await rows()).toEqual(before);
  });

  it("with only done sub-tasks: removes the task and detaches them as plain tasks", async () => {
    const { store, cli, rows } = await setup();
    await cli("add", "move");
    await cli("add", "other");
    await cli("sub", "tk_id1", "pack");
    await cli("done", "tk_id3");
    const before = await rows();
    expect(await cli("delete", "tk_id1")).toEqual({ code: 0, lines: ["deleted tk_id1", "detached done sub-tasks: tk_id3"] });
    expect(await store.getTask("tk_id3")).toMatchObject({ parent_task_id: null, done_at: expect.any(String) });
    expect(await rows()).toEqual(before.filter((r) => r.id !== "tk_id1").map((r) => (r.id === "tk_id3" ? { ...r, parent_task_id: null } : r)));
  });

  it("chat `task delete <task_id>` does the same", async () => {
    const { store, cli, chat } = await setup();
    await cli("add", "one");
    expect(await chat("task delete tk_id1")).toEqual({ code: 0, lines: ["deleted tk_id1"] });
    expect(await store.getTask("tk_id1")).toBeNull();
  });
});

describe("factory task sub", () => {
  it("adds a task whose parent_task_id is the parent; parent_id keeps its recurrence meaning", async () => {
    const { store, cli } = await setup();
    await cli("add", "move");
    const r = await cli("sub", "tk_id1", "pack", "!1");
    expect(r).toEqual({ code: 0, lines: ["tk_id2\tpack\t-\t!1\t-\t-\tsub of tk_id1"] });
    expect(await store.getTask("tk_id2")).toMatchObject({ title: "pack", priority: 1, parent_task_id: "tk_id1", parent_id: null, created_by: USER });
  });

  it("a sub-task of a sub-task, or of an unknown task, is refused with nothing written", async () => {
    const { cli, rows } = await setup();
    await cli("add", "move");
    await cli("sub", "tk_id1", "pack");
    const before = await rows();
    expect(await cli("sub", "tk_id2", "tape")).toEqual({ code: 1, lines: ["tk_id2 is a sub-task: a sub-task cannot have sub-tasks"] });
    expect(await cli("sub", "tk_nope", "tape")).toEqual({ code: 1, lines: ["no task tk_nope"] });
    expect(parseLocalCliArgs("task", ["sub", "tk_id1", "!1"])).toMatchObject({ error: expect.stringContaining("task sub: the title is empty") });
    expect(await rows()).toEqual(before);
  });

  it("chat `task sub <parent_id> <words>` does the same", async () => {
    const { store, cli, chat } = await setup();
    await cli("add", "move");
    expect((await chat("task sub tk_id1 pack")).code).toBe(0);
    expect(await store.getTask("tk_id2")).toMatchObject({ title: "pack", parent_task_id: "tk_id1" });
  });

  it("completing a parent leaves its sub-tasks open; completing a sub-task leaves its parent open", async () => {
    const { store, cli } = await setup();
    await cli("add", "move");
    await cli("sub", "tk_id1", "pack");
    await cli("sub", "tk_id1", "tape");
    await cli("done", "tk_id1");
    await cli("done", "tk_id2");
    expect((await store.listTasks(10)).map((t) => t.id)).toEqual(["tk_id3"]);
    await cli("add", "clean");
    await cli("sub", "tk_id4", "floor");
    await cli("done", "tk_id5");
    expect((await store.getTask("tk_id4"))!.done_at).toBeNull();
  });
});

describe("factory task list with sub-tasks", () => {
  it("shows each sub-task's parent ID on its line", async () => {
    const { cli } = await setup();
    await cli("add", "move");
    await cli("sub", "tk_id1", "pack");
    expect((await cli("list")).lines).toEqual(["no local work items", "", "Tasks", "tk_id1\tmove\t-\t-\t-\t-", "tk_id2\tpack\t-\t-\t-\t-\tsub of tk_id1"]);
  });
});

describe("tasks linked to a work item", () => {
  it("editing or deleting one leaves the work item as it is; a later merge completes no deleted task", async () => {
    const { store, cli, rows } = await setup();
    const { item } = await store.createWorkItem(issue(1), system);
    await cli("add", "fix", "the", "bug");
    await cli("add", "write", "notes");
    await store.linkTask("tk_id1", item.id as WorkItemId);
    await store.linkTask("tk_id2", item.id as WorkItemId);
    const stored = await store.getWorkItem(item.id);
    await cli("edit", "tk_id2", "write", "release", "notes", "!1");
    await cli("delete", "tk_id1");
    expect(await store.getWorkItem(item.id)).toEqual(stored);
    const before = await rows();
    const closed = await store.closeLinkedTasks(item.id);
    expect(closed.map((t) => t.id)).toEqual(["tk_id2"]);
    expect(await store.getTask("tk_id1")).toBeNull();
    expect((await rows()).map((r) => r.id)).toEqual(before.map((r) => r.id));
  });
});

describe("the command table", () => {
  it("has task edit, delete and sub for anyone who may submit work, each with a chat form", () => {
    for (const name of ["task edit", "task delete", "task sub"]) {
      expect(COMMAND_TABLE.find((c) => c.name === name), name).toMatchObject({ who: "submit_work", group: "task", chat: expect.stringMatching(/^task /) });
    }
  });
});
