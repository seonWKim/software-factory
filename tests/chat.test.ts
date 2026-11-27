// chat.send's call_feature (design 04-chat-agent), the path the Chat page takes: the model asks for items.list blocked
// on the owner and activity.actors, and gets the store's live rows through the registry (input check, Withholder,
// output check). Through respond(), with a scripted provider; no live model call.

import { describe, expect, it } from "vitest";
import type { UserId } from "../src/core/types.js";
import type { LLMProvider, LLMRequest, LLMResponse } from "../src/interfaces/llm-provider.js";
import type { PauseDeps, UiPauses } from "../src/ui/pause-api.js";
import { respond } from "../src/ui/server.js";
import { type UiSettings, newCsrfToken } from "../src/ui/settings-api.js";
import { silent } from "./helpers/fakes/config.js";
import { SECRET, seeded } from "./ui-api-fixtures.js";

const HOST = "127.0.0.1:4310";

function scripted(steps: Partial<LLMResponse>[]): LLMProvider & { seen: LLMRequest[] } {
  const seen: LLMRequest[] = [];
  return {
    seen,
    async complete(req) {
      seen.push(req);
      return { text: "", stop_reason: "end", usage: { input_tokens: 1, output_tokens: 1, cost_usd: 0 }, ...(steps[seen.length - 1] ?? { text: "out of script" }) };
    },
  };
}

const call = (id: string, name: string, args: unknown) => ({ id, name, arguments: JSON.stringify(args) });

describe("chat.send with call_feature", () => {
  it("answers 'What needs me today?' from the store's items blocked on the owner and the open alerts", async () => {
    const { d, items } = await seeded();
    const llm = scripted([
      { tool_calls: [call("c1", "call_feature", { id: "items.list", input: { blocked_on: "human" } }), call("c2", "call_feature", { id: "activity.actors", input: {} })] },
      { text: "Two items need you." },
    ]);
    const pauses: UiPauses = { principal: async () => "local:owner@example.com" as UserId, authorize: async () => ({ allow: true }), csrfToken: newCsrfToken(), log: silent };
    const deps: PauseDeps = { ...d, pauses, settings: { ask: { llm, log: silent }, resolveProject: async () => null, repo: { owner: "o", name: "r" } } as unknown as UiSettings };
    const r = await respond(deps, {
      method: "POST", url: "/api/v1/chat/send", host: HOST, origin: `http://${HOST}`, contentType: "application/json", csrfToken: pauses.csrfToken,
      body: JSON.stringify({ text: "What needs me today?" }),
    });
    expect(r.status).toBe(200);
    expect(JSON.parse(r.body)).toMatchObject({ outcome: "answered", reply: "Two items need you." });

    expect(llm.seen[0]!.tools!.map((t) => t.name)).toContain("call_feature");
    const tool = (id: string) => JSON.parse(llm.seen[1]!.messages.find((m) => m.tool_call_id === id)!.content) as { id: string; result: Record<string, unknown> };
    const listed = tool("c1");
    expect(listed.id).toBe("items.list");
    const rows = listed.result.items as { id: string; title: string | null; blocked_on: string }[];
    expect(rows.map((x) => x.id)).toContain(items.approve.id);
    expect(rows.find((x) => x.id === items.approve.id)!.title).toBe("Spec for <script>alert(1)</script> the gate");
    expect(rows.every((x) => x.blocked_on === "human")).toBe(true);
    expect(tool("c2").result).toHaveProperty("alerts");
    // The seeded secret title left through the Withholder: it is in no message the provider received.
    expect(JSON.stringify(llm.seen)).not.toContain(SECRET);
  });
});
