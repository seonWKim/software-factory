// The chat's daily eval run (design 04-chat-agent). Each poll, when `chat_eval.schedule` is "daily", the unit claims
// the current UTC day through the run compose built (src/core/chat-eval.ts: a conditional store cursor advance, so
// replicas on one store run the day once) and starts the run against the code this controller runs, main. The run
// is not awaited: its model calls never hold up the controller's other steps. The result is logged with the pass
// bar. With the key absent compose builds no run, and the step returns before any call. The unit reaches no store
// of its own and imports no core module: the run comes in through the controller's deps.

import type { Ctx } from "../context.js";
import { controllerUnit } from "../context.js";

/** The run as the unit uses it (src/core/chat-eval.ts ChatEvalSchedule). */
export interface ChatEvalPort {
  claim(day: string): Promise<boolean>;
  run(): Promise<{ passed: number; total: number; bar: number; ok: boolean }>;
}

declare module "../../../core/controller-deps.js" {
  interface ControllerDeps {
    /** The daily chat eval run (`chat_eval.schedule` "daily"). Absent: no scheduled run. */
    chat_eval?: ChatEvalPort;
  }
}

export class ChatEvalUnit {
  constructor(private readonly c: Ctx) {}

  /** The UTC day this process claimed or saw claimed: a cache only; the store cursor is the shared mark. */
  day: string | null = null;
  /** The run this process started and that has not ended yet. */
  running: Promise<void> | null = null;

  /** Starts today's run unless this process or another replica already took the day. Off: nothing. */
  async evalStep(): Promise<void> {
    const k = this.c.k;
    const port = k.d.chat_eval;
    if (!port || this.running) return;
    const day = new Date(k.nowMs()).toISOString().slice(0, 10); // the UTC day
    if (this.day === day) return;
    const claimed = await port.claim(day);
    this.day = day;
    if (!claimed) return;
    k.d.log.info("chat eval run started", { day });
    this.running = port.run().then(
      (r) => k.d.log.info("chat eval run finished", { day, passed: r.passed, total: r.total, bar: r.bar, ok: r.ok }),
      (err: unknown) => k.d.log.warn("chat eval run failed", { day, error: err instanceof Error ? err.message : String(err) }),
    ).finally(() => {
      this.running = null;
    });
  }
}

declare module "../../router/unit.js" {
  interface UnitOperations {
    "chat-eval": ChatEvalUnit;
  }
}

export default controllerUnit({
  name: "chat-eval",
  create: (c: Ctx) => new ChatEvalUnit(c),
  steps: [{ name: "chat eval", every: "poll", order: 90, run: (u) => u.evalStep() }],
});
