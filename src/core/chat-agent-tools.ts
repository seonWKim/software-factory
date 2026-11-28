// The chat's tools (design 04-chat-agent): the chat's own ToolBroker, serving read-only tools only, the four
// feature-map read tools and call_feature, and add_task, the one write a chat turn may make, which chatTurn calls
// itself (never through the broker). Each feature-map tool wraps the feature map (src/api/feature-map.ts, design
// 09-api-registry) through an injected reader, so the tools come from the registry's declarations and no list of
// factory tools is kept here. call_feature answers live data from any GET capability through an injected caller, cut
// to CALL_FEATURE_ROWS rows per list and refused over CALL_FEATURE_MAX_CHARS. core/ imports only core/ and interfaces/,
// so both are passed in: chat.send binds the reader to `readFeatureMap(registry, path)` and the caller to the
// registry's callCapability, the eval binds the caller to its fixture. A result may hold store text, so the chat scans
// every result (src/core/chat-agent.ts). add_task parses quick-add words as `factory task add` and tasks.create do and
// stores the task with the store's addTask under `tk_<turn id>`, so a turn sent again adds nothing new; it is the
// table's `task add` through authorizeWrite (design 08-permissions): held in ask_all, run in ask_irreversible and full.
// A tool call that names a command of the command table (`task_done`, `merge`) is an agent write in a chat turn: the
// permission gate refuses it in every mode, and the owner types the command instead.

import type { EgressScanner } from "../interfaces/egress-scanner.js";
import type { FactoryStore } from "../interfaces/factory-store.js";
import type { ToolBroker, ToolCallContext, ToolDescriptor, ToolResult } from "../interfaces/tool-broker.js";
import type { RunId, UserId, WorkItemId } from "./types.js";
import { CHAT_ADD_TASK, authorizeWrite, permissionGate } from "./authorize.js";
import { COMMAND_TABLE, type TableCommand } from "./command-table.js";
import { parseQuickAdd } from "./quick-add.js";
import { ProjectRefused } from "./tasks.js";

/** The feature map's answer for a path under /api/v1/feature-map/ (readFeatureMap over a registry), else null. */
export type FeatureMapReader = (path: string) => { status: number; value: unknown } | null;

/**
 * A GET capability's answer for its id and input: 200 with its value, else a status with `{ error }`. chat.send binds
 * it to callCapability over the registry (src/api/registry.ts: only a GET runs, after its own input check), the eval
 * to its fixture.
 */
export type FeatureCaller = (id: string, input: Record<string, unknown>) => Promise<{ status: number; value: unknown }>;

/** A tool the chat's broker serves: read-only by type, and its call, run in this process. */
export interface ChatTool extends ToolDescriptor {
  read_only: true;
  call(args: unknown): Promise<ToolResult>;
}

/** The command a chat tool name stands for: its table name, or with `_` for each space (`task_done`); null for any other name. */
function chatToolCommand(name: string): TableCommand | null {
  return COMMAND_TABLE.find((c) => c.name === name || c.name.replaceAll(" ", "_") === name) ?? null;
}

/** The gate's answer to a chat tool call that names a command: refused, even in `full` (no mode lets an agent write from a chat turn but add_task). */
function chatWriteRefusal(c: TableCommand): ToolResult | null {
  const gate = permissionGate({ mode: "full", reversible: c.reversible, origin: "agent", in_chat_turn: true });
  return gate.outcome === "refuse" ? { ok: false, error_code: gate.reason, message: `${c.name} is a command, and an agent runs no command from a chat turn. Type \`factory ${c.name}\` instead.` } : null;
}

/** The feature map's paths (src/api/feature-map.ts). */
const MAP = "/api/v1/feature-map/";

const NO_INPUT = { type: "object", properties: {}, additionalProperties: false };
const stringInput = (field: string, description: string) => ({
  type: "object", properties: { [field]: { type: "string", description } }, required: [field], additionalProperties: false,
});

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const badArgs = (field: string): ToolResult => ({ ok: false, error_code: "bad_args", message: `${field} must be a non-empty string` });
const notFound = (id: string): ToolResult => ({ ok: false, error_code: "not_found", message: `No feature ${id}.` });
/** The string `field` of `args`, or null when it is missing or empty. */
const stringArg = (args: unknown, field: string): string | null => {
  const v = isRecord(args) ? args[field] : undefined;
  return typeof v === "string" && v.trim() !== "" ? v : null;
};

/** The four feature-map read tools: list_areas, list_features, get_feature, get_feature_schema. */
export function featureMapTools(read: FeatureMapReader): ChatTool[] {
  const value = (path: string): Record<string, unknown> | null => {
    const r = read(path);
    return r && r.status === 200 && isRecord(r.value) ? r.value : null;
  };
  const features = (): Record<string, unknown>[] => {
    const list = value(`${MAP}capabilities`)?.capabilities;
    return Array.isArray(list) ? list.filter(isRecord) : [];
  };
  return [
    {
      name: "list_areas",
      read_only: true,
      description: "Lists the factory's areas, each with the ids of its features.",
      input_schema: NO_INPUT,
      async call() {
        return { ok: true, content: { areas: value(`${MAP}areas`)?.areas ?? [] } };
      },
    },
    {
      name: "list_features",
      read_only: true,
      description: "Lists the features of one area: id, description, permission, method and path.",
      input_schema: stringInput("area", "The area's id, as list_areas gives it."),
      async call(args) {
        const area = stringArg(args, "area");
        if (area === null) return badArgs("area");
        return { ok: true, content: { area, features: features().filter((f) => f.area === area) } };
      },
    },
    {
      name: "get_feature",
      read_only: true,
      description: "Describes one feature: its area, description, permission, method and path.",
      input_schema: stringInput("id", "The feature's id, such as <area>.<name>."),
      async call(args) {
        const id = stringArg(args, "id");
        if (id === null) return badArgs("id");
        const feature = features().find((f) => f.id === id);
        return feature ? { ok: true, content: { feature } } : notFound(id);
      },
    },
    {
      name: "get_feature_schema",
      read_only: true,
      description: "Gives one feature's input and output JSON Schemas.",
      input_schema: stringInput("id", "The feature's id, such as <area>.<name>."),
      async call(args) {
        const id = stringArg(args, "id");
        if (id === null) return badArgs("id");
        const c = value(`${MAP}capabilities/${encodeURIComponent(id)}`)?.capability;
        return isRecord(c) ? { ok: true, content: { id, input: c.input, output: c.output } } : notFound(id);
      },
    },
  ];
}

/** The rows call_feature keeps of each top-level array of a result. */
export const CALL_FEATURE_ROWS = 20;
/** The most characters of a trimmed result call_feature answers; a larger one answers `too_large`. */
export const CALL_FEATURE_MAX_CHARS = 16_000;

/** One cut field of a result: its name, the rows shown and the rows it had. */
export interface TrimmedField { field: string; shown: number; total: number }

/** `value` with each top-level array cut to its first CALL_FEATURE_ROWS rows, and the fields cut. */
export function trimResult(value: unknown): { value: unknown; trimmed: TrimmedField[] } {
  if (Array.isArray(value)) {
    return value.length > CALL_FEATURE_ROWS ? { value: value.slice(0, CALL_FEATURE_ROWS), trimmed: [{ field: "", shown: CALL_FEATURE_ROWS, total: value.length }] } : { value, trimmed: [] };
  }
  if (!isRecord(value)) return { value, trimmed: [] };
  const trimmed: TrimmedField[] = [];
  const out: Record<string, unknown> = {};
  for (const [field, v] of Object.entries(value)) {
    if (Array.isArray(v) && v.length > CALL_FEATURE_ROWS) {
      out[field] = v.slice(0, CALL_FEATURE_ROWS);
      trimmed.push({ field, shown: CALL_FEATURE_ROWS, total: v.length });
    } else out[field] = v;
  }
  return { value: out, trimmed };
}

/** A caller's status as the tool's error code. */
const callError = (status: number): string => (status === 404 ? "not_found" : status === 405 ? "not_get" : status === 400 ? "bad_input" : "refused");

/** call_feature: one GET capability's live answer, by id and input, trimmed; any refusal is `ok: false` with its text. */
export function callFeatureTool(callFeature: FeatureCaller): ChatTool {
  return {
    name: "call_feature",
    read_only: true,
    description: "Calls one GET feature by its id with its input, and answers its live data. "
      + `Each list in the answer keeps its first ${CALL_FEATURE_ROWS} rows; \`trimmed\` names each cut list with the rows shown and its total. `
      + "Only GET features run: any other answers an error.",
    input_schema: {
      type: "object",
      properties: {
        id: { type: "string", description: "The feature's id, such as items.list." },
        input: { type: "object", description: "The feature's input, as get_feature_schema gives it; {} for none." },
      },
      required: ["id"],
      additionalProperties: false,
    },
    async call(args) {
      const id = stringArg(args, "id");
      if (id === null) return badArgs("id");
      const input = isRecord(args) ? (args.input ?? {}) : {};
      if (!isRecord(input)) return { ok: false, error_code: "bad_args", message: "input must be an object" };
      const r = await callFeature(id, input);
      if (r.status !== 200) {
        const error = isRecord(r.value) && typeof r.value.error === "string" ? r.value.error : `${id} answered ${r.status}`;
        return { ok: false, error_code: callError(r.status), message: error };
      }
      const { value, trimmed } = trimResult(r.value);
      const content = { id, result: value, ...(trimmed.length > 0 && { trimmed }) };
      if (JSON.stringify(content).length > CALL_FEATURE_MAX_CHARS) {
        return { ok: false, error_code: "too_large", message: `too_large: ${id}'s answer is over ${CALL_FEATURE_MAX_CHARS} characters even trimmed; narrow its input.` };
      }
      return { ok: true, content };
    },
  };
}

/** The chat's tools: the four feature-map tools, then call_feature. */
export const chatToolsOf = (read: FeatureMapReader, callFeature: FeatureCaller): ChatTool[] => [...featureMapTools(read), callFeatureTool(callFeature)];

/**
 * The chat's broker: serves only read-only tools, so a chat turn, which has no run, lease or passport, can call
 * nothing that changes anything. Built with the feature-map tools and any other read-only tool; a tool that is not
 * read-only, or a name given twice, is refused when it is built.
 */
export class ChatToolBroker implements ToolBroker {
  private readonly descriptors: readonly ToolDescriptor[];

  constructor(private readonly tools: readonly ChatTool[]) {
    const names = new Set<string>();
    for (const t of tools) {
      if (t.read_only !== true) throw new Error(`chat tool ${t.name}: only read-only tools may be served to the chat`);
      if (names.has(t.name)) throw new Error(`chat tool ${t.name}: the name is given twice`);
      names.add(t.name);
    }
    this.descriptors = tools.map(({ name, description, input_schema, read_only }) => ({ name, description, input_schema, read_only }));
  }

  listTools(grants: readonly string[]): ToolDescriptor[] {
    return this.descriptors.filter((t) => grants.includes(t.name));
  }

  allTools(): readonly ToolDescriptor[] {
    return this.descriptors;
  }

  async call(_ctx: ToolCallContext, name: string, args: unknown): Promise<ToolResult> {
    const tool = this.tools.find((t) => t.name === name);
    const command = tool ? null : chatToolCommand(name);
    if (command) return chatWriteRefusal(command) ?? { ok: false, error_code: "unknown_tool", message: name };
    if (!tool) return { ok: false, error_code: "unknown_tool", message: name };
    try {
      return await tool.call(args);
    } catch {
      // The thrown text is not passed on: the chat gets only that the call failed.
      return { ok: false, error_code: "tool_error", message: `${name} failed` };
    }
  }
}

/** The store methods add_task needs: the task write and the permission gate's mode and rows. */
export type ChatTaskStore = Pick<FactoryStore, "addTask" | "listSettingOverrides" | "holdWrite" | "recordAgentWrite">;
const TASK_METHODS = ["addTask", "listSettingOverrides", "holdWrite", "recordAgentWrite"] as const;
/** True when the store can back add_task (chat.send passes the full store; the eval's throwaway store cannot). */
export const canAddTask = (store: object): store is ChatTaskStore => TASK_METHODS.every((m) => typeof (store as Record<string, unknown>)[m] === "function");

/** Who a chat-added task is created by, and who its gate row names: the chat agent. */
export const CHAT_ACTOR = "service:chat" as UserId;

/** A task add_task stored: its ID and title, which the turn's reply names. */
export interface AddedTask { id: string; title: string }

/** add_task for one chat turn: its descriptor, its call, and the task it stored (null until one is). */
export interface AddTaskTool {
  descriptor: ToolDescriptor;
  call(args: unknown): Promise<ToolResult>;
  added(): AddedTask | null;
}

/**
 * add_task for the turn `turn_id`: the words through parseQuickAdd, then authorizeWrite as the agent's `task add` in a
 * chat turn (chat_tool add_task), then the store's addTask under `tk_<turn_id>` created by CHAT_ACTOR. Held, it answers
 * the held write's `confirm <id>`; refused (a guard), its reason. A second call in the same turn, or the turn sent
 * again with the same ID, stores nothing new and answers the task already stored.
 */
export function addTaskTool(d: { store: ChatTaskStore; scanner: Pick<EgressScanner, "scan"> }, turn_id: string): AddTaskTool {
  const id = `tk_${turn_id}`;
  let added: AddedTask | null = null;
  return {
    descriptor: {
      name: CHAT_ADD_TASK.tool,
      read_only: false,
      description: "Adds one plain task from quick-add words (today, tomorrow or YYYY-MM-DD, HH:MM, !1 to !3, #list, +project, every day/week/month; "
        + "the words left are its title), under the permission mode: it may be held for the owner's confirm. Never files an issue or a work item.",
      input_schema: stringInput("words", "The task's quick-add words, such as `call the bank tomorrow 09:00`."),
    },
    async call(args) {
      const words = stringArg(args, "words");
      if (words === null) return badArgs("words");
      const parsed = parseQuickAdd(words);
      if (!parsed.ok) return { ok: false, error_code: "bad_args", message: parsed.reason };
      const gate = await authorizeWrite(d, {
        command: CHAT_ADD_TASK.command, args: [words], actor: CHAT_ACTOR, origin: "agent", in_chat_turn: true, chat_tool: CHAT_ADD_TASK.tool, key: id,
      });
      if (gate.outcome === "refused") return { ok: false, error_code: gate.reason, message: gate.reply };
      if (gate.outcome === "held") return { ok: true, content: { outcome: "held", held_write: gate.id, mode: gate.mode, message: gate.reply } };
      try {
        const task = await d.store.addTask({ ...parsed.task, id, created_by: CHAT_ACTOR });
        added = { id: task.id, title: task.title };
        return { ok: true, content: { outcome: "added", mode: gate.mode, task: { id: task.id, title: task.title, due_date: task.due_date, due_time: task.due_time, list: task.list } } };
      } catch (err) {
        if (err instanceof ProjectRefused) return { ok: false, error_code: "bad_args", message: err.message };
        throw err;
      }
    },
    added: () => added,
  };
}

/** What a chat turn's tool call names in place of a run: the session. A chat turn holds no lease (token 0). */
export const chatCallContext = (session_id: string): ToolCallContext => ({
  run_id: `chat:${session_id}` as RunId, work_item_id: "" as WorkItemId, lease_token: 0,
});
