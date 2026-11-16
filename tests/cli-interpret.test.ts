import { describe, expect, it, vi } from "vitest";
import { TYPO_MAX_EDITS, TYPO_MIN_LENGTH, editDistance, loadCommands, mistypedName, resolveCommand } from "../src/cli/index.js";
import { defineCommand } from "../src/cli/command.js";
import { SENTENCE_FORM } from "../src/core/command-table.js";
import { type SentenceDeps, parseSentence, runSentence } from "../src/core/local-cli.js";
import { isProposalId } from "../src/core/interpret.js";
import type { UserId, WorkItem, WorkItemPatch } from "../src/core/types.js";
import type { FactoryStore } from "../src/interfaces/factory-store.js";
import type { LLMProvider, LLMRequest, LLMResponse } from "../src/interfaces/llm-provider.js";
import { PatternEgressScanner } from "../src/impl/egress/pattern-egress-scanner.js";
import { cleanScanner } from "./helpers/fakes.js";
import { issue, newStore, system } from "./helpers/store.js";
import { classifierAnswer } from "./helpers/classifier.js";

// `factory "<words>"` (design 04-gate-commands, the CLI sentence form): the plain-words reader over the open items,
// with a fake model. Each proposed command prints as its typed line with the proposal ID and is stored pending; no item
// changes state. An unknown first word reaches it through src/main.ts (resolveCommand, its fallback the sentence form).

const ME = "local:me@example.com" as UserId;
const SPEC_PENDING: WorkItemPatch = { stage: "READY", blocked_on: "human", blocked_reason: "spec_pending", tier: 2 };

/** Answers every message with `entries`, as the interpreter's model would; counts its calls. */
class ScriptedLLM implements LLMProvider {
  calls = 0;
  constructor(public answer: Record<string, unknown>) {}
  async complete(req: LLMRequest): Promise<LLMResponse> {
    const label = classifierAnswer(req);
    if (label) return label;
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
    const SENTENCE = defineCommand({ names: [SENTENCE_FORM], usage: "", run: async () => 0 });
    expect(resolveCommand(commands, SENTENCE, "confirm", ["prop_1"])).toMatchObject({ name: "confirm", args: ["prop_1"] });
    expect(resolveCommand(commands, SENTENCE, "confirm", ["prop_1"])!.command).toBe(commands.get("task"));
    const sentence = resolveCommand(commands, SENTENCE, "please", ["approve", "wi_1"])!;
    expect(sentence).toMatchObject({ name: SENTENCE_FORM, args: ["please", "approve", "wi_1"] });
    expect(sentence.command).toBe(SENTENCE);
    expect(commands.has(SENTENCE_FORM)).toBe(false);
    expect(resolveCommand(commands, SENTENCE, "approve the spec for wi_1", [])).toMatchObject({ name: SENTENCE_FORM, args: ["approve the spec for wi_1"] });
    expect(resolveCommand(commands, SENTENCE, "--help", [])).toBeNull();
    expect(resolveCommand(commands, SENTENCE, undefined, [])).toBeNull();
  });
});

describe("src/main.ts: a mistyped command name (design 04-gate-commands)", () => {
  /** The sentence form over a counting fake model, as main.ts builds it but with the store and identity of the test. */
  async function sentenceWith(llm: ScriptedLLM) {
    const { store } = await newStore();
    return defineCommand({
      names: [SENTENCE_FORM],
      usage: "",
      run: async (args) => {
        const parsed = parseSentence(args);
        if ("error" in parsed) return 1;
        const d: SentenceDeps = { store, llm, scanner: cleanScanner, identity: { user: ME, from: "git user.email" }, refusal: async () => null, newId: () => "0f-3a-b2" };
        return (await runSentence(d, parsed.text)).code;
      },
    });
  }

  it("a first word within two edits of a command name prints `unknown command X, did you mean Y?`, exits 1 and calls no model", async () => {
    const commands = await loadCommands();
    const llm = new ScriptedLLM({ kind: "chat", entries: [], text: "unused" });
    const sentence = await sentenceWith(llm);
    const errors: string[] = [];
    const spy = vi.spyOn(console, "error").mockImplementation((l: string) => void errors.push(l));
    try {
      for (const [typed, name] of [["stauts", "status"], ["resmue", "resume"], ["wrokers", "workers"], ["settngs", "settings"]] as const) {
        const found = resolveCommand(commands, sentence, typed, ["wi_1", "now"])!;
        expect(found.command).not.toBe(sentence);
        expect(await found.command.run(found.args, { name: found.name, usage: "", load: () => Promise.reject(new Error("no config")) })).toBe(1);
        expect(errors.at(-1)).toBe(`unknown command ${typed}, did you mean ${name}?`);
      }
    } finally {
      spy.mockRestore();
    }
    expect(llm.calls).toBe(0);
  });

  it("a word shorter than the minimum, or further than two edits from every name, still reaches the sentence form", async () => {
    const commands = await loadCommands();
    const llm = new ScriptedLLM({ kind: "chat", entries: [], text: "Both are waiting." });
    const sentence = await sentenceWith(llm);
    expect(TYPO_MIN_LENGTH).toBe(4);
    expect(TYPO_MAX_EDITS).toBe(2);
    // "uis" is one edit from `ui` but has three letters; "please" and "what" are near no command name.
    for (const word of ["uis", "please", "what"]) {
      expect(mistypedName(commands.keys(), word), word).toBeNull();
      const found = resolveCommand(commands, sentence, word, ["is", "waiting"])!;
      expect(found).toMatchObject({ name: SENTENCE_FORM, args: [word, "is", "waiting"] });
      expect(await found.command.run(found.args, { name: found.name, usage: "", load: () => Promise.reject(new Error("no config")) })).toBe(0);
    }
    expect(llm.calls).toBe(3);
  });

  it("edit distance counts insertions, deletions, substitutions and swaps of two neighbouring letters", () => {
    expect(editDistance("status", "status")).toBe(0);
    expect(editDistance("stauts", "status")).toBe(1);
    expect(editDistance("stauts", "stats")).toBe(1);
    expect(editDistance("resum", "resume")).toBe(1);
    expect(editDistance("", "abc")).toBe(3);
    expect(editDistance("kitten", "sitting")).toBe(3);
  });
});
