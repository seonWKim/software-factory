// The chat capabilities (design 04-chat-agent, 09-api-registry): chat.send runs one chat turn with the Ask model and
// stores one controller_chat_turns row (running, then answered, refused or failed); chat.transcript and chat.turns
// read only. Driven through the server (respond), so the registry's guards, schemas and Withholder apply. A scripted
// fake provider and a SQLite store in memory, as in tests/chat-agent.test.ts; no live model call.

import { describe, expect, it } from "vitest";
import { CHAT, CHAT_TURNS_LIMIT } from "../src/api/capabilities/chat.js";
import { DECLARATIONS } from "../src/api/index.js";
import type { UserId } from "../src/core/types.js";
import { FakeClock } from "../src/impl/clock/fake-clock.js";
import { PatternEgressScanner } from "../src/impl/egress/pattern-egress-scanner.js";
import type { ChatTurnRecord } from "../src/interfaces/factory-store.js";
import type { LLMProvider, LLMRequest, LLMResponse } from "../src/interfaces/llm-provider.js";
import { HealthMonitor } from "../src/ui/health.js";
import type { PauseDeps, UiPauses } from "../src/ui/pause-api.js";
import { respond } from "../src/ui/server.js";
import { type UiSettings, newCsrfToken } from "../src/ui/settings-api.js";
import { silent } from "./helpers/fakes/config.js";
import { newStore } from "./helpers/store.js";

const HOST = "127.0.0.1:4310";
const SECRET = `ghp_${"Ab3".repeat(12)}`;

type Step = Omit<LLMResponse, "usage" | "stop_reason"> & Partial<Pick<LLMResponse, "usage" | "stop_reason">>;
/** A provider that answers `steps` in order, keeps each request and runs `during` inside each call. */
function scripted(steps: Step[], during: () => Promise<void> = async () => {}): LLMProvider & { seen: LLMRequest[] } {
  const seen: LLMRequest[] = [];
  return {
    seen,
    async complete(req) {
      seen.push(req);
      await during();
      const s = steps[seen.length - 1] ?? { text: "out of script" };
      return { stop_reason: "end", usage: { input_tokens: 10, output_tokens: 5, cost_usd: 0.01 }, ...s };
    },
  };
}

/** The server's deps with the registry's chat capabilities; `llm` null: no Ask model configured. */
async function setup(llm: LLMProvider | null) {
  const clock = new FakeClock("2026-11-26T09:00:00.000Z");
  const { store } = await newStore(clock);
  const pauses: UiPauses = { principal: async () => "local:owner@example.com" as UserId, authorize: async () => ({ allow: true }), csrfToken: newCsrfToken(), log: silent };
  const settings = { ask: { llm, log: silent } } as unknown as UiSettings;
  const d: PauseDeps = { store, scanner: new PatternEgressScanner(async () => []), clock, lease_ms: 300_000, health: new HealthMonitor(async () => [], clock), pauses, settings };
  const send = async (body: unknown) => {
    const r = await respond(d, { method: "POST", url: "/api/v1/chat/send", host: HOST, origin: `http://${HOST}`, contentType: "application/json", csrfToken: pauses.csrfToken, body: JSON.stringify(body) });
    return { status: r.status, value: JSON.parse(r.body) };
  };
  const get = async (url: string) => {
    const r = await respond(d, { method: "GET", url, host: HOST });
    return { status: r.status, value: JSON.parse(r.body) };
  };
  const turns = (): Promise<ChatTurnRecord[]> => store.listChatTurns(1000);
  return { store, clock, send, get, turns };
}

describe("the chat declarations", () => {
  it("declares chat.send, chat.transcript and chat.turns, owner-only with schemas and a description, listed in src/api/index.ts", () => {
    const ids = ["chat.send", "chat.transcript", "chat.turns"];
    expect(CHAT.map((c) => c.id)).toEqual(ids);
    for (const c of CHAT) {
      expect(c.permission).toBe("owner");
      expect(c.description.length).toBeGreaterThan(0);
      expect(c.input.json()).toMatchObject({ type: "object" });
      expect(c.output.json()).toMatchObject({ type: "object" });
      expect(DECLARATIONS).toContain(c);
    }
    expect(CHAT.find((c) => c.id === "chat.send")!.method).toBe("POST");
  });
});

describe("chat.send", () => {
  it("with no session_id starts a new session and answers its turn id, session id, outcome and reply; the row ends answered", async () => {
    const seenStatus: string[] = [];
    let probe: () => Promise<ChatTurnRecord[]> = async () => [];
    const llm = scripted([{ text: "One area: chat." }], async () => {
      seenStatus.push(...(await probe()).map((t) => t.status));
    });
    const { send, turns } = await setup(llm);
    probe = turns;
    const r = await send({ text: "What can you do?" });
    expect(r.status).toBe(200);
    expect(r.value).toEqual({ turn_id: expect.stringMatching(/^ct_[0-9a-f-]{36}$/), session_id: expect.stringMatching(/^cs_[0-9a-f-]{36}$/), outcome: "answered", reply: "One area: chat." });
    // Running while the model was called, answered after.
    expect(seenStatus).toEqual(["running"]);
    const rows = await turns();
    expect(rows).toEqual([{ turn_id: r.value.turn_id, session_id: r.value.session_id, status: "answered", reason: null, created_at: "2026-11-26T09:00:00.000Z", finished_at: "2026-11-26T09:00:00.000Z" }]);
  });

  it("keeps a given session, and the spend row uses the turn's own id", async () => {
    const { send, store } = await setup(scripted([{ text: "First." }, { text: "Second." }]));
    const first = await send({ text: "Hi" });
    const second = await send({ session_id: first.value.session_id, text: "Again" });
    expect(second.value).toMatchObject({ session_id: first.value.session_id, outcome: "answered", reply: "Second." });
    expect(second.value.turn_id).not.toBe(first.value.turn_id);
    const spend = await store.listChatSpendBetween("2026-11-26", "2026-11-26");
    expect(spend.map((s) => s.turn_id)).toEqual(expect.arrayContaining([first.value.turn_id, second.value.turn_id]));
  });

  it("answers refused with no reply text when the turn is withheld; the row ends refused, reason withheld", async () => {
    const { send, turns } = await setup(scripted([{ text: `Here: ${SECRET}` }]));
    const r = await send({ text: "Tell me." });
    expect(r.status).toBe(200);
    expect(r.value).toMatchObject({ outcome: "refused", reason: "withheld" });
    expect(r.value).not.toHaveProperty("reply");
    expect(JSON.stringify(r.value)).not.toContain(SECRET);
    expect(await turns()).toEqual([expect.objectContaining({ turn_id: r.value.turn_id, status: "refused", reason: "withheld" })]);
  });

  it("refuses a tool call to an unknown or write tool without running it, and still answers", async () => {
    const llm = scripted([{ text: "", tool_calls: [{ id: "c1", name: "git.store_branch", arguments: "{}" }] }, { text: "I cannot." }]);
    const { send } = await setup(llm);
    const r = await send({ text: "Push it." });
    expect(r.value).toMatchObject({ outcome: "answered", reply: "I cannot." });
    expect(llm.seen[0]!.tools!.map((t) => t.name)).not.toContain("git.store_branch");
    expect(llm.seen[1]!.messages.find((m) => m.tool_call_id === "c1")!.content).toMatch(/not a read-only tool/);
  });

  it("answers failed with the turn's reason on a provider error or too many steps", async () => {
    const { send, turns } = await setup(scripted([{ text: "", stop_reason: "error" }]));
    const r = await send({ text: "Hi" });
    expect(r.value).toMatchObject({ outcome: "failed", reason: "model_error" });
    expect(r.value).not.toHaveProperty("reply");
    expect(await turns()).toEqual([expect.objectContaining({ status: "failed", reason: "model_error", finished_at: expect.any(String) })]);
  });

  it("a thrown error answers failed, reason error, and leaves the row failed, never running", async () => {
    const llm: LLMProvider = { complete: async () => { throw new Error("boom"); } };
    const { send, turns } = await setup(llm);
    const r = await send({ text: "Hi" });
    expect(r.status).toBe(200);
    expect(r.value).toMatchObject({ outcome: "failed", reason: "error" });
    const rows = await turns();
    expect(rows).toEqual([expect.objectContaining({ turn_id: r.value.turn_id, status: "failed", reason: "error" })]);
    expect(rows.map((t) => t.status)).not.toContain("running");
  });

  it("answers the provider's words as detail on a failed model call, and a thrown error's message when the scan finds nothing", async () => {
    const { send } = await setup(scripted([{ text: "claude-cli: Not logged in · Please run /login", stop_reason: "error" }]));
    expect((await send({ text: "Hi" })).value).toMatchObject({ outcome: "failed", reason: "model_error", detail: "claude-cli: Not logged in · Please run /login" });
    const thrown = await setup({ complete: async () => { throw new Error("every LLM provider failed: claude-cli: spawn claude ENOENT"); } });
    expect((await thrown.send({ text: "Hi" })).value).toMatchObject({ outcome: "failed", reason: "error", detail: "every LLM provider failed: claude-cli: spawn claude ENOENT" });
    const leaky = await setup({ complete: async () => { throw new Error(`bad token ${SECRET}`); } });
    const r = await leaky.send({ text: "Hi" });
    expect(r.value).toMatchObject({ outcome: "failed", reason: "error" });
    expect(r.value).not.toHaveProperty("detail");
  });

  it("with no Ask model configured refuses and stores no turn row", async () => {
    const { send, turns, store } = await setup(null);
    const r = await send({ text: "Hi" });
    expect(r.status).toBe(503);
    expect(r.value.error).toMatch(/no model/);
    expect(await turns()).toEqual([]);
    expect(await store.listChatSpendBetween("2026-01-01", "2026-12-31")).toEqual([]);
  });
});

describe("chat.transcript and chat.turns", () => {
  it("chat.transcript answers a session's messages in order, none for an unknown session, and writes no row", async () => {
    const { send, get, turns } = await setup(scripted([{ text: "Hello." }]));
    const sent = await send({ text: "Hi" });
    const before = await turns();
    const t = await get(`/api/v1/chat/transcript?session_id=${sent.value.session_id}`);
    expect(t.status).toBe(200);
    expect(t.value.messages.map((m: { role: string; content: string }) => [m.role, m.content])).toEqual([["user", "Hi"], ["assistant", "Hello."]]);
    expect((await get("/api/v1/chat/transcript?session_id=cs_none")).value).toEqual({ messages: [] });
    await get("/api/v1/chat/turns");
    expect(await turns()).toEqual(before);
  });

  it("chat.turns lists turns newest first, at most limit, each with its id, session, status, reason and times", async () => {
    const { send, get, clock } = await setup(scripted([{ text: "a" }, { text: "", stop_reason: "error" }, { text: "c" }]));
    const ids: string[] = [];
    for (const text of ["one", "two", "three"]) {
      ids.push((await send({ text })).value.turn_id);
      clock.advance(1000);
    }
    const all = await get("/api/v1/chat/turns");
    expect(all.status).toBe(200);
    expect(all.value.turns.map((t: ChatTurnRecord) => t.turn_id)).toEqual([...ids].reverse());
    expect(all.value.turns[1]).toEqual({ turn_id: ids[1], session_id: expect.stringMatching(/^cs_/), status: "failed", reason: "model_error", created_at: "2026-11-26T09:00:01.000Z", finished_at: "2026-11-26T09:00:01.000Z" });
    expect(all.value.turns[0]).toMatchObject({ status: "answered", reason: null });
    const two = await get("/api/v1/chat/turns?limit=2");
    expect(two.value.turns.map((t: ChatTurnRecord) => t.turn_id)).toEqual([ids[2], ids[1]]);
  });

  it("chat.turns defaults to at most CHAT_TURNS_LIMIT turns", async () => {
    const { store, get } = await setup(null);
    for (let i = 0; i < CHAT_TURNS_LIMIT + 1; i++) await store.startChatTurn(`ct_${i}`, "cs_1");
    expect((await get("/api/v1/chat/turns")).value.turns.length).toBe(CHAT_TURNS_LIMIT);
  });
});

describe("the chat turn store", () => {
  it("starts a turn once and ends only a running turn", async () => {
    const { store } = await setup(null);
    expect(await store.startChatTurn("ct_1", "cs_1")).toBe(true);
    expect(await store.startChatTurn("ct_1", "cs_2")).toBe(false);
    expect(await store.finishChatTurn("ct_1", "answered", null)).toBe(true);
    expect(await store.finishChatTurn("ct_1", "failed", "error")).toBe(false);
    expect(await store.finishChatTurn("ct_none", "failed", "error")).toBe(false);
    expect(await store.listChatTurns(10)).toEqual([expect.objectContaining({ turn_id: "ct_1", session_id: "cs_1", status: "answered", reason: null })]);
  });
});
