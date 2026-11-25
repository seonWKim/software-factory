// The `routed` ScheduleAction (design 08-schedules, docs/plugins/schedule-action.md): hands each fired occurrence
// to the route of its schedule's action kind (build, agent, feedback, improve or check_page;
// src/controller/units/schedule/plugins/), bound to ports over the store, the agent runner and the egress scanner. An agent call gets exactly the read-only
// tools Read, Glob and Grep, in a fresh detached checkout, with deny_paths and no writable path, unless the route
// passes the run its schedule's grants handed out (a feedback schedule's, by ScheduleGrantBroker in
// src/core/schedule-grants.ts, which compose binds): then that run's tools, broker tools, repo and writable paths.
// A run with a writable path gets its checkout as a read-only path, so a harness that allows writes in its workdir (claude-code) still lets
// Write and Edit reach only the writable paths. Every answer is scanned before it is stored or filed (G5). The token cap is the claim pass's (src/core/schedule.ts): an
// occurrence over it never reaches this action.

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import type { Contexts } from "../../plugin-api.js";
import type { ActionPorts, AgentAnswer } from "../../controller/units/schedule/plugins/ports.js";
import type { Schedule } from "../../core/schedule.js";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { GrantBrokerDeps } from "../../core/schedule-grants.js";
import type { ToolSpec } from "../../core/tools/types.js";
import { type RunId, type Timestamp, type WorkItemId, usageTokens } from "../../core/types.js";
import type { ScheduleAction } from "../../interfaces/schedule-action.js";

/** What ScheduleGrantBroker reads and runs on this machine: core may not import node's I/O (tests/boundaries.test.ts). */
export const nodeGrantDeps: GrantBrokerDeps = {
  exists: existsSync,
  mkdir: async (p) => void (await mkdir(p, { recursive: true })),
  exec: (file, args, signal) => new Promise((res, rej) => {
    execFile(file, [...args], { timeout: 30_000, maxBuffer: 1_000_000, ...(signal ? { signal } : {}) }, (err, stdout) => (err ? rej(err) : res(stdout)));
  }),
};

/**
 * The read-only paths of a schedule run with a writable path: its checkout, so a harness that allows writes in its workdir (claude-code) lets
 * Write and Edit reach only the run's writable paths. A checkout that holds or lies in a denied path would lose that
 * rule in the harness (a read-only path never overlaps one): it throws, before any agent starts. Node's path, not
 * core's: an adapter imports no core value (tests/architecture/kinds.test.ts).
 */
export function readOnlyCheckout(workdir: string, deny_paths: readonly string[]): string[] {
  const w = resolve(workdir);
  const inside = (a: string, b: string) => { const r = relative(b, a); return r === "" || (r !== ".." && !r.startsWith(`..${sep}`) && !isAbsolute(r)); };
  if (deny_paths.some((d) => inside(w, resolve(d)) || inside(resolve(d), w))) throw new Error(`the schedule's checkout ${w} overlaps a denied path`);
  return [w];
}

/** The only tools a schedule's agent gets, all of capability `read`. */
export const SCHEDULE_AGENT_TOOLS: readonly string[] = ["Read", "Glob", "Grep"];
/** The most characters of an answer kept on the run row. */
export const OUTPUT_CHARS = 20_000;

const SYSTEM_PROMPT = "You run a scheduled task on this repository. You can read files and search them (Read, Glob, Grep); you cannot change, run or send anything. Answer the task below.";

type Ctx = Contexts["schedule_action"];

/** The source ID of `schedule_id`'s occurrence at `occurrence_at`: `2026-11-23T00:00:00.000Z` → `schedule-<id>-20261123T000000Z`. */
export const occurrenceSourceId = (schedule_id: string, occurrence_at: string): string => `schedule-${schedule_id}-${occurrence_at.replace(/[-:]|\.\d+/g, "")}`;

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
      occurrence_id: occurrenceSourceId(schedule.id, occurrence_at),
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
    const cfg = this.c.loaded.config;
    const run = i.run ?? { tools: readOnlyTools(this.c.tools), repo: cfg.repo.path, base_ref: cfg.repo.base_branch, writable_paths: [], tool_grants: [], granted: [] };
    const handle = await sandbox.create({ repo: run.repo, branch: null, base_ref: run.base_ref });
    try {
      const result = await runner.run({
        run_id: `schedule_${schedule.id}_${occurrence_at.replace(/\W/g, "")}` as RunId,
        work_item_id: `schedule:${schedule.id}` as WorkItemId,
        role: "triage", // a read-only role that keeps no session
        sandbox: handle,
        system_prompt: run.granted.length === 0 ? SYSTEM_PROMPT : `${SYSTEM_PROMPT}\n\nThe owner granted this schedule more, and nothing else:\n${run.granted.map((g) => `- ${g}`).join("\n")}`,
        prompt: i.prompt,
        tools: run.tools as ToolSpec[], // ScheduleGrantBroker hands out ToolSpecs; ports.ts names them by shape
        tool_grants: [...run.tool_grants],
        lease_token: 0,
        env_allowlist: {},
        deny_paths: cfg.deny_paths,
        writable_paths: [...run.writable_paths],
        ...(run.writable_paths.length > 0 ? { readable_paths: readOnlyCheckout(handle.workdir, cfg.deny_paths) } : {}),
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
