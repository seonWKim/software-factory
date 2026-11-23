// The `routed` ScheduleAction (design 08-schedules, docs/plugins/schedule-action.md): hands each fired occurrence
// to the route of its schedule's action kind (build, agent or feedback; src/controller/units/schedule/plugins/),
// bound to ports over the store, the agent runner and the egress scanner. An agent call gets exactly the read-only
// tools Read, Glob and Grep, in a fresh detached checkout, with deny_paths and no writable path; every answer is
// scanned before it is stored or filed (G5). The token cap is the claim pass's (src/core/schedule.ts): an
// occurrence over it never reaches this action.

import type { Contexts } from "../../plugin-api.js";
import type { ActionPorts, AgentAnswer } from "../../controller/units/schedule/plugins/ports.js";
import type { Schedule } from "../../core/schedule.js";
import type { ToolSpec } from "../../core/tools/types.js";
import { type RunId, type Timestamp, type WorkItemId, usageTokens } from "../../core/types.js";
import type { ScheduleAction } from "../../interfaces/schedule-action.js";

/** The only tools a schedule's agent gets, all of capability `read`. */
export const SCHEDULE_AGENT_TOOLS: readonly string[] = ["Read", "Glob", "Grep"];
/** The most characters of an answer kept on the run row. */
export const OUTPUT_CHARS = 20_000;

const SYSTEM_PROMPT = "You run a scheduled task on this repository. You can read files and search them (Read, Glob, Grep); you cannot change, run or send anything. Answer the task below.";

type Ctx = Contexts["schedule_action"];

/** `tools` narrowed to SCHEDULE_AGENT_TOOLS, in that order; throws, before any agent starts, when one is missing or not read-only. */
export function readOnlyTools(tools: readonly ToolSpec[]): ToolSpec[] {
  return SCHEDULE_AGENT_TOOLS.map((name) => {
    const tool = tools.find((t) => t.name === name);
    if (!tool || tool.capability !== "read") throw new Error(`the schedule agent needs the read-only tool ${name}`);
    return tool;
  });
}

export class RoutedScheduleAction implements ScheduleAction {
  constructor(private readonly c: Ctx) {}

  async run(schedule: Schedule, occurrence_at: Timestamp): Promise<void> {
    if (schedule.action === null) throw new Error(`schedule ${schedule.id} has no action`);
    const route = this.c.routes[schedule.action.kind];
    if (!route) throw new Error(`schedule ${schedule.id} has an unknown action kind ${schedule.action.kind}`);
    await route({ id: schedule.id, title: schedule.title, settings: schedule.action.settings }, occurrence_at, this.ports(schedule, occurrence_at));
  }

  private ports(schedule: Schedule, occurrence_at: Timestamp): ActionPorts {
    const { store, scanner, project } = this.c;
    return {
      fileItem: async ({ source_id, title, body }) => {
        if (!(await scanner.scan("comment", `${title}\n\n${body}`)).clean) return null;
        const source = { type: "local", id: source_id, link: `local:${source_id}` };
        const { item, created } = await store.createWorkItem(
          { source, title, requester_id: schedule.created_by, project, problem: `${title}\n\n${body}`.trim(), resources: [source.link] },
          { kind: "system", id: "system:schedule" },
          { enqueue: { kind: "triage", idempotency_key: `${source.type}:${source.id}:triage` } },
        );
        return { id: item.id, created };
      },
      ask: (i) => this.ask(schedule, occurrence_at, i),
      record: (r) => store.recordScheduleRunResult(schedule.id, occurrence_at, r),
    };
  }

  private async ask(schedule: Schedule, occurrence_at: Timestamp, i: Parameters<ActionPorts["ask"]>[0]): Promise<AgentAnswer> {
    const { sandbox, runner, scanner } = this.c;
    const cfg = this.c.loaded.config, tools = readOnlyTools(this.c.tools);
    const handle = await sandbox.create({ repo: cfg.repo.path, branch: null, base_ref: cfg.repo.base_branch });
    try {
      const result = await runner.run({
        run_id: `schedule_${schedule.id}_${occurrence_at.replace(/\W/g, "")}` as RunId,
        work_item_id: `schedule:${schedule.id}` as WorkItemId,
        role: "triage", // a read-only role that keeps no session
        sandbox: handle,
        system_prompt: SYSTEM_PROMPT,
        prompt: i.prompt,
        tools,
        tool_grants: [],
        lease_token: 0,
        env_allowlist: {},
        deny_paths: cfg.deny_paths,
        writable_paths: [],
        model_class: "standard",
        timeout_ms: cfg.run_timeout_ms,
        ...(i.output_schema ? { output_schema: i.output_schema as Record<string, unknown> } : {}),
        signal: new AbortController().signal,
      });
      const u = result.usage;
      const tokens = usageTokens({ ...u, cache_read_tokens: u.cache_read_tokens ?? 0, cache_write_tokens: u.cache_write_tokens ?? 0, model: u.model ?? null });
      const raw = (result.output ?? null) === null ? result.transcript : JSON.stringify(result.output);
      const scan = await scanner.scan("run_outcome", raw);
      const text = scan.clean ? raw.slice(0, OUTPUT_CHARS) : `(withheld: the leak scanner flagged the answer: ${scan.findings.map((f) => f.rule).join(", ")})`;
      return { status: result.status, output: scan.clean ? result.output : null, text, tokens, cost_usd: u.cost_usd, ...(result.error ? { error: result.error.slice(0, 500) } : {}) };
    } finally {
      await sandbox.destroy(handle);
    }
  }
}
