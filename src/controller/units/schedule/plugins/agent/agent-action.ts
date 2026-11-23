// The agent action (design 08-schedules): each fired occurrence runs the schedule's `prompt` once, through the
// AgentRunner with the read-only tools Read, Glob and Grep, and stores the agent's answer and what it cost on the
// occurrence's run row. A failed call is stored too, then thrown, so the scheduler logs it.

import type { ScheduleActionRoute } from "../ports.js";

export const agentAction: ScheduleActionRoute = async (schedule, _occurrence_at, ports) => {
  const prompt = typeof schedule.settings.prompt === "string" ? schedule.settings.prompt.trim() : "";
  if (prompt === "") throw new Error(`schedule ${schedule.id} has no prompt`);
  const answer = await ports.ask({ prompt });
  const ok = answer.status === "completed";
  await ports.record({ output: ok ? answer.text : `agent run ${answer.status}${answer.error ? `: ${answer.error}` : ""}`, tokens: answer.tokens, cost_usd: answer.cost_usd });
  if (!ok) throw new Error(`agent run ${answer.status}`);
};
