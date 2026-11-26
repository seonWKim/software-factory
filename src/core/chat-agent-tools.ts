// The chat's tools (design 04-chat-agent): the chat's own ToolBroker, serving read-only tools only, and the four
// feature-map read tools it serves today. Each feature-map tool wraps the feature map (src/api/feature-map.ts,
// design 09-api-registry) through an injected reader, so the tools come from the registry's declarations and no list
// of factory tools is kept here. core/ imports only core/ and interfaces/, so the reader is passed in: the wiring binds
// it to `readFeatureMap(REGISTRY, path)`. The feature map's text is the declarations' own (code, not store text), so
// it holds no secret; the chat still scans every result (src/core/chat-agent.ts).

import type { ToolBroker, ToolCallContext, ToolDescriptor, ToolResult } from "../interfaces/tool-broker.js";
import type { RunId, WorkItemId } from "./types.js";

/** The feature map's answer for a path under /api/v1/feature-map/ (readFeatureMap over a registry), else null. */
export type FeatureMapReader = (path: string) => { status: number; value: unknown } | null;

/** A tool the chat's broker serves: read-only by type, and its call, run in this process. */
export interface ChatTool extends ToolDescriptor {
  read_only: true;
  call(args: unknown): Promise<ToolResult>;
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
    if (!tool) return { ok: false, error_code: "unknown_tool", message: name };
    try {
      return await tool.call(args);
    } catch {
      // The thrown text is not passed on: the chat gets only that the call failed.
      return { ok: false, error_code: "tool_error", message: `${name} failed` };
    }
  }
}

/** What a chat turn's tool call names in place of a run: the session. A chat turn holds no lease (token 0). */
export const chatCallContext = (session_id: string): ToolCallContext => ({
  run_id: `chat:${session_id}` as RunId, work_item_id: "" as WorkItemId, lease_token: 0,
});
