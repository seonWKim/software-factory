// Routines (src/core/routines.ts). A routine is a Check a page schedule row: the schedule unit's claim pass runs it
// (runDueCheckPages, planned by planRoutine: fire, skip after a `/reject`, or a hold on a local item that waits for
// `/approve` or `/reject` at the daily cap), so this unit has no step. Its operations: a finished routine run's
// findings, egress-scanned (G5), become pending suggestions and its model calls go on its slot's schedule run row
// (run-results calls it); `/approve` and `/reject` on a hold item (commands calls it); and the owner's answer to a
// suggestion, where an accept files it as an item (`fileIssue`). Every read goes through the kernel's reader, every
// write through a commit.

import type { ControllerWrite, RoutineSuggestion } from "../kernel.js";
import { ROUTINE_CAP, ROUTINE_CAP_APPROVED, ROUTINE_CAP_REJECTED, SNOOZE_MS } from "../kernel.js";
import type { Ctx } from "../context.js";
import { controllerUnit } from "../context.js";
import type { Actor, Decision, Refusal, Run, WorkItem } from "../support.js";

/** Why a command other than `/approve` or `/reject` does nothing on a hold item. */
const HOLD_COMMANDS = "a routine's held run takes `/approve` (raise today's cap by the last run's cost and run it) or `/reject <reason>` (skip it)";

export class RoutinesUnit {
  constructor(private readonly c: Ctx) {}

  /**
   * A finished routine run's findings as pending suggestions (duplicates skipped and counted by the store). Each
   * finding passes the egress scan (G5) first: a flagged one is withheld, never stored. A run over its routine's
   * per-run cap pauses the routine. Its model calls go on its slot's schedule run row, for the token cap. Safe to run
   * twice: the store records a run's findings once, and a row that holds a run's model calls takes no more.
   */
  async recordFindings(run: Run): Promise<void> {
    const r = this.c.k.reader, found = await r.routineRun(run);
    if (!found) return;
    const clean: string[] = [];
    for (const text of found.findings) if ((await r.scan("comment", text)).clean) clean.push(text);
    const fields = { routine_id: found.routine.id, run_id: run.id };
    const writes: ControllerWrite[] = clean.length > 0 ? [{ kind: "routine_findings", routine_id: found.routine.id, run_id: run.id, texts: clean }] : [];
    if (found.used) writes.push({ kind: "schedule_result", schedule_id: found.routine.id, occurrence_at: found.used.slot, result: { output: `routine run ${run.id}: ${found.findings.length} findings`, tokens: found.used.tokens, cost_usd: found.used.cost_usd } });
    if (clean.length < found.findings.length) writes.push({ kind: "log", level: "warn", msg: "routine findings withheld by the egress scan", fields: { ...fields, withheld: found.findings.length - clean.length } });
    if (found.over_run_cap && !found.routine.paused) {
      const read = { next_due_at: found.routine.next_due_at, last_run_at: found.routine.last_run_at };
      writes.push({ kind: "routine_update", id: found.routine.id, read, patch: { paused: true } }, { kind: "log", level: "warn", msg: "routine paused: its run cost more than its per-run cap", fields });
    }
    await this.c.k.commit({ writes });
  }

  /** Whether `it` is a routine's run held at its daily cap, waiting for `/approve` or `/reject`. */
  holds(it: WorkItem): boolean {
    return it.stage !== "CLOSED" && it.blocked_reason === ROUTINE_CAP;
  }

  /**
   * `/approve` or `/reject` on a hold item. Approve first raises the routine's cap for today by its last run's cost
   * (once per hold item), then closes the item as completed; the next tick runs the held slot. Reject closes it as
   * rejected; the next tick skips the slot. Either way the cap holds: a later slot over it is held again.
   */
  async answerCap(kind: string, it: WorkItem, actor: Actor): Promise<Decision | Refusal> {
    if (kind !== "spec_approved" && kind !== "spec_rejected") return { refuse: HOLD_COMMANDS };
    const hold = await this.c.k.reader.routineHold(it);
    if (!hold) return { refuse: "the routine this item holds is gone" };
    const close = { stage: "CLOSED", blocked_on: "none", blocked_reason: null } as const;
    if (kind === "spec_rejected") return { patch: { ...close, close_reason: "rejected" }, actor, reason: ROUTINE_CAP_REJECTED, detail: { routine_id: hold.routine.id } };
    const day = new Date(this.c.k.nowMs()).toISOString().slice(0, 10);
    await this.c.k.commit({ writes: [{ kind: "routine_raise", id: hold.routine.id, raise: { hold_key: it.source.id, usd: hold.last_cost, day } }] });
    return { patch: { ...close, close_reason: "completed" }, actor, reason: ROUTINE_CAP_APPROVED, detail: { routine_id: hold.routine.id, raised_usd: hold.last_cost } };
  }

  /**
   * The owner's answer to a pending suggestion. Accept files it through the first source that can file, scanned
   * (G5) first, as the routine's owner; snooze hides it for 14 days; dismiss closes it. Null when applied, else why not.
   */
  async answerSuggestion(id: string, answer: "accept" | "snooze" | "dismiss", by: string): Promise<string | null> {
    const r = this.c.k.reader, s = await r.getRoutineSuggestion(id);
    if (!s || s.state !== "pending") return "the suggestion is not pending";
    if (answer === "snooze") return this.answer(s, { to: "snoozed", by, snooze_ms: SNOOZE_MS });
    if (answer === "dismiss") return this.answer(s, { to: "dismissed", by });
    const routine = await r.getRoutine(s.routine_id);
    if (!routine) return "the suggestion's routine is gone";
    if (this.c.k.filer() === null) return "no source can file an item";
    const title = `Routine "${routine.name}": ${s.text.split("\n")[0]!.slice(0, 120)}`;
    const body = [`Routine \`${routine.id}\` found this, and ${by} accepted it as a suggestion.`, "", s.text].join("\n");
    if (!(await r.scan("comment", `${title}\n${body}`)).clean) return "the suggestion's text was withheld by the egress scan";
    const issue = { project: this.c.k.project(), requester_id: routine.created_by, title, body, marker: `<!-- factory:routine-suggestion:${s.id} -->` };
    return this.answer(s, { to: "accepted", by, issue });
  }

  private async answer(s: RoutineSuggestion, decision: Extract<ControllerWrite, { kind: "suggestion_answer" }>["decision"]): Promise<null> {
    await this.c.k.commit({ writes: [{ kind: "suggestion_answer", id: s.id, decision }, { kind: "log", level: "info", msg: "routine suggestion answered", fields: { suggestion_id: s.id, answer: decision.to, by: decision.by } }] });
    return null;
  }
}

declare module "../../router/unit.js" {
  interface UnitOperations {
    "routines": RoutinesUnit;
  }
}

export default controllerUnit({
  name: "routines",
  create: (c: Ctx) => new RoutinesUnit(c),
});
