import { describe, expect, it } from "vitest";
import { Router, type ControllerUnits } from "../src/controller/index.js";
import { Kernel } from "../src/controller/units/kernel.js";
import notificationsUnit from "../src/controller/units/notifications/notifications.unit.js";
import taskRemindersUnit from "../src/controller/units/task-reminders/task-reminders.unit.js";
import type { ControllerDeps } from "../src/core/controller-deps.js";
import { NOTICE_KINDS } from "../src/core/notifications.js";
import type { NewTask } from "../src/core/tasks.js";
import type { UserId } from "../src/core/types.js";
import { FakeClock } from "../src/impl/clock/fake-clock.js";
import type { SqlFactoryStore } from "../src/impl/store/sql/sql-factory-store.js";
import type { SourceAdapter, SourceNotice } from "../src/interfaces/source-adapter.js";
import { recordAction } from "../src/outbound/index.js";
import { tickAt } from "../src/shared/ticks/tick-generator.js";
import { type ApiDeps, respond } from "../src/ui/server.js";
import { cleanScanner, config, silent } from "./helpers/fakes.js";
import { newStore } from "./helpers/store.js";

// Task reminders (design 02-tasks, schedule a task): the task-reminders unit sends one reminder at a task's time, by
// the injected Clock, as a desktop notice only (owner answer 3), once, through the conditional write of reminded_at.

const USER = "local:dev@example.com" as UserId;
/** A local-time instant on 2026-11-13, so the tests hold in any time zone. */
const local = (h: number, m = 0, day = 13) => new Date(2026, 10, day, h, m);

const task = (over: Partial<NewTask> = {}): NewTask => ({
  id: "tk_1", title: "call the bank", list: null, priority: null, due: { date: "2026-11-13" }, due_time: "15:00", recurrence: null, created_by: USER, ...over,
});

/** A Slack-like adapter with notifyOwner, recording each call. */
function slack(): SourceAdapter & { calls: SourceNotice[][] } {
  const calls: SourceNotice[][] = [];
  return {
    type: "slack", intake: "poll", calls, poll: async () => ({ events: [], next_cursor: "" }), postComment: async () => ({ url: null }),
    markSeen: async () => {}, setStatus: async () => {}, closeIssue: async () => {}, notifyOwner: async (n: readonly SourceNotice[]) => void calls.push([...n]),
  };
}

/** A kernel and router over `store` with the reminders and notifications units, Slack listed in notify_channels. */
function controller(store: SqlFactoryStore, clock: FakeClock, sources: SourceAdapter[] = []) {
  const values = { notice_kinds: [...NOTICE_KINDS], quiet_hours: "", notify_channels: sources.map((s) => s.type) };
  const deps = { store, clock, config, scanner: cleanScanner, log: silent, auth: {}, settings: { values: () => values }, sources } as unknown as ControllerDeps;
  const none = async () => { throw new Error("no message is written"); };
  const record = (a: Parameters<typeof recordAction>[1], now: string) => recordAction(store.db, a, now);
  const k = new Kernel(deps, { record, announce: none, emit: none, actions: none, byKey: none }, { beforeMerge: none });
  const units = [taskRemindersUnit, notificationsUnit] as unknown as ControllerUnits;
  const r = new Router(units, k, {
    kinds: [], messages: [], guard: async (_w, fn) => fn(), reader: k.reader, commit: (d) => k.commit(d), now: () => tickAt("event", 1, clock.now().getTime()),
  });
  return {
    /** One poll, at the FakeClock's time: the reminders step, then the notifications step. */
    poll: async () => {
      const tick = tickAt("poll", 1, clock.now().getTime());
      await r.step("task reminders", tick);
      await r.step("notifications", tick);
    },
  };
}

const notices = (store: SqlFactoryStore) => store.db.all("SELECT work_item_id, wait_key, kind, held_until, count FROM controller_notices ORDER BY created_at, wait_key");
const reminded = async (store: SqlFactoryStore, id = "tk_1") => (await store.getTask(id))?.reminded_at ?? null;

async function setup(at = local(14, 59)) {
  const { store, clock } = await newStore(new FakeClock(at));
  return { store: store as SqlFactoryStore, clock };
}

describe("a reminder at the task's time (FakeClock)", () => {
  it("fires at the task time, not before, keyed on the task and its time", async () => {
    const { store, clock } = await setup();
    await store.addTask(task());
    const c = controller(store, clock);
    await c.poll();
    expect(await notices(store)).toEqual([]);
    expect(await reminded(store)).toBeNull();
    clock.advance(60_000);
    await c.poll();
    expect(await notices(store)).toEqual([{ work_item_id: "tk_1", wait_key: "task:2026-11-13T15:00", kind: "task", held_until: null, count: 1 }]);
    expect(await reminded(store)).toBe(local(15).toISOString());
  });

  it("fires once: a second poll, or a second controller, sends nothing, because reminded_at is written conditionally", async () => {
    const { store, clock } = await setup(local(15, 5));
    await store.addTask(task());
    await controller(store, clock).poll();
    const first = await notices(store);
    clock.advance(60_000);
    await controller(store, clock).poll();
    await controller(store, clock).poll();
    expect(await notices(store)).toEqual(first);
    expect(await reminded(store)).toBe(local(15, 5).toISOString());
    // The write itself is conditional: replayed, it changes nothing and stores no second notice.
    const at = { due_date: "2026-11-13", due_time: "15:00" };
    const notice = { work_item_id: "tk_1", wait_key: "task:x", kind: "task" as const, created_at: local(15, 7).toISOString() as never, held_until: null, count: 1 };
    expect(await store.remindTask("tk_1", at, notice)).toBe(false);
    expect(await notices(store)).toEqual(first);
  });

  it("a moved task is reminded again at its new time; an untimed task and one past the lookback never are", async () => {
    const { store, clock } = await setup(local(15, 1));
    await store.addTask(task());
    await store.addTask(task({ id: "tk_untimed", due_time: null }));
    await store.addTask(task({ id: "tk_old", due: { date: "2026-11-11" }, due_time: "09:00" }));
    const c = controller(store, clock);
    await c.poll();
    expect((await notices(store)).map((n) => n.wait_key)).toEqual(["task:2026-11-13T15:00"]);
    expect(await store.updateTask("tk_1", { due_time: "16:00" })).toMatchObject({ ok: true, task: { reminded_at: null } });
    await c.poll();
    expect((await notices(store)).length).toBe(1);
    clock.advance(60 * 60_000);
    await c.poll();
    expect((await notices(store)).map((n) => n.wait_key)).toEqual(["task:2026-11-13T15:00", "task:2026-11-13T16:00"]);
  });

  it("a done or deleted task never sends a reminder", async () => {
    const { store, clock } = await setup();
    await store.addTask(task({ id: "tk_done" }));
    await store.addTask(task({ id: "tk_gone" }));
    await store.completeTask("tk_done");
    await store.deleteTask("tk_gone");
    clock.advance(10 * 60_000);
    await controller(store, clock).poll();
    expect(await notices(store)).toEqual([]);
  });

  it("a task done between the read and the write sends nothing: the conditional write finds it done", async () => {
    const { store } = await setup(local(15, 1));
    await store.addTask(task());
    const [due] = await store.listDueReminders(local(15, 1));
    expect(due?.id).toBe("tk_1");
    await store.completeTask("tk_1");
    const notice = { work_item_id: "tk_1", wait_key: "task:2026-11-13T15:00", kind: "task" as const, created_at: local(15, 1).toISOString() as never, held_until: null, count: 1 };
    expect(await store.remindTask("tk_1", { due_date: "2026-11-13", due_time: "15:00" }, notice)).toBe(false);
    expect(await notices(store)).toEqual([]);
  });

  it("a recurring task's next occurrence gets its own reminder", async () => {
    const { store, clock } = await setup(local(15, 1));
    await store.addTask(task({ recurrence: "day" }));
    await controller(store, clock).poll();
    const r = await store.completeTask("tk_1");
    expect(r.ok && r.next).toMatchObject({ due_date: "2026-11-14", due_time: "15:00", reminded_at: null });
  });
});

describe("a reminder reaches only the desktop app's notices (owner answer 3)", () => {
  it("is listed by GET /api/v1/notices, and nothing goes to Slack or the outbox, also with Slack in notify_channels", async () => {
    const { store, clock } = await setup(local(15));
    await store.addTask(task());
    const s = slack();
    await controller(store, clock, [s]).poll();
    const r = await respond({ store, clock } as unknown as ApiDeps, { method: "GET", url: "/api/v1/notices", host: "127.0.0.1" });
    const body = JSON.parse(r.body) as { notices: { work_item_id: string; kind: string }[] };
    expect(body.notices.map((n) => [n.work_item_id, n.kind])).toEqual([["tk_1", "task"]]);
    expect(await store.db.all("SELECT seq FROM outbound_actions")).toEqual([]);
    expect(s.calls).toEqual([]);
  });
});
