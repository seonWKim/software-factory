// The chat's daily eval run (design 04-chat-agent). Each poll, when `chat_eval.schedule` is "daily", the unit claims
// the current UTC day through the run compose built (src/core/chat-eval.ts: a conditional store cursor advance, so
// replicas on one store run the day once) and starts the run against the code this controller runs, main. The run
// is not awaited: its model calls never hold up the controller's other steps. The result is logged with the pass
// bar. A run that ends below its bar (ok false) or throws stores one Needs-you alert for the UTC day, its detail
// scanned as UI text first, through the kernel's `alert` write. With the key absent compose builds no run, and the
// step returns before any call. The unit reaches no store of its own and imports no core module: the run, and the
// alarm builders it logs and alerts with (failuresOf, chatEvalFailedAlert in src/core/alarms.ts), come in through the
// controller's deps.

import type { Ctx } from "../context.js";
import { controllerUnit } from "../context.js";
import type { ControllerWrite } from "../kernel.js";

type Turn = { failure: string | null; detail?: string };
/** How a failed run ended: its counts and turns (ok false), or the error it threw. */
type Failure = { passed: number; total: number; bar: number; results?: readonly Turn[] } | { error: string };

/** The run as the unit uses it (src/core/chat-eval.ts ChatEvalSchedule). */
export interface ChatEvalPort {
  claim(day: string): Promise<boolean>;
  run(): Promise<{ passed: number; total: number; bar: number; ok: boolean; results?: readonly Turn[] }>;
  /** The failed turns' reasons counted, for the log line (failuresOf). */
  failures(results: readonly Turn[]): { failures?: string; failure_detail?: string };
  /** The UTC day's Needs-you alert for a failed run, its detail not yet scanned (chatEvalFailedAlert). */
  failedAlert(day: string, f: Failure): { alert: Extract<ControllerWrite, { kind: "alert" }>["alert"] & { detail: string }; dedupe_ms: number };
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
      async (r) => {
        k.d.log.info("chat eval run finished", { day, passed: r.passed, total: r.total, bar: r.bar, ok: r.ok, ...port.failures(r.results ?? []) });
        if (!r.ok) await this.alert(port, day, r);
      },
      async (err: unknown) => {
        const error = err instanceof Error ? err.message : String(err);
        k.d.log.warn("chat eval run failed", { day, error });
        await this.alert(port, day, { error });
      },
    ).catch((err: unknown) => {
      k.d.log.warn("chat eval alert not stored", { day, error: err instanceof Error ? err.message : String(err) });
    }).finally(() => {
      this.running = null;
    });
  }

  /** Stores the day's failed-check alert, its detail scanned as UI text (null when flagged); the store's dedupe keeps one per day. */
  private async alert(port: ChatEvalPort, day: string, f: Failure): Promise<void> {
    const { alert, dedupe_ms } = port.failedAlert(day, f);
    const clean = (await this.c.k.reader.scan("ui", alert.detail)).clean;
    await this.c.k.commit({ writes: [{ kind: "alert", alert: { ...alert, detail: clean ? alert.detail : null }, dedupe_ms }] });
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
