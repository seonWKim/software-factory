import { describe, expect, it } from "vitest";
import { commandFooter } from "../src/core/commands.js";
import { ControllerRole } from "../src/runtime/roles/controller-role.js";
import type { WorkItem, WorkItemPatch } from "../src/core/types.js";
import type { LLMProvider, LLMRequest, LLMResponse } from "../src/interfaces/llm-provider.js";
import type { SourceEvent } from "../src/interfaces/source-adapter.js";
import { FakeAuth, FakeSource, alice, cleanScanner, config, issueRef, mallory, silent } from "./helpers/fakes.js";
import { newStore, PROJECT_KEY } from "./helpers/store.js";

// The plain-comment interpreter (design §4, issue #583): one model call over the message and the open items, then
// one plain-text reply that proposes typed commands, answers a read, or asks one question. Nothing is applied.

/** Answers each call with the next scripted reply (the last one repeats) and records every request. */
class ScriptedLLM implements LLMProvider {
  requests: LLMRequest[] = [];
  constructor(private readonly replies: Partial<LLMResponse>[]) {}
  async complete(req: LLMRequest): Promise<LLMResponse> {
    this.requests.push(req);
    const r = this.replies[Math.min(this.requests.length - 1, this.replies.length - 1)] ?? {};
    return { text: "", stop_reason: "end", usage: { input_tokens: 1, output_tokens: 1, cost_usd: null }, ...r };
  }
}

type Entry = { item: string; command?: string; args?: string };
const answer = (kind: string, entries: Entry[] = []): Partial<LLMResponse> => {
  const parsed = { kind, entries: entries.map((e) => ({ item: e.item, command: e.command ?? "", args: e.args ?? "" })) };
  return { text: JSON.stringify(parsed), parsed };
};

const SPEC_PENDING: WorkItemPatch = { stage: "READY", blocked_on: "human", blocked_reason: "spec_pending", tier: 2 };
const NUMBERS = [566, 567, 568] as const;

async function setup(replies: Partial<LLMResponse>[]) {
  const { store, clock } = await newStore();
  const source = new FakeSource();
  const llm = new ScriptedLLM(replies);
  const controller = new ControllerRole({ store, source, auth: new FakeAuth(), clock, config, log: silent, scanner: cleanScanner, llm });
  const actor = { kind: "system" as const, id: "test" };
  const items: WorkItem[] = [];
  for (const n of NUMBERS) {
    const { item } = await store.createWorkItem(
      { source: issueRef(n), requester_id: "github:1" as never, project: PROJECT_KEY, problem: `secret problem ${n}`, title: `Title ${n}`, resources: [] },
      actor,
    );
    const r = await store.transition({ id: item.id, expected_version: item.version, actor, reason: "setup", patch: SPEC_PENDING });
    if (!r.ok) throw new Error("setup failed");
    items.push(r.item);
  }
  const { item: closed } = await store.createWorkItem({ source: issueRef(999), requester_id: "github:1" as never, project: PROJECT_KEY, problem: "p", title: "Closed one", resources: [] }, actor);
  const c = await store.transition({ id: closed.id, expected_version: closed.version, actor, reason: "setup", patch: { stage: "CLOSED", close_reason: "rejected" } });
  if (!c.ok) throw new Error("setup failed");

  const snapshot = async () => Promise.all(items.map(async (it) => {
    const now = (await store.getWorkItem(it.id))!;
    return { stage: now.stage, blocked_reason: now.blocked_reason, version: now.version, changes: (await store.listStateChanges(it.id)).length, runs: (await store.listRuns(it.id)).length };
  }));
  return { store, source, llm, controller, items, snapshot };
}

const plain = (body: string, comment_id = "100", author = alice, n = 566): SourceEvent => ({
  kind: "plain_comment", source: issueRef(n), comment_id, author, body,
});

describe("interpreter: plain comments", () => {
  it("approving #566, #567 with a note and #568 proposes three commands, one per item, as typed lines", async () => {
    const f = await setup([answer("commands", [
      { item: "566", command: "approve" },
      { item: "#567", command: "approve", args: "keep the old flag" },
      { item: "568", command: "approve" },
    ])]);
    await f.controller.handleEvent(plain("approve 566, approve 567 but keep the old flag, and approve 568"));
    expect(f.source.comments).toHaveLength(1);
    const body = f.source.comments[0]!.body;
    expect(body).toMatch(/^The factory read 3 commands in your message\. Nothing has changed\./);
    const at = (s: string) => body.indexOf(s);
    expect(at("**o/r#566** Title 566")).toBeGreaterThan(-1);
    expect(at("**o/r#566** Title 566")).toBeLessThan(at("```\n/approve\n```"));
    expect(at("**o/r#567** Title 567")).toBeLessThan(at("```\n/approve keep the old flag\n```"));
    expect(at("**o/r#567**")).toBeGreaterThan(at("**o/r#566**"));
    expect(at("**o/r#568**")).toBeGreaterThan(at("**o/r#567**"));
    expect(body.split("```\n/approve\n```").length - 1).toBe(2);
  });

  it("'show 566' gets a direct answer and proposes no command", async () => {
    const f = await setup([answer("show", [{ item: "566" }])]);
    await f.controller.handleEvent(plain("show 566"));
    expect(f.source.comments).toHaveLength(1);
    const body = f.source.comments[0]!.body;
    expect(body).toContain("**o/r#566** Title 566");
    expect(body).toContain("waiting");
    expect(body).toContain(issueRef(566).link);
    expect(body).not.toMatch(/\/approve|\/reject|\/revise|```/);
  });

  it("an unclear message gets one question listing its readings, and no command", async () => {
    const f = await setup([answer("question", [
      { item: "566", command: "approve" },
      { item: "566", command: "reject", args: "not needed" },
    ])]);
    await f.controller.handleEvent(plain("do the thing with 566"));
    expect(f.source.comments).toHaveLength(1);
    const body = f.source.comments[0]!.body;
    expect(body.split("?").length - 1).toBe(1);
    expect(body).toMatch(/could mean more than one thing.*Which did you mean\?/);
    expect(body).toContain("```\n/approve\n```");
    expect(body).toContain("```\n/reject not needed\n```");
    expect(body).not.toContain("The factory read");
  });

  it("a message from a non-owner gets no proposal and makes no model call", async () => {
    const f = await setup([answer("commands", [{ item: "566", command: "approve" }])]);
    await f.controller.handleEvent(plain("approve 566", "100", mallory));
    expect(f.llm.requests).toHaveLength(0);
    expect(f.source.comments).toHaveLength(0);
  });

  it("the model input holds only the message and the open items (ID, number, title, state); its output is never applied", async () => {
    const f = await setup([answer("commands", NUMBERS.map((n) => ({ item: String(n), command: "approve" })))]);
    const before = await f.snapshot();
    const text = "approve all three";
    await f.controller.handleEvent(plain(text));
    expect(f.llm.requests).toHaveLength(1);
    const req = f.llm.requests[0]!;
    expect(req.model_class).toBe("cheap");
    expect(req.data_env).toBe("test");
    expect(req.messages).toHaveLength(1);
    const user = req.messages[0]!.content;
    expect(user.split(text).length - 1).toBe(1);
    expect(req.system).not.toContain(text);
    const list = JSON.parse(/```json\n(.*)\n```/.exec(user)![1]!) as Record<string, unknown>[];
    expect(list.map((it) => Object.keys(it).sort())).toEqual(f.items.map(() => ["id", "number", "state", "title"]));
    expect(list.map((it) => [it.id, it.number, it.title]).sort((a, b) => Number(a[1]) - Number(b[1]))).toEqual(f.items.map((it, i) => [it.id, NUMBERS[i], `Title ${NUMBERS[i]}`]));
    expect(user).not.toContain("Closed one");
    expect(user).not.toContain("secret problem");
    expect(await f.snapshot()).toEqual(before);
  });

  it("a message that fails the egress scan makes no model call, stores nothing and posts nothing", async () => {
    const f = await setup([answer("commands", [{ item: "566", command: "approve" }])]);
    const before = await f.snapshot();
    await f.controller.handleEvent(plain(`approve 566, token ghp_${"a".repeat(36)}`));
    expect(f.llm.requests).toHaveLength(0);
    expect(f.source.comments).toHaveLength(0);
    expect(await f.snapshot()).toEqual(before);
  });

  it("a proposed argument that fails the egress scan stores nothing and posts nothing", async () => {
    const secret = `ghp_${"a".repeat(36)}`;
    const f = await setup([answer("commands", [{ item: "566", command: "approve" }, { item: "567", command: "revise", args: `use ${secret}` }])]);
    const before = await f.snapshot();
    await f.controller.handleEvent(plain("approve 566 and revise 567 with my token"));
    expect(f.llm.requests).toHaveLength(1);
    expect(f.source.comments).toHaveLength(0);
    expect(await f.snapshot()).toEqual(before);
  });

  it("the reply is one comment keyed on the triggering comment id; a redelivery posts no second reply", async () => {
    const f = await setup([answer("commands", [{ item: "566", command: "approve" }])]);
    await f.controller.handleEvent(plain("approve 566", "200"));
    await f.controller.handleEvent(plain("approve 566", "200"));
    expect(f.source.comments).toHaveLength(1);
    expect(f.source.comments[0]!.marker).toBe("<!-- factory:suggest:200 -->");
  });

  it("entries for unlisted items or commands that do not apply are dropped; none left gives the command list", async () => {
    const f = await setup([answer("commands", [{ item: "999", command: "approve" }, { item: "566", command: "retry" }, { item: "567", command: "verdict", args: "accept" }])]);
    await f.controller.handleEvent(plain("retry 566"));
    expect(f.source.comments).toHaveLength(1);
    const body = f.source.comments[0]!.body;
    expect(body).toContain("did not find a command");
    expect(body).toContain(commandFooter({ phase: "spec_pending", has_pr: false }));
  });
});
