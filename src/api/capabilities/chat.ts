// The chat capabilities (design 04-chat-agent, 09-api-registry): chat.send runs one chat turn (src/core/chat-agent.ts)
// with the Ask model (settings.ask.llm, as schedules.draft uses) and the chat's read-only broker: the feature map and
// call_feature, bound to callCapability over the same registry, so the chat reads every GET capability's live data;
// chat.transcript reads a session's stored messages; chat.turns lists recent turns. Only chat.send writes: one
// controller_chat_turns row per turn, running at its start, then answered, refused or failed. With no Ask model
// chat.send refuses (503) and stores nothing. chat.send takes up to 5 images with the text (design 04-chat-agent),
// checked by core/attachments.ts chatImages and stored with the turn's user message; chat.transcript names each
// message's images and chat.image answers one image's bytes. Code outside src/api/ is imported inside each run, so
// scripts/gen-api.mjs never loads it.
// A Needs-you decision in the chat (design 04-chat-commands, 09-dashboard-chat): chat.decision reads the decision of
// the item the chat is opened on (?item=) from the item detail (src/ui/api.ts), chat.command sends a button press, a
// reply (sentence) or a proposal's Confirm all and Cancel through itemCommandSend (src/ui/commands.ts), the item
// commands route's own path after its guards, and chat.mode reads the stored permission_mode (one owner setting).

import type { ChatTurnResult } from "../../core/chat-agent.js";
import { type Declared, callCapability, declare, refuse } from "../registry.js";
import { array, boolean, bytes, integer, jsonObject, nullable, number, object, oneOf, optional, string } from "../schema.js";

const OUTCOMES = ["answered", "refused", "failed"] as const;
type Outcome = (typeof OUTCOMES)[number];

/**
 * chat.send's largest body: 5 images of 5 MB as base64 (4/3 larger) and the text around them (core/attachments.ts
 * MAX_CHAT_IMAGES and MAX_IMAGE_BYTES, which refuse each image by name; this only stops a body too large to read).
 */
export const CHAT_SEND_MAX_BODY = 5 * Math.ceil((5 * 1024 * 1024 * 4) / 3) + 1024 * 1024;

/** chat.turns' answer when no limit is given. */
export const CHAT_TURNS_LIMIT = 50;

/** A turn's result as chat.send's outcome and reason: withheld is a refusal, every other failure a failure. */
function outcomeOf(r: ChatTurnResult): { outcome: Outcome; reason: string | null; detail?: string } {
  if (r.ok) return { outcome: "answered", reason: null };
  if (r.reason === "withheld" && r.images_withheld !== undefined) return { outcome: "refused", reason: "images_withheld" };
  return { outcome: r.reason === "withheld" ? "refused" : "failed", reason: r.reason, ...(r.detail !== undefined && { detail: r.detail }) };
}

export const CHAT: readonly Declared[] = [
  declare({
    id: "chat.send", area: "chat",
    description: "Send the owner's message to the chat and run one turn with the Ask model; no session_id starts a new session. "
      + "It may carry up to 5 images (name and base64 bytes; png, jpeg, gif or webp, 5 MB or less each), with or without text; the model reads them after the text, in order. "
      + "A sixth image, another type or a larger file refuses the whole message (400) naming the file. An image the leak scanner flags is not sent: images_withheld names it. "
      + "A withheld turn answers no reply; a failed model call answers the provider's own words in detail.",
    permission: "owner", method: "POST", path: "/api/v1/chat/send", max_body: CHAT_SEND_MAX_BODY,
    input: object({ session_id: optional(string()), text: string(), images: optional(array(object({ name: string(), data: bytes() }))) }),
    output: object({
      turn_id: string(), session_id: string(), outcome: oneOf(OUTCOMES), reason: optional(string()), detail: optional(string()), reply: optional(string()),
      images_withheld: optional(array(string())),
    }),
    run: async (c, i) => {
      const llm = c.d.settings?.ask?.llm ?? null;
      if (llm === null) return refuse(503, "Chat is off: no model is configured (plugins.llm).");
      const [{ randomUUID }, { chatTurn, CHAT_DETAIL_MAX }, { ChatToolBroker, chatToolsOf }, { readFeatureMap }, { registryOf }, { chatImages }, { ANONYMOUS_USER }, { Withholder }] = await Promise.all([
        import("node:crypto"), import("../../core/chat-agent.js"), import("../../core/chat-agent-tools.js"), import("../feature-map.js"), import("../index.js"),
        import("../../core/attachments.js"), import("../../core/authorize.js"), import("../../ui/withhold.js"),
      ]);
      const checked = chatImages(i.images ?? [], c.d.commands?.actor ?? ANONYMOUS_USER, randomUUID);
      if ("refuse" in checked) return refuse(400, checked.refuse);
      if (i.text.trim() === "" && checked.images.length === 0) return refuse(400, "Nothing was sent: the message has no text and no image.");
      const session_id = i.session_id ?? `cs_${randomUUID()}`;
      const turn_id = `ct_${randomUUID()}`;
      const store = c.d.store;
      await store.startChatTurn(turn_id, session_id);
      const registry = registryOf(c.d);
      const w = new Withholder(c.d.scanner);
      const broker = new ChatToolBroker(chatToolsOf((p) => readFeatureMap(registry, p), (id, input) => callCapability(registry, c.d, id, input, w)));
      let result: ChatTurnResult | null = null;
      let thrown = "";
      try {
        result = await chatTurn({ store, llm, broker, scanner: c.d.scanner, clock: c.d.clock, newTurnId: () => turn_id }, session_id, i.text, checked.images);
      } catch (err) {
        // A thrown error ends the row too: failed, reason "error", never left running. Its message is the detail
        // when the scan finds nothing in it.
        thrown = (err instanceof Error ? err.message : String(err)).trim().slice(0, CHAT_DETAIL_MAX);
      }
      const thrownDetail = thrown !== "" && (await c.d.scanner.scan("ui", thrown)).clean ? { detail: thrown } : {};
      const { outcome, reason, detail } = result === null ? { outcome: "failed" as const, reason: "error", ...thrownDetail } : outcomeOf(result);
      await store.finishChatTurn(turn_id, outcome, reason);
      const withheld = result?.images_withheld;
      return {
        turn_id, session_id, outcome, ...(reason !== null && { reason }), ...(detail !== undefined && { detail }), ...(result?.ok && { reply: result.reply }),
        ...(withheld !== undefined && { images_withheld: withheld }),
      };
    },
  }),
  declare({
    id: "chat.transcript", area: "chat",
    description: "One chat session's stored messages in order (?session_id=<id>); an unknown session answers none. A user message sent with images names them in images (id, name, media_type, size_bytes; the bytes through chat.image).",
    permission: "owner", method: "GET", path: "/api/v1/chat/transcript",
    input: object({ session_id: string() }), output: object({ messages: array(jsonObject()) }),
    run: async (c, i) => ({
      messages: (await c.d.store.listChatMessages(i.session_id)).map(({ images, ...m }) => ({
        ...m, ...(images?.length && { images: images.map(({ id, name, media_type, size_bytes }) => ({ id, name, media_type, size_bytes })) }),
      })),
    }),
  }),
  declare({
    id: "chat.image", area: "chat", description: "One image a chat message was sent with (?id=<id> from chat.transcript): its name, type and bytes as base64. An unknown id is a 404.",
    permission: "owner", method: "GET", path: "/api/v1/chat/image",
    input: object({ id: string() }), output: object({ id: string(), name: string(), media_type: string(), size_bytes: integer(), data: bytes() }),
    run: async (c, i) => {
      const image = await c.d.store.getChatImage(i.id);
      if (image === null) return refuse(404, "No chat image has this id.");
      const { created_by: _by, ...shown } = image;
      return shown;
    },
  }),
  declare({
    id: "chat.turns", area: "chat",
    description: `The recent chat turns, newest first, at most limit (default ${CHAT_TURNS_LIMIT}): each with its turn_id, session_id, status, reason and times.`,
    permission: "owner", method: "GET", path: "/api/v1/chat/turns",
    input: object({ limit: optional(number()) }), output: object({ turns: array(jsonObject()) }),
    run: async (c, i) => ({ turns: (await c.d.store.listChatTurns(i.limit ?? CHAT_TURNS_LIMIT)).map((t) => ({ ...t })) }),
  }),
  declare({
    id: "chat.decision", area: "chat",
    description: "The Needs-you decision of one item (?item=<id>), as the chat shows it: waiting (the owner is next), the item's title, its why (the question), "
      + "In short and the newest factory message (the evidence), its commands (one button each, with the viewer's allowed and reason) and its pending proposals "
      + "(each with its typed lines). An unknown item is a 404.",
    permission: "owner", method: "GET", path: "/api/v1/chat/decision",
    input: object({ item: string() }),
    output: object({
      waiting: boolean(), title: nullable(string()), why: jsonObject(), in_short: nullable(string()), evidence: nullable(string()),
      commands: array(jsonObject()), proposals: array(object({ id: string(), lines: array(string()) })),
    }),
    run: async (c, i) => {
      const { answerOf, api } = await import("../../ui/api.js");
      const detail = answerOf<ChatItemDetail>(await api(c.d, new URL(`http://chat/api/v1/items/${encodeURIComponent(i.item)}`)));
      if ("status" in detail) return detail;
      return decisionOf(detail);
    },
  }),
  declare({
    id: "chat.command", area: "chat",
    description: "Send one item command from the chat: a decision's button (command, with the reply box's words as note when it takes one), a reply as a sentence "
      + "(command sentence, its words as note: the controller reads it into pending proposals), or a proposal's Confirm all (proposal_confirm) or Cancel (proposal_cancel) "
      + "with the proposal's id. It is the item commands route's own request, with the same owner check: Approve and Merge answer their outcome and the item's state.",
    permission: "owner", method: "POST", path: "/api/v1/chat/command",
    input: object({ item: string(), command: string(), note: optional(string()), proposal: optional(string()) }),
    output: object({
      seq: integer(), command: string(), outcome: optional(string()), refusal: optional(nullable(string())), state: optional(jsonObject()),
    }),
    run: async (c, i) => {
      const { itemCommandSend } = await import("../../ui/commands.js");
      const { item, ...body } = i;
      const r = await itemCommandSend(c.d, item, Object.fromEntries(Object.entries(body).filter(([, v]) => v !== undefined)));
      const v = r.value as { error?: string; seq: number; command: string; outcome?: string; refusal?: string | null; state?: Record<string, unknown> };
      if (r.status !== 202) return refuse(r.status, v.error ?? "The command was not sent.");
      return { seq: v.seq, command: v.command, ...(v.outcome !== undefined && { outcome: v.outcome }), ...("refusal" in v && { refusal: v.refusal ?? null }), ...(v.state && { state: v.state }) };
    },
  }),
  declare({
    id: "chat.mode", area: "chat",
    description: "The stored permission mode (permission_mode, one setting for the owner): ask_all, ask_irreversible (the default) or full. Read only: the chat shows it in its mode badge.",
    permission: "owner", method: "GET", path: "/api/v1/chat/mode",
    input: object({}), output: object({ mode: string() }),
    run: async (c) => {
      const { effectiveGlobal } = await import("../../ui/settings-api.js");
      return { mode: String((await effectiveGlobal(c.d, "permission_mode")).value) };
    },
  }),
];

/** The item detail fields chat.decision reads (src/ui/api.ts item). */
interface ChatItemDetail {
  item: { title: string | null; why: { next_actor?: string } & Record<string, unknown> };
  thread: readonly { role: string; kind: string; body: string }[];
  commands: readonly Record<string, unknown>[];
  spec: { in_short: string | null } | null;
  proposals: readonly { id: string; commands: readonly { line: string }[] }[];
}

/** A command refusal in the thread (marker `factory:refused:`): it answers a command, so it is no evidence for a wait. */
const isRefusal = (m: { kind: string; body: string }) => m.kind === "refused" || m.body.includes(" was not applied");

/**
 * The chat's decision from the item detail: the why as the question, In short and the newest factory message (not a
 * refusal) as evidence, the commands as the buttons and the pending proposals' typed lines. Ids stay data: the page
 * shows none of them.
 */
export function decisionOf(d: ChatItemDetail) {
  const latest = [...d.thread].reverse().find((m) => m.role === "factory" && !isRefusal(m));
  return {
    waiting: d.item.why.next_actor === "human", title: d.item.title, why: { ...d.item.why }, in_short: d.spec?.in_short ?? null, evidence: latest?.body ?? null,
    commands: d.commands.map((x) => ({ ...x })), proposals: d.proposals.map((p) => ({ id: p.id, lines: p.commands.map((x) => x.line) })),
  };
}
