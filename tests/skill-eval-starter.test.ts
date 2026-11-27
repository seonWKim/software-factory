// Starter eval cases (design 07-self-improvement, starter drafts): src/core/skill-eval-starter.ts over a fake model,
// a fake scanner and the authoring rules' validateCase.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { STARTER_PROMPT, STARTER_TIMEOUT_MS, type SkillStarterDeps, skillStarter } from "../src/core/skill-eval-starter.js";
import type { EgressChannel, EgressScanner } from "../src/interfaces/egress-scanner.js";
import type { LLMProvider, LLMRequest, LLMResponse } from "../src/interfaces/llm-provider.js";
import { validateCase } from "../src/runtime/skill-evals/authoring.js";

const PROMPT = readFileSync(join(import.meta.dirname, "..", STARTER_PROMPT), "utf8");
const SKILL = "---\nname: summarize\n---\nSummarize a document in three bullets. Decline to summarize anything marked confidential.";

const rubric = (criterion: string) => ({
  kind: "rubric", criterion, anchors: { 1: "misses it", 2: "barely", 3: "partly", 4: "mostly", 5: "fully" },
});
const drafted = (kind: string, n: number) => ({ kind, title: `${kind} ${n}`, input: `input ${n}`, expected: { checks: [rubric(`criterion ${n}`)] } });
/** A set of `typical` cases with one edge and one refuse case. */
const goodSet = (n = 6) => [drafted("edge", 1), drafted("refuse", 2), ...Array.from({ length: n - 2 }, (_, i) => drafted("typical", i + 3))];

function fakeLlm(answer: unknown | ((req: LLMRequest) => Partial<LLMResponse>)) {
  const calls: LLMRequest[] = [];
  const llm: LLMProvider = {
    complete: async (req) => {
      calls.push(req);
      const r = typeof answer === "function" ? (answer as (req: LLMRequest) => Partial<LLMResponse>)(req) : { text: JSON.stringify({ cases: answer }) };
      return { text: "", stop_reason: "end", usage: { input_tokens: 10, output_tokens: 20, cost_usd: null }, ...r };
    },
  };
  return Object.assign(llm, { calls });
}

/** Flags any text holding `flag` under rule `token_rule`; records every scan. */
function fakeScanner(flag = "SECRET-TOKEN") {
  const scans: { channel: EgressChannel; text: string }[] = [];
  const scanner: EgressScanner = {
    scan: async (channel, text) => (scans.push({ channel, text }), text.includes(flag) ? { clean: false, findings: [{ rule: "token_rule", channel }] } : { clean: true }),
  };
  return Object.assign(scanner, { scans });
}

function deps(o: Partial<SkillStarterDeps> = {}): SkillStarterDeps {
  return { llm: fakeLlm(goodSet()), scanner: fakeScanner(), prompt: async () => PROMPT, readSkill: async () => SKILL, validate: validateCase, ...o };
}
const signal = () => new AbortController().signal;

describe("skill starter drafts: the set", () => {
  it("drafts 5 to 8 cases with rubric checks, including an edge and a should-refuse case", async () => {
    for (const n of [5, 8]) {
      const r = await skillStarter(deps({ llm: fakeLlm(goodSet(n)) })).draft("skills/summarize", signal());
      expect("value" in r && r.value.map((c) => c.kind)).toEqual(goodSet(n).map((c) => c.kind));
      if (!("value" in r)) continue;
      expect(r.value.every((c) => (c.expected as { checks: { kind: string }[] }).checks.some((k) => k.kind === "rubric"))).toBe(true);
      expect(r.value[0]).toMatchObject({ title: "edge 1", input: "input 1" });
    }
  });

  it("sends the SKILL.md text to the model with the drafter prompt", async () => {
    const llm = fakeLlm(goodSet());
    await skillStarter(deps({ llm })).draft("skills/summarize", signal());
    expect(llm.calls[0]!.system).toBe(PROMPT);
    expect(llm.calls[0]!.messages.map((m) => m.content).join("\n")).toContain(SKILL);
    expect(llm.calls[0]!.messages.map((m) => m.content).join("\n")).toContain("skills/summarize");
  });

  it("refuses a set with fewer than 5 or more than 8 cases", async () => {
    for (const set of [goodSet(6).slice(0, 4), [...goodSet(8), drafted("typical", 9)]]) {
      const r = await skillStarter(deps({ llm: fakeLlm(set) })).draft("skills/summarize", signal());
      expect(r).toEqual({ refused: expect.stringContaining("5 to 8 cases") });
    }
  });

  it("refuses a set with no edge case, or no should-refuse case, with a notice", async () => {
    const noEdge = goodSet().map((c) => (c.kind === "edge" ? { ...c, kind: "typical" } : c));
    const noRefuse = goodSet().map((c) => (c.kind === "refuse" ? { ...c, kind: "typical" } : c));
    expect(await skillStarter(deps({ llm: fakeLlm(noEdge) })).draft("s", signal())).toEqual({ refused: expect.stringContaining("no edge case") });
    expect(await skillStarter(deps({ llm: fakeLlm(noRefuse) })).draft("s", signal())).toEqual({ refused: expect.stringContaining("no should-refuse case") });
  });

  it("refuses a set with a case validateCase refuses, and one with a case without a rubric check", async () => {
    const badRubric = goodSet();
    badRubric[3] = { ...badRubric[3]!, expected: { checks: [{ kind: "rubric", criterion: "x", anchors: { 1: "a" } }] } } as never;
    const r = await skillStarter(deps({ llm: fakeLlm(badRubric) })).draft("s", signal());
    expect(r).toEqual({ refused: expect.stringMatching(/^Case 4 is not a valid case \(.*no anchor for level 2/) });
    const noRubric = goodSet();
    noRubric[2] = { ...noRubric[2]!, expected: ["Is it short?"] } as never;
    expect(await skillStarter(deps({ llm: fakeLlm(noRubric) })).draft("s", signal())).toEqual({ refused: "Case 3 has no rubric check, so nothing is shown or saved." });
  });

  it("refuses an answer that is not the JSON set", async () => {
    const r = await skillStarter(deps({ llm: fakeLlm(() => ({ text: "Here are some cases!" })) })).draft("s", signal());
    expect(r).toEqual({ refused: expect.stringContaining("not the JSON set") });
  });

  it("check refuses the same rules on a set the page sends back to accept, with no model call", () => {
    const llm = fakeLlm(goodSet());
    const s = skillStarter(deps({ llm }));
    expect("value" in s.check(goodSet())).toBe(true);
    expect(s.check(goodSet().filter((c) => c.kind !== "edge").concat(drafted("typical", 9)))).toEqual({ refused: expect.stringContaining("no edge case") });
    expect(s.check("nope")).toEqual({ refused: expect.stringContaining("5 to 8 cases") });
    expect(llm.calls).toEqual([]);
  });
});

describe("skill starter drafts: the G5 scan", () => {
  it("scans the SKILL.md text and the draft text on the log channel", async () => {
    const scanner = fakeScanner();
    await skillStarter(deps({ scanner })).draft("s", signal());
    expect(scanner.scans.map((s) => s.channel)).toEqual(["log", "log"]);
    expect(scanner.scans[0]!.text).toBe(SKILL);
  });

  it("refuses a flagged SKILL.md with its rule names only, before any model call", async () => {
    const llm = fakeLlm(goodSet());
    const r = await skillStarter(deps({ llm, readSkill: async () => `${SKILL} SECRET-TOKEN` })).draft("s", signal());
    expect(r).toEqual({ refused: "SKILL.md was withheld by the egress scan (rules: token_rule), so nothing was sent." });
    expect(llm.calls).toEqual([]);
  });

  it("refuses a flagged draft with its rule names only, never its text", async () => {
    const set = goodSet();
    set[2] = { ...set[2]!, input: "use SECRET-TOKEN" };
    const r = await skillStarter(deps({ llm: fakeLlm(set) })).draft("s", signal());
    expect(r).toEqual({ refused: "The draft was withheld by the egress scan (rules: token_rule), so nothing is shown." });
  });
});

describe("skill starter drafts: the call", () => {
  it("uses prompts/skill-starter.md and one plain complete call, no tools, with a 120 second timeout", async () => {
    expect(STARTER_PROMPT).toBe("prompts/skill-starter.md");
    expect(PROMPT).toContain("5 to 8 cases");
    expect(STARTER_TIMEOUT_MS).toBe(120_000);
    const llm = fakeLlm(goodSet());
    await skillStarter(deps({ llm })).draft("s", signal());
    expect(llm.calls).toHaveLength(1);
    expect(Object.keys(llm.calls[0]!).sort()).toEqual(["data_env", "max_tokens", "messages", "model_class", "signal", "system"]);
    expect(llm.calls[0]!.signal?.aborted).toBe(false);
  });

  it("is unavailable with a reason with no model or an unreadable prompt, and drafts nothing then", async () => {
    const off = skillStarter(deps({ llm: null }));
    expect(await off.unavailable()).toMatch(/^No model is set up/);
    expect(await off.draft("s", signal())).toEqual({ refused: expect.stringMatching(/^No model is set up/) });
    const llm = fakeLlm(goodSet());
    const noPrompt = skillStarter(deps({ llm, prompt: async () => null }));
    expect(await noPrompt.unavailable()).toMatch(/^prompts\/skill-starter\.md cannot be read/);
    expect(await noPrompt.draft("s", signal())).toEqual({ refused: expect.stringMatching(/^prompts\/skill-starter\.md cannot be read/) });
    expect(llm.calls).toEqual([]);
    expect(await skillStarter(deps()).unavailable()).toBeNull();
  });

  it("refuses an unreadable SKILL.md and a failed call", async () => {
    expect(await skillStarter(deps({ readSkill: async () => null })).draft("skills/x", signal())).toEqual({ refused: "skills/x/SKILL.md cannot be read, so nothing was drafted." });
    const failed = fakeLlm(() => ({ stop_reason: "max_tokens", text: "{" }));
    expect(await skillStarter(deps({ llm: failed })).draft("s", signal())).toEqual({ refused: "The model call failed (max_tokens), so nothing was drafted." });
  });
});
