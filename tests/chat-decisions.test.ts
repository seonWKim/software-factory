// A Needs-you decision in the chat (design 04-chat-commands, 09-dashboard-chat): chat.decision reads the decision of
// the item the chat is opened on, chat.command sends a button, a reply (sentence) or a proposal's Confirm all and
// Cancel through the item commands route's own path (itemCommandSend), and chat.mode reads the stored
// permission_mode. Through respond() with the store, a FakeSource and a scripted model; no live model call.

import { describe, expect, it } from "vitest";
import { decisionOf } from "../src/api/capabilities/chat.js";
import { OwnerAuth } from "../src/core/authorize.js";
import type { UserId, WorkItem, WorkItemPatch } from "../src/core/types.js";
import type { LLMProvider, LLMRequest, LLMResponse } from "../src/interfaces/llm-provider.js";
import { ControllerRole } from "../src/runtime/roles/controller-role.js";
import { HealthMonitor } from "../src/ui/health.js";
import type { UiPauses } from "../src/ui/pause-api.js";
import { type PauseDeps, respond } from "../src/ui/server.js";
import { newCsrfToken } from "../src/ui/settings-api.js";
import { classifierAnswer } from "./helpers/classifier.js";
import { cleanScanner, config, issueRef, silent } from "./helpers/fakes/config.js";
import { FakeSource } from "./helpers/fakes/source.js";
import { PROJECT_KEY, newStore } from "./helpers/store.js";
// TS6142: tsconfig.test.json has no JSX, so this .tsx view stays untyped here; web/tsconfig.json checks it.
// @ts-expect-error -- see above
import { resultOf } from "../web/src/views/chat-decision.js";

const HOST = "127.0.0.1:4310";
const TOKEN = newCsrfToken();
const OWNER = "local:owner@example.com" as UserId;
const SPEC_PENDING: WorkItemPatch = { stage: "READY", blocked_on: "human", blocked_reason: "spec_pending" };

/** Proposes `/approve ship it` on the first open item for any message; counts its calls. */
class ApproveLLM implements LLMProvider {
  calls = 0;
  async complete(req: LLMRequest): Promise<LLMResponse> {
    const label = classifierAnswer(req);
    if (label) return label;
    this.calls++;
    const id = /"id":"([^"]+)"/.exec(req.messages[0]!.content)?.[1] ?? "";
    const parsed = { kind: "commands", entries: [{ item: id, command: "approve", args: "ship it" }] };
    return { text: JSON.stringify(parsed), parsed, stop_reason: "end", usage: { input_tokens: 1, output_tokens: 1, cost_usd: null } };
  }
}

async function setup() {
  const { store, clock } = await newStore();
  const source = new FakeSource();
  const llm = new ApproveLLM();
  const controller = new ControllerRole({ store, source, auth: new OwnerAuth(store), clock, config, log: silent, scanner: cleanScanner, llm });
  await store.claimOwner(OWNER);
  const system = { kind: "system" as const, id: "system:test" };
  const itemIn = async (patch: WorkItemPatch, n: number): Promise<WorkItem> => {
    const { item } = await store.createWorkItem({ source: issueRef(n), requester_id: OWNER, project: PROJECT_KEY, problem: "p", resources: [] }, system);
    const r = await store.transition({ id: item.id, expected_version: item.version, actor: system, reason: "setup", patch: { ...patch, tier: 2 } });
    if (!r.ok) throw new Error("setup");
    return r.item;
  };
  const pauses: UiPauses = { principal: async () => OWNER, authorize: async () => ({ allow: true }), csrfToken: TOKEN, log: silent };
  const d: PauseDeps = {
    store, scanner: cleanScanner, clock, lease_ms: 60_000, health: new HealthMonitor(async () => [], clock), pauses,
    commands: { actor: OWNER, source: "environment", token: TOKEN },
  };
  const post = (url: string, body: unknown) =>
    respond(d, { method: "POST", url, host: HOST, origin: `http://${HOST}`, contentType: "application/json", csrfToken: TOKEN, body: JSON.stringify(body) });
  const get = async (url: string) => {
    const r = await respond(d, { method: "GET", url, host: HOST });
    return { status: r.status, value: JSON.parse(r.body) as Record<string, unknown> };
  };
  const chat = (item: WorkItem, body: Record<string, unknown>) => post("/api/v1/chat/command", { item: item.id, ...body });
  const decision = async (item: WorkItem) => (await get(`/api/v1/chat/decision?item=${encodeURIComponent(item.id)}`)).value as {
    waiting: boolean; why: { reason_code: string }; commands: { name: string; allowed: boolean }[]; proposals: { id: string; lines: string[] }[];
  };
  /** What an item's state and history look like, minus ids and times. */
  const shape = async (it: WorkItem) => ({
    item: await store.getWorkItem(it.id).then((x) => ({ stage: x!.stage, blocked_on: x!.blocked_on, blocked_reason: x!.blocked_reason })),
    changes: (await store.listStateChanges(it.id)).slice(2).map((c) => ({ reason: c.reason, actor: c.actor, changes: c.changes })),
    runs: (await store.listRuns(it.id)).map((r) => ({ kind: r.kind, status: r.status })),
  });
  return { store, source, llm, controller, itemIn, post, get, chat, decision, shape };
}

describe("chat.decision", () => {
  it("shows a spec waiting for approval as a decision: the owner is next, its why and its commands with Approve allowed", async () => {
    const h = await setup();
    const it = await h.itemIn(SPEC_PENDING, 1);
    const d = await h.decision(it);
    expect(d.waiting).toBe(true);
    expect(d.why.reason_code).toBe("spec_pending");
    expect(d.commands.find((c) => c.name === "approve")).toMatchObject({ allowed: true });
    expect(d.proposals).toEqual([]);
  });

  it("is not a decision once nobody is waited on (a merged item), and an unknown item is a 404", async () => {
    const h = await setup();
    const done = await h.itemIn({ stage: "CLOSED", close_reason: "completed", merge_sha: "abc1234" }, 2);
    expect((await h.decision(done)).waiting).toBe(false);
    expect((await h.get("/api/v1/chat/decision?item=wi_missing")).status).toBe(404);
  });

  it("takes the newest factory message that is not a refusal as the evidence, and In short from the waiting spec", () => {
    const d = decisionOf({
      item: { title: "T", why: { next_actor: "human", reason_code: "spec_pending" } },
      thread: [
        { role: "factory", kind: "spec", body: "older spec" },
        { role: "factory", kind: "status", body: "newest status" },
        { role: "owner", kind: "approve", body: "/approve" },
        { role: "factory", kind: "refused", body: "`/approve` was not applied: no" },
      ],
      commands: [], spec: { in_short: "AS-IS → TO-BE" }, proposals: [{ id: "prop_1", commands: [{ line: "/approve ship it" }] }],
    });
    expect(d).toMatchObject({ waiting: true, evidence: "newest status", in_short: "AS-IS → TO-BE", proposals: [{ id: "prop_1", lines: ["/approve ship it"] }] });
  });
});

describe("chat.command", () => {
  it("a button press sends the typed command's request: the item changes exactly as the item page's Approve changes it", async () => {
    const h = await setup();
    const fromChat = await h.itemIn(SPEC_PENDING, 3);
    const fromPage = await h.itemIn(SPEC_PENDING, 4);
    expect((await h.chat(fromChat, { command: "approve" })).status).toBe(200);
    expect((await h.post(`/api/v1/items/${encodeURIComponent(fromPage.id)}/commands`, { command: "approve" })).status).toBe(202);
    await h.controller.tickCommands();
    const [a, b] = [await h.shape(fromChat), await h.shape(fromPage)];
    expect(a.item.stage).toBe("RUNNING");
    expect(a).toEqual(b);
    expect((await h.store.listAppCommandRequestsForItem(fromChat.id, 10)).map((r) => [r.command, r.actor, r.args])).toEqual([["approve", OWNER, { work_item_id: fromChat.id }]]);
  });

  it("refuses what the item commands route refuses, before any write: an unknown command and a reject without its reason", async () => {
    const h = await setup();
    const it = await h.itemIn(SPEC_PENDING, 5);
    expect((await h.chat(it, { command: "launch" })).status).toBe(400);
    const reject = await h.chat(it, { command: "reject" });
    expect(reject.status).toBe(400);
    expect(JSON.parse(reject.body).error).toMatch(/reject needs text/);
    expect(await h.store.listAppCommandRequestsForItem(it.id, 10)).toEqual([]);
  });

  it("a reply is read as a plain comment into pending proposals; nothing applies until Confirm all, which applies it once", async () => {
    const h = await setup();
    const it = await h.itemIn(SPEC_PENDING, 6);
    const before = await h.store.getWorkItem(it.id);
    expect((await h.chat(it, { command: "sentence", note: "looks good, ship it" })).status).toBe(200);
    await h.controller.tickCommands();
    expect(h.llm.calls).toBe(1);
    const [p] = (await h.decision(it)).proposals;
    expect(p!.lines).toEqual(["/approve ship it"]);
    expect(await h.store.getWorkItem(it.id)).toEqual(before);

    expect((await h.chat(it, { command: "proposal_confirm", proposal: p!.id })).status).toBe(200);
    await h.controller.tickCommands();
    expect((await h.store.getWorkItem(it.id))!.stage).toBe("RUNNING");
    expect((await h.store.listCommandProposals(p!.id)).map((r) => [r.status, r.answered_by])).toEqual([["applied", OWNER]]);
    expect((await h.decision(it)).proposals).toEqual([]);
  });

  it("Cancel marks the proposal cancelled and applies nothing", async () => {
    const h = await setup();
    const it = await h.itemIn(SPEC_PENDING, 7);
    await h.chat(it, { command: "sentence", note: "ship it" });
    await h.controller.tickCommands();
    const [p] = (await h.decision(it)).proposals;
    const before = await h.store.getWorkItem(it.id);
    expect((await h.chat(it, { command: "proposal_cancel", proposal: p!.id })).status).toBe(200);
    await h.controller.tickCommands();
    expect((await h.store.listCommandProposals(p!.id)).map((r) => r.status)).toEqual(["cancelled"]);
    expect((await h.store.getWorkItem(it.id))!.stage).toBe(before!.stage);
    expect((await h.decision(it)).proposals).toEqual([]);
  });
});

describe("the chat decision's result line", () => {
  it("an Approve the owner check refuses reads as a refusal (Notice), not as sent; an applied one as done; a 400 as its error", () => {
    expect(resultOf({ ok: true, status: 200, value: { outcome: "refused", refusal: "`/approve` was not applied: only the owner may send this command" } })).toHaveProperty("refusal");
    expect(resultOf({ ok: true, status: 200, value: { outcome: "applied", refusal: null } })).toEqual({ outcome: { tone: "status", text: "Done" } });
    expect(resultOf({ ok: true, status: 200, value: {} })).toEqual({ outcome: { tone: "status", text: "sent" } });
    expect(resultOf({ ok: false, status: 400, value: { error: "reject needs text: your reason" } })).toEqual({ refusal: expect.stringContaining("reject needs text") });
  });
});

describe("chat.mode", () => {
  it("reads the default ask_irreversible with nothing stored, then the stored owner setting", async () => {
    const h = await setup();
    expect((await h.get("/api/v1/chat/mode")).value).toEqual({ mode: "ask_irreversible" });
    await h.store.setSettingOverride({ key: "permission_mode", project: "", value: '"ask_all"', actor: OWNER });
    expect((await h.get("/api/v1/chat/mode")).value).toEqual({ mode: "ask_all" });
  });
});
