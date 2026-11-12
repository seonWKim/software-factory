// Task reminders (design 02-tasks, schedule a task). A pure step: `load` reads the tasks whose reminder is due at the
// tick's time (the injected Clock's): open, timed, not yet reminded, their time come at most the 5-minute poll window
// ago; `decide` makes one reminder per task, keyed on the task and its time. Through the notice path (owner answer 1),
// each reminder first gets one outbox intent per `notify_channels` adapter that has `notifyOwner` (the notifications
// unit's notifiers), keyed so a second pass or replica stores it once; then the kernel commits, as one transaction,
// the conditional update of the task's sent-marker (reminded_at) and its desktop notice, so a second pass or another
// replica finds no task to remind.

import { NOTIFY_REF } from "../../../core/notifications.js";
import type { NewAction } from "../../../outbound/index.js";
import type { Tick } from "../../../shared/ticks/tick-generator.js";
import type { ControllerReader, ControllerWrite } from "../kernel.js";
import type { ControllerDecision, Ctx } from "../context.js";
import { controllerUnit } from "../context.js";
import { type Notifier, notifiers } from "../notifications/notifiers.js";

type Task = Awaited<ReturnType<ControllerReader["listDueReminders"]>>[number];

interface Loaded {
  readonly tasks: readonly Task[];
  readonly channels: readonly string[];
}

export class TaskRemindersUnit {
  /** The `notify_channels` names that reach an adapter with notifyOwner, with its type. */
  private readonly notifiers: (names: readonly string[]) => Notifier[];

  constructor(private readonly c: Ctx) {
    this.notifiers = notifiers(c.k);
  }

  async load(r: ControllerReader, tick: Tick): Promise<Loaded> {
    return { tasks: await r.listDueReminders(new Date(tick.now)), channels: this.c.k.live.values().notify_channels };
  }

  decide(l: Loaded, tick: Tick): ControllerDecision {
    const created_at = new Date(tick.now).toISOString() as Extract<ControllerWrite, { kind: "task_reminder" }>["notice"]["created_at"];
    const to = this.notifiers(l.channels);
    const writes: ControllerWrite[] = [];
    for (const t of l.tasks) {
      if (t.due_date === null || t.due_time === null) continue;
      const at = { due_date: t.due_date, due_time: t.due_time };
            for (const n of to) writes.push({ kind: "intent", action: intent(t.id, t.title, at, n) });
      // The desktop notice names the task by ID only; its kind tells the shell it is a task's reminder.
      const notice = { work_item_id: t.id, wait_key: waitKey(at), kind: "task" as const, created_at, held_until: null, count: 1 };
      writes.push({ kind: "task_reminder", id: t.id, at, notice });
    }
    return { writes };
  }
}

/** A reminder's key: the task's date and time, so a moved task is reminded again at its new time. */
const waitKey = (at: { due_date: string; due_time: string }) => `task:${at.due_date}T${at.due_time}`;

/**
 * One reminder's intent for one channel, keyed on (task, its time, channel). A task is no work item: no item ID, so
 * the line links no item page and a reply under it acts on no item. It reads as a needs-you line with the task's title.
 */
function intent(id: string, title: string, at: { due_date: string; due_time: string }, to: Notifier): NewAction {
  return {
    action: "notify",
    target: { type: to.type, id: NOTIFY_REF, link: "" },
    work_item_id: null,
    key: `notify:${id}:${waitKey(at)}:${to.channel}`,
    args: {
      kind: "needs_you", work_item_id: null, title, reason: `task due at ${at.due_time}`,
      close_reason: null, source_type: null, thread_url: null, count: 1,
    },
  };
}

declare module "../../router/unit.js" {
  interface UnitOperations {
    "task-reminders": TaskRemindersUnit;
  }
}

export default controllerUnit({
  name: "task-reminders",
  create: (c: Ctx) => new TaskRemindersUnit(c),
  steps: [
    {
      name: "task reminders", every: "poll", order: 82,
      load: (u, r, tick) => u.load(r, tick),
      decide: (u, loaded: Loaded, tick) => u.decide(loaded, tick),
    },
  ],
});
