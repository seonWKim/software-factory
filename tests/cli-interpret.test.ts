import { describe, expect, it } from "vitest";
import { loadCommands, resolveCommand } from "../src/cli/index.js";
import { type SentenceDeps, parseSentence, runSentence } from "../src/cli/handlers/interpret/sentence.js";
import { SENTENCE_FORM } from "../src/core/command-table.js";
import { isProposalId } from "../src/core/interpret.js";
import type { UserId, WorkItem, WorkItemPatch } from "../src/core/types.js";
import type { FactoryStore } from "../src/interfaces/factory-store.js";
import type { LLMProvider, LLMResponse } from "../src/interfaces/llm-provider.js";
import { PatternEgressScanner } from "../src/impl/egress/pattern-egress-scanner.js";
import { cleanScanner } from "./helpers/fakes.js";
import { issue, newStore, system } from "./helpers/store.js";

// `factory "<words>"` (design 04-gate-commands, the CLI sentence form): the plain-words reader over the open items,
// with a fake model. Each proposed command prints as its typed line with the proposal ID and is stored pending; no item
// changes state. An unknown first word reaches it through src/main.ts (resolveCommand).

const ME = "local:me@example.com" as UserId;
const SPEC_PENDING: WorkItemPatch = { stage: "READY", blocked_on: "human", blocked_reason: "spec_pending", tier: 2 };

/** Answers every message with `entries`, as the interpreter's model would; counts its calls. */
class ScriptedLLM implements LLMProvider {
  calls = 0;
  constructor(public answer: Record<string, unknown>) {}
  async complete(): Promise<LLMResponse> {
    this.calls++;
    return { text: JSON.stringify(this.answer), parsed: this.answer, stop_reason: "end", usage: { input_tokens: 1, output_tokens: 1, cost_usd: null } };
  }
}

async function itemAt(store: FactoryStore, n: number, patch: WorkItemPatch = SPEC_PENDING): Promise<WorkItem> {
  const { item } = await store.createWorkItem(issue(n), system);
  const r = await store.transition({ id: item.id, expected_version: item.version, actor: system, reason: "test_setup", patch });
  if (!r.ok) throw new Error("setup");
  return r.item;
}

async function setup(answer: (a: WorkItem, b: WorkItem) => Record<string, unknown>) {
  const { store } = await newStore();
  const a = await itemAt(store, 1);
  const b = await itemAt(store, 2);
  const llm = new ScriptedLLM(answer(a, b));
  const d: SentenceDeps = { store, llm, scanner: cleanScanner, identity: { user: ME, from: "git user.email" }, refusal: async () => null, newId: () => "0f-3a-b2" };
  return { store, a, b, llm, d };
}

describe("factory \"<words>\": the sentence form", () => {
  it("prints each proposed command as its typed line with the proposal ID and stores the rows pending; no item changes", async () => {
    const { store, a, b, llm, d } = await setup((a, b) => ({
      kind: "commands", entries: [{ item: a.id, command: "approve", args: "ship it" }, { item: b.id, command: "reject", args: "not needed" }],
    }));
    const before = await store.listWorkItems(10);
    const r = await runSentence(d, "approve the first one and drop the second");
    expect(llm.calls).toBe(1);
    expect(r.code).toBe(0);
    const id = "prop_0f3ab2";
    expect(isProposalId(id)).toBe(true);
    expect(r.lines[0]).toContain(id);
    expect(r.lines[0]).toContain(`factory confirm ${id}`);
    expect(r.lines.slice(1)).toEqual([`  ${a.id}\t/approve ship it`, `  ${b.id}\t/reject not needed`]);
    expect((await store.listCommandProposals(id)).map((x) => [x.idx, x.work_item_id, x.command, x.args, x.author_id, x.status])).toEqual([
      [0, a.id, "approve", "ship it", ME, "pending"],
      [1, b.id, "reject", "not needed", ME, "pending"],
    ]);
    expect(await store.listWorkItems(10)).toEqual(before);
    expect(await store.listCliCommandsAfter(0, 10)).toEqual([]);
  });

  it("an answer with no command prints the plain reply and stores nothing", async () => {
    const { store, d } = await setup(() => ({ kind: "chat", entries: [], text: "Both are waiting for your approval." }));
    const r = await runSentence(d, "what is waiting on me");
    expect(r).toEqual({ code: 0, lines: ["Both are waiting for your approval."] });
    expect(await store.listCommandProposals("prop_0f3ab2")).toEqual([]);
  });

  it("a refused identity, or words the egress scan stops, reach no model and store nothing", async () => {
    const { store, llm, d } = await setup((a) => ({ kind: "commands", entries: [{ item: a.id, command: "approve", args: "" }] }));
    const refused = await runSentence({ ...d, refusal: async () => "no_role" }, "approve the first one");
    expect(refused).toEqual({ code: 1, lines: ["not read: no_role"] });
    const leaky = new PatternEgressScanner(async () => ["s3cr3t-value-0001"]);
    const blocked = await runSentence({ ...d, scanner: leaky }, "approve it with s3cr3t-value-0001");
    expect(blocked.code).toBe(1);
    expect(blocked.lines.join("\n")).not.toContain("s3cr3t");
    expect(llm.calls).toBe(0);
    expect(await store.listCommandProposals("prop_0f3ab2")).toEqual([]);
  });

  it("the words are every argument, joined; one word alone is no sentence", () => {
    expect(parseSentence(["approve", "the", "spec"])).toEqual({ text: "approve the spec" });
    expect(parseSentence(["approve  the\nspec"])).toEqual({ text: "approve the spec" });
    expect(parseSentence(["stauts"])).toMatchObject({ error: expect.stringContaining(SENTENCE_FORM) });
    expect(parseSentence(["a", "b".repeat(1000)])).toMatchObject({ error: expect.stringContaining("at most") });
  });
});

describe("src/main.ts: which command runs (resolveCommand)", () => {
  it("a known first word runs its command; an unknown one runs the sentence form with every word; a flag runs nothing", async () => {
    const commands = await loadCommands();
    expect(resolveCommand(commands, "confirm", ["prop_1"])).toMatchObject({ name: "confirm", args: ["prop_1"] });
    expect(resolveCommand(commands, "confirm", ["prop_1"])!.command).toBe(commands.get("task"));
    const sentence = resolveCommand(commands, "please", ["approve", "wi_1"])!;
    expect(sentence).toMatchObject({ name: SENTENCE_FORM, args: ["please", "approve", "wi_1"] });
    expect(sentence.command).toBe(commands.get(SENTENCE_FORM));
    expect(resolveCommand(commands, "approve the spec for wi_1", [])).toMatchObject({ name: SENTENCE_FORM, args: ["approve the spec for wi_1"] });
    expect(resolveCommand(commands, "--help", [])).toBeNull();
    expect(resolveCommand(commands, undefined, [])).toBeNull();
  });
});
