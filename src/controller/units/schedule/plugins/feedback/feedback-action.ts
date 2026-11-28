// The feedback action (design 08-schedules): each fired occurrence runs one read-only agent (Read, Glob, Grep) on
// the schedule's `prompt` (with the schedule's grants, if the owner gave any: a browser on its sandbox URL, a notes
// folder, a named repo, a read-only sqlite3; the routed action hands them out through ScheduleGrantBroker), asking for tasks that each cite evidence in the code. It files at most FEEDBACK_MAX_TASKS
// (3, the owner's value; a lower `max_tasks` setting lowers it) evidence-backed tasks as local work items, in the
// agent's order, and records the rest on the run: over the cap, without evidence or a title, or withheld by the leak scanner.
// The items' source IDs come from the schedule, the slot and the task's place, so a second run files none twice
// and never more than the cap for one occurrence. Without a browser grant there is no browse tool.

import type { GrantHandOut, ScheduleActionRoute } from "../ports.js";

export const FEEDBACK_MAX_TASKS = 3;

/** The answer the agent must give. */
export const FEEDBACK_SCHEMA = {
  type: "object",
  required: ["tasks"],
  properties: {
    tasks: {
      type: "array",
      items: {
        type: "object",
        required: ["title", "body", "evidence"],
        properties: {
          title: { type: "string" },
          body: { type: "string" },
          evidence: { type: "array", items: { type: "object", required: ["path", "quote"], properties: { path: { type: "string" }, line: { type: "integer" }, quote: { type: "string" } } } },
        },
      },
    },
  },
} as const;

interface Evidence { path: string; line?: number; quote: string }
interface Task { title: string; body: string; evidence: Evidence[] }

/** Why a task was not filed. */
export type Unfiled = "over_cap" | "no_evidence" | "no_title" | "withheld";

const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");

/** The agent's tasks, each with only its evidence that names a path and quotes it. */
export function feedbackTasks(output: unknown): Task[] {
  const tasks = (output as { tasks?: unknown } | null)?.tasks;
  if (!Array.isArray(tasks)) return [];
  return tasks.map((t: Record<string, unknown>) => ({
    title: str(t?.title), body: str(t?.body),
    evidence: (Array.isArray(t?.evidence) ? t.evidence : []).map((e: Record<string, unknown>) => ({
      path: str(e?.path), quote: str(e?.quote), ...(Number.isSafeInteger(e?.line) ? { line: e.line as number } : {}),
    })).filter((e: Evidence) => e.path !== "" && e.quote !== ""),
  }));
}

/** The cap for `settings`: FEEDBACK_MAX_TASKS, or a lower whole `max_tasks` of at least 1. */
export function feedbackCap(settings: Readonly<Record<string, unknown>>): number {
  const n = settings.max_tasks;
  return typeof n === "number" && Number.isSafeInteger(n) && n >= 1 ? Math.min(n, FEEDBACK_MAX_TASKS) : FEEDBACK_MAX_TASKS;
}

function prompt(ask: string, cap: number, granted: readonly string[]): string {
  return [
    ask, "",
    `Answer with tasks, at most ${cap} of them, most important first. Each task needs a title, a body and evidence: one or more`,
    "entries, each a repo-relative path you read, the line if you know it, and a short quote of the code it is about.",
    "A task without evidence is not filed. You can read code: Read, Glob and Grep.",
    ...(granted.length === 0 ? ["You can only read code."] : ["The owner also granted, and nothing else:", ...granted.map((g) => `- ${g}`)]),
  ].join("\n");
}

const evidenceLines = (t: Task) => t.evidence.map((e) => `- \`${e.path}${e.line === undefined ? "" : `:${e.line}`}\`: ${e.quote}`);

/** The feedback route, its schedule's grants handed out by `handOut` (compose binds ScheduleGrantBroker) before the agent runs. */
export const feedbackActionWith = (handOut: GrantHandOut): ScheduleActionRoute => async (schedule, occurrence_at, ports) => {
  const ask = str(schedule.settings.prompt);
  if (ask === "") throw new Error(`schedule ${schedule.id} has no prompt`);
  const cap = feedbackCap(schedule.settings);
  const run = await handOut(schedule);
  const answer = await ports.ask({ prompt: prompt(ask, cap, run?.granted ?? []), output_schema: FEEDBACK_SCHEMA, ...(run ? { run } : {}) });
  if (answer.status !== "completed") {
    await ports.record({ output: `feedback run ${answer.status}${answer.error ? `: ${answer.error}` : ""}`, tokens: answer.tokens, cost_usd: answer.cost_usd });
    throw new Error(`feedback run ${answer.status}`);
  }
  const filed: { id: string; title: string; created: boolean }[] = [];
  const unfiled: { title: string; reason: Unfiled }[] = [];
  for (const t of feedbackTasks(answer.output)) {
    if (t.evidence.length === 0) unfiled.push({ title: t.title, reason: "no_evidence" });
    else if (t.title === "") unfiled.push({ title: t.title, reason: "no_title" });
    else if (filed.length >= cap) unfiled.push({ title: t.title, reason: "over_cap" });
    else {
      const body = [t.body, "", "Evidence:", ...evidenceLines(t), "", `Filed by schedule \`${schedule.id}\` for its occurrence due ${occurrence_at}.`].join("\n");
      const item = await ports.fileItem({ source_id: `${ports.occurrence_id}-${filed.length + 1}`, title: t.title, body });
      if (item) filed.push({ id: item.id, title: t.title, created: item.created });
      else unfiled.push({ title: t.title, reason: "withheld" });
    }
  }
  await ports.record({ output: JSON.stringify({ filed, unfiled }), tokens: answer.tokens, cost_usd: answer.cost_usd });
};

/** The feedback route with no grants: the read-only tools only. */
export const feedbackAction: ScheduleActionRoute = feedbackActionWith(async () => null);
