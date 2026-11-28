// The chat adds a task (design 04-chat-agent, 08-permissions): `add a task: <words>` makes the model call add_task,
// the one write a chat turn makes. The task is `tk_<turn id>`, so the same turn sent again adds nothing; the write
// goes through permissionGate (ask_all holds it, ask_irreversible and full run it) and its row records origin agent
// and the mode. Every other command asked from a chat turn stays refused in every mode. No live model: a scripted one.

import { describe, expect, it } from "vitest";
import { readFeatureMap } from "../src/api/feature-map.js";
import { buildRegistry } from "../src/api/registry.js";
import { AGENT_WRITE_IN_CHAT, authorizeWrite, permissionGate } from "../src/core/authorize.js";
import { CHAT_SYSTEM, type ChatDeps, chatTurn } from "../src/core/chat-agent.js";
import { ChatToolBroker, chatCallContext, featureMapTools } from "../src/core/chat-agent-tools.js";
import { COMMAND_TABLE } from "../src/core/command-table.js";
import type { UserId } from "../src/core/types.js";
import { PERMISSION_MODES } from "../src/controller/settings/permission-mode.setting.js";
import { FakeClock } from "../src/impl/clock/fake-clock.js";
import { PatternEgressScanner } from "../src/impl/egress/pattern-egress-scanner.js";
import type { LLMProvider, LLMRequest, LLMResponse } from "../src/interfaces/llm-provider.js";
import { newStore } from "./helpers/store.js";

type Mode = (typeof PERMISSION_MODES)[number];
type Step = Pick<LLMResponse, "text" | "tool_calls">;
const scanner = new PatternEgressScanner(async () => []);
const broker = () => new ChatToolBroker(featureMapTools((p) => readFeatureMap(buildRegistry([]), p)));
const WORDS = "call the bank tomorrow !1";
const TITLE = "call the bank";

/** A model that, asked `add a task: <words>`, calls add_task with the words, then answers `reply`. */
function adder(reply: string): LLMProvider & { seen: LLMRequest[] } {
  const seen: LLMRequest[] = [];
  return {
    seen,
    async complete(req) {
      seen.push(req);
      const asked = req.messages.filter((m) => m.role === "user").at(-1)!.content.replace(/^add a task:\s*/, "");
      const step: Step = req.messages.at(-1)!.role === "tool"
        ? { text: reply }
        : { text: "", tool_calls: [{ id: `c_${seen.length}`, name: "add_task", arguments: JSON.stringify({ words: asked }) }] };
      return { stop_reason: "end", usage: { input_tokens: 1, output_tokens: 1, cost_usd: 0 }, ...step };
    },
  };
}

async function setup(mode: Mode | null, turnIds: () => string) {
  const { store } = await newStore(new FakeClock("2026-11-28T09:00:00.000Z"));
  if (mode) await store.setSettingOverride({ key: "permission_mode", project: "", value: JSON.stringify(mode), actor: "local:owner" });
  const deps = (llm: LLMProvider): ChatDeps => ({ store, llm, broker: broker(), scanner, clock: new FakeClock("2026-11-28T09:00:00.000Z"), newTurnId: turnIds });
  return { store, deps };
}

const counter = () => { let n = 0; return () => `ct_${++n}`; };

describe("add a task: <words> in the chat", () => {
  it("adds exactly one task with the parsed title, and the reply names its id and title", async () => {
    const { store, deps } = await setup(null, counter());
    const llm = adder("Done.");
    const r = await chatTurn(deps(llm), "s1", `add a task: ${WORDS}`);
    expect(llm.seen[0]!.tools!.map((t) => t.name)).toContain("add_task");
    const tasks = await store.listTasks(100);
    expect(tasks.map((t) => [t.id, t.title, t.priority])).toEqual([["tk_ct_1", TITLE, 1]]);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.reply).toContain("tk_ct_1");
      expect(r.reply).toContain(TITLE);
    }
  });

  it("a reply that already names the task is kept as the model wrote it", async () => {
    const { deps } = await setup("full", counter());
    expect(await chatTurn(deps(adder(`Added tk_ct_1: ${TITLE}.`)), "s1", `add a task: ${WORDS}`)).toEqual({ ok: true, reply: `Added tk_ct_1: ${TITLE}.` });
  });

  it("the same chat turn sent again adds no second task: the task id is tk_ plus the turn's id", async () => {
    const { store, deps } = await setup("full", () => "ct_same");
    for (const session of ["s1", "s2"]) {
      const r = await chatTurn(deps(adder("Done.")), session, `add a task: ${WORDS}`);
      expect(r.ok && r.reply).toContain("tk_ct_same");
    }
    expect((await store.listTasks(100)).map((t) => t.id)).toEqual(["tk_ct_same"]);
    expect((await store.listCliCommandsAfter(0, 100)).filter((c) => c.key === "tk_ct_same")).toHaveLength(1);
  });
});

describe("the chat's system prompt", () => {
  // core/ is forge-neutral (tests/boundaries.test.ts): the forge is GitHub when the GitHub plugin is on.
  it("offers adding a task for work, never filing a GitHub (forge) or factory issue", () => {
    expect(CHAT_SYSTEM).toMatch(/offer to add a task, never to file an issue, on the forge or in the factory/);
    expect(CHAT_SYSTEM).toContain("add_task");
    expect(CHAT_SYSTEM.replace(/never to file an issue, on the forge or in the factory/, "")).not.toMatch(/\bissue\b/i);
  });
});

describe("the chat's add through permissionGate", () => {
  it("ask_all holds it: no task, one held write for confirm, with origin agent and the mode; the reply names no task", async () => {
    const { store, deps } = await setup("ask_all", counter());
    const llm = adder("It waits for your confirm.");
    const r = await chatTurn(deps(llm), "s1", `add a task: ${WORDS}`);
    expect(await store.listTasks(100)).toEqual([]);
    const held = await store.listHeldWrites(10);
    expect(held.map((h) => [h.key, h.command, h.args, h.write_origin, h.mode, h.status])).toEqual([["tk_ct_1", "task add", [WORDS], "agent", "ask_all", "pending"]]);
    const tool = JSON.parse(llm.seen[1]!.messages.find((m) => m.role === "tool")!.content) as { outcome: string; held_write: string };
    expect(tool).toMatchObject({ outcome: "held", held_write: held[0]!.id });
    expect(r).toEqual({ ok: true, reply: "It waits for your confirm." });
  });

  it.each(["ask_irreversible", "full"] as const)("%s runs it at once (task add is reversible) and its row records origin agent and the mode", async (mode) => {
    const { store, deps } = await setup(mode, counter());
    await chatTurn(deps(adder("Done.")), "s1", `add a task: ${WORDS}`);
    expect((await store.listTasks(100)).map((t) => t.id)).toEqual(["tk_ct_1"]);
    expect(await store.listHeldWrites(10)).toEqual([]);
    const row = (await store.listCliCommandsAfter(0, 100)).find((c) => c.key === "tk_ct_1");
    expect(row).toMatchObject({ command: "task add", write_origin: "agent", permission_mode: mode, args: { argv: [WORDS] } });
  });
});

describe("any other command from a chat turn", () => {
  it("is refused by the gate in every mode (agent_write_in_chat), with or without the add_task tool's name", () => {
    for (const mode of PERMISSION_MODES) {
      for (const c of COMMAND_TABLE.filter((x) => x.name !== "task add")) {
        for (const chat_tool of [undefined, "add_task", c.name.replaceAll(" ", "_")]) {
          const gate = permissionGate({ mode, reversible: c.reversible, origin: "agent", in_chat_turn: true, command: c.name, ...(chat_tool && { chat_tool }) });
          expect(gate, `${mode} ${c.name} ${chat_tool}`).toEqual({ outcome: "refuse", reason: AGENT_WRITE_IN_CHAT });
        }
      }
      // task add itself passes only as the add_task tool.
      expect(permissionGate({ mode, reversible: true, origin: "agent", in_chat_turn: true, command: "task add" })).toEqual({ outcome: "refuse", reason: AGENT_WRITE_IN_CHAT });
    }
  });

  it.each(PERMISSION_MODES)("%s: authorizeWrite refuses it and stores nothing; the broker refuses a tool call naming it", async (mode) => {
    const { store } = await setup(mode, counter());
    const actor = "service:chat" as UserId;
    for (const command of ["merge", "task done", "approve"]) {
      const r = await authorizeWrite({ store, scanner }, { command, args: ["x"], actor, origin: "agent", in_chat_turn: true, chat_tool: "add_task", key: `k:${command}` });
      expect(r).toMatchObject({ outcome: "refused", reason: AGENT_WRITE_IN_CHAT });
    }
    expect(await store.listHeldWrites(10)).toEqual([]);
    expect(await store.listCliCommandsAfter(0, 100)).toEqual([]);
    for (const name of ["task_done", "merge", "task_add"]) {
      expect(await broker().call(chatCallContext("s1"), name, {})).toMatchObject({ ok: false, error_code: AGENT_WRITE_IN_CHAT });
    }
  });
});
