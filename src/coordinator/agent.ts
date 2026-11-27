// The coordinator agent (design 05-coordinator): one call per cycle through the selected agent runner (plugins.runner),
// in a fresh read-only checkout with the read-only tools Read, Glob and Grep, the standing instructions of
// prompts/coordinator.md as its system prompt, and the waiting items as its prompt. Its answer is a list of proposed
// actions, which the cycle checks in code before it carries any out. The transcript is scanned (G5) and stored under
// `transcripts/coordinator/<cycle>.json`; the link is null when the scan flagged it or no storage is given. The answer
// carries the run's cost and tokens from the runner's own report (cost null when it gave none, design 06-spend).

import type { FactoryConfig } from "../core/config.js";
import type { ToolSpec } from "../core/tools/types.js";
import type { RunId, WorkItem, WorkItemId } from "../core/types.js";
import type { AgentRunner } from "../interfaces/agent-runner.js";
import type { EgressScanner } from "../interfaces/egress-scanner.js";
import type { Sandbox } from "../interfaces/sandbox.js";
import type { SharedStorage } from "../interfaces/shared-storage.js";
import { readOnlyTools } from "../impl/schedule-action/routed-action.js";
import { type CoordinatorAgent, MERGE, type ProposedAction, SKIP } from "./cycle.js";

/** The standing instructions, read from the code root at each cycle. */
export const COORDINATOR_PROMPT = "prompts/coordinator.md";

/** The answer the agent must give: one entry per item it acts on. */
export const OUTPUT_SCHEMA = {
  type: "object",
  required: ["actions"],
  properties: {
    actions: {
      type: "array",
      items: {
        type: "object",
        required: ["command", "work_item_id", "reason"],
        properties: { command: { type: "string", enum: [MERGE, SKIP] }, work_item_id: { type: "string" }, reason: { type: "string" } },
      },
    },
  },
} as const;

export interface AgentDeps {
  runner: AgentRunner;
  sandbox: Sandbox;
  scanner: EgressScanner;
  storage: SharedStorage | null;
  tools: readonly ToolSpec[];
  config: Pick<FactoryConfig, "repo" | "deny_paths" | "run_timeout_ms">;
  /** The standing instructions; null when the file cannot be read, and the cycle then fails. */
  prompt(): Promise<string | null>;
}

/** The waiting items as the agent reads them: no problem text, only what a merge decision needs. */
export function itemsPrompt(items: readonly WorkItem[]): string {
  const rows = items.map((it) => ({ id: it.id, title: it.title, source: it.source.type, tier: it.tier, stage: it.stage, blocked_reason: it.blocked_reason }));
  return `The work items waiting for a merge:\n\n${JSON.stringify(rows, null, 2)}\n\nAnswer with the actions to take.`;
}

/** The proposed actions in `output`; malformed entries are left out. */
export function proposedActions(output: unknown): ProposedAction[] {
  const list = (output as { actions?: unknown } | null)?.actions;
  if (!Array.isArray(list)) return [];
  return list.flatMap((a: Record<string, unknown>) => typeof a?.command === "string"
    ? [{ command: a.command, work_item_id: typeof a.work_item_id === "string" ? a.work_item_id : null, reason: typeof a.reason === "string" ? a.reason : "" }]
    : []);
}

export function coordinatorAgent(d: AgentDeps): CoordinatorAgent {
  return async ({ cycle_id, items }) => {
    const system_prompt = await d.prompt();
    if (system_prompt === null) return { status: "failed", actions: [], transcript_link: null, cost_usd: null, tokens: 0, error: `${COORDINATOR_PROMPT} cannot be read` };
    const tools = readOnlyTools(d.tools);
    const handle = await d.sandbox.create({ repo: d.config.repo.path, branch: null, base_ref: d.config.repo.base_branch });
    try {
      const result = await d.runner.run({
        run_id: cycle_id as RunId,
        work_item_id: `coordinator:${cycle_id}` as WorkItemId,
        role: "triage", // a read-only role that keeps no session
        sandbox: handle,
        system_prompt,
        prompt: itemsPrompt(items),
        tools,
        tool_grants: [],
        lease_token: 0,
        env_allowlist: {},
        deny_paths: d.config.deny_paths,
        writable_paths: [],
        model_class: "standard",
        timeout_ms: d.config.run_timeout_ms,
        output_schema: OUTPUT_SCHEMA as unknown as Record<string, unknown>,
        signal: new AbortController().signal,
      });
      const clean = (await d.scanner.scan("run_outcome", result.transcript)).clean;
      let transcript_link: string | null = null;
      if (clean && d.storage) {
        const key = `transcripts/coordinator/${cycle_id}.json`;
        await d.storage.put(key, new TextEncoder().encode(result.transcript));
        transcript_link = `storage:${key}`;
      }
      const { cost_usd, input_tokens, output_tokens } = result.usage;
      return { status: result.status, actions: proposedActions(result.output), transcript_link, cost_usd, tokens: input_tokens + output_tokens, ...(result.error ? { error: result.error.slice(0, 500) } : {}) };
    } finally {
      await d.sandbox.destroy(handle);
    }
  };
}
