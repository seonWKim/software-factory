// Task reminders (design 02-tasks, schedule a task). A pure step: `load` reads the tasks whose reminder is due at the
// tick's time (the injected Clock's): open, timed, not yet reminded, their time come at most a day ago; `decide` makes
// one reminder per task, keyed on the task and its time. The kernel commits each as one transaction: the conditional
// update of the task's sent-marker (reminded_at), then its notice, so a second pass, another replica, or a task done,
// deleted or moved meanwhile sends nothing. The notice reaches only the desktop app's notices (GET /api/v1/notices):
// no outbox intent is written, so nothing goes to Slack or any other target (owner answer 3: desktop app only).

import type { Tick } from "../../../shared/ticks/tick-generator.js";
import type { ControllerReader, ControllerWrite } from "../kernel.js";
import type { ControllerDecision, Ctx } from "../context.js";
import { controllerUnit } from "../context.js";

type Task = Awaited<ReturnType<ControllerReader["listDueReminders"]>>[number];

export class TaskRemindersUnit {
  load(r: ControllerReader, tick: Tick): Promise<Task[]> {
    return r.listDueReminders(new Date(tick.now));
  }

  decide(tasks: readonly Task[], tick: Tick): ControllerDecision {
    const created_at = new Date(tick.now).toISOString() as Extract<ControllerWrite, { kind: "task_reminder" }>["notice"]["created_at"];
    const writes: ControllerWrite[] = [];
    for (const t of tasks) {
      if (t.due_date === null || t.due_time === null) continue;
      const at = { due_date: t.due_date, due_time: t.due_time };
      // The notice names the task by ID only; its kind tells the shell it is a task's reminder.
      const notice = { work_item_id: t.id, wait_key: `task:${t.due_date}T${t.due_time}`, kind: "task" as const, created_at, held_until: null, count: 1 };
      writes.push({ kind: "task_reminder", id: t.id, at, notice });
    }
    return { writes };
  }
}

declare module "../../router/unit.js" {
  interface UnitOperations {
    "task-reminders": TaskRemindersUnit;
  }
}

export default controllerUnit({
  name: "task-reminders",
  create: (_c: Ctx) => new TaskRemindersUnit(),
  steps: [
    {
      name: "task reminders", every: "poll", order: 82,
      load: (u, r, tick) => u.load(r, tick),
      decide: (u, tasks: Task[], tick) => u.decide(tasks, tick),
    },
  ],
});
