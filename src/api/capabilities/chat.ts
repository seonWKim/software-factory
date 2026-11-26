// The chat capabilities (design 04-chat-agent, 09-api-registry): chat.send runs one chat turn (src/core/chat-agent.ts)
// with the Ask model (settings.ask.llm, as schedules.draft uses) and the chat's read-only broker over the feature map;
// chat.transcript reads a session's stored messages; chat.turns lists recent turns. Only chat.send writes: one
// controller_chat_turns row per turn, running at its start, then answered, refused or failed. With no Ask model
// chat.send refuses (503) and stores nothing. Code outside src/api/ is imported inside each run, so
// scripts/gen-api.mjs never loads it.

import type { ChatTurnResult } from "../../core/chat-agent.js";
import { type Declared, declare, refuse } from "../registry.js";
import { array, jsonObject, number, object, oneOf, optional, string } from "../schema.js";

const OUTCOMES = ["answered", "refused", "failed"] as const;
type Outcome = (typeof OUTCOMES)[number];

/** chat.turns' answer when no limit is given. */
export const CHAT_TURNS_LIMIT = 50;

/** A turn's result as chat.send's outcome and reason: withheld is a refusal, every other failure a failure. */
function outcomeOf(r: ChatTurnResult): { outcome: Outcome; reason: string | null } {
  if (r.ok) return { outcome: "answered", reason: null };
  return { outcome: r.reason === "withheld" ? "refused" : "failed", reason: r.reason };
}

export const CHAT: readonly Declared[] = [
  declare({
    id: "chat.send", area: "chat",
    description: "Send the owner's message to the chat and run one turn with the Ask model; no session_id starts a new session. A withheld turn answers no reply.",
    permission: "owner", method: "POST", path: "/api/v1/chat/send",
    input: object({ session_id: optional(string()), text: string() }),
    output: object({ turn_id: string(), session_id: string(), outcome: oneOf(OUTCOMES), reason: optional(string()), reply: optional(string()) }),
    run: async (c, i) => {
      const llm = c.d.settings?.ask?.llm ?? null;
      if (llm === null) return refuse(503, "Chat is off: no model is configured (plugins.llm).");
      const [{ randomUUID }, { chatTurn }, { ChatToolBroker, featureMapTools }, { readFeatureMap }, { registryOf }] = await Promise.all([
        import("node:crypto"), import("../../core/chat-agent.js"), import("../../core/chat-agent-tools.js"), import("../feature-map.js"), import("../index.js"),
      ]);
      const session_id = i.session_id ?? `cs_${randomUUID()}`;
      const turn_id = `ct_${randomUUID()}`;
      const store = c.d.store;
      await store.startChatTurn(turn_id, session_id);
      const registry = registryOf(c.d);
      const broker = new ChatToolBroker(featureMapTools((p) => readFeatureMap(registry, p)));
      let result: ChatTurnResult | null = null;
      try {
        result = await chatTurn({ store, llm, broker, scanner: c.d.scanner, clock: c.d.clock, newTurnId: () => turn_id }, session_id, i.text);
      } catch {
        // A thrown error ends the row too: failed, reason "error", never left running.
      }
      const { outcome, reason } = result === null ? { outcome: "failed" as const, reason: "error" } : outcomeOf(result);
      await store.finishChatTurn(turn_id, outcome, reason);
      return { turn_id, session_id, outcome, ...(reason !== null && { reason }), ...(result?.ok && { reply: result.reply }) };
    },
  }),
  declare({
    id: "chat.transcript", area: "chat", description: "One chat session's stored messages in order (?session_id=<id>); an unknown session answers none.",
    permission: "owner", method: "GET", path: "/api/v1/chat/transcript",
    input: object({ session_id: string() }), output: object({ messages: array(jsonObject()) }),
    run: async (c, i) => ({ messages: (await c.d.store.listChatMessages(i.session_id)).map((m) => ({ ...m })) }),
  }),
  declare({
    id: "chat.turns", area: "chat",
    description: `The recent chat turns, newest first, at most limit (default ${CHAT_TURNS_LIMIT}): each with its turn_id, session_id, status, reason and times.`,
    permission: "owner", method: "GET", path: "/api/v1/chat/turns",
    input: object({ limit: optional(number()) }), output: object({ turns: array(jsonObject()) }),
    run: async (c, i) => ({ turns: (await c.d.store.listChatTurns(i.limit ?? CHAT_TURNS_LIMIT)).map((t) => ({ ...t })) }),
  }),
];
