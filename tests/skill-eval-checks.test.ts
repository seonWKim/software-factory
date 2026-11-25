// A skill-eval case's checks and pass rule (src/runtime/skill-evals/checks.ts, run by engine.ts judgeCase):
// deterministic checks first with no model call, rubric criteria scored 1 to 5 by their anchors, pairwise checks
// judged twice with the order swapped against the previous version's stored answer, one weighted case score and one
// pass rule with its threshold. Every judge and LLM here is a fake: no test calls a model.

import { describe, expect, it, vi } from "vitest";
import { parseRubricAnswers, skillPairwiseJudge, skillRubricJudge } from "../src/core/scorer.js";
import type { LLMProvider, LLMRequest, LLMResponse } from "../src/interfaces/llm-provider.js";
import { type CheckResult, JUDGED_THRESHOLD, caseScore, caseVerdict, parseCaseChecks, runDeterministic } from "../src/runtime/skill-evals/checks.js";
import { type SkillEvalEngineDeps, judgeCase } from "../src/runtime/skill-evals/engine.js";
import type { PairwiseJudgeFn, RubricJudgeFn } from "../src/runtime/skill-evals/checks.js";
import { previousAnswers } from "../src/skill-evals.js";

const signal = () => new AbortController().signal;
const ANCHORS = { "1": "Wrong.", "2": "Mostly wrong.", "3": "Half right.", "4": "Mostly right.", "5": "Fully right." };

/** Engine deps with a replay giving `output` and spy judges: every yes/no check yes, every rubric `score`, pairwise from `pair`. */
function deps(output: string, o: { score?: number; pair?: PairwiseJudgeFn; previous?: string | null } = {}) {
  const judge = vi.fn<SkillEvalEngineDeps["judge"]>(async (s) => s.checks.map(() => ({ answer: "yes" as const, reason: "judged yes" })));
  const rubric = vi.fn<RubricJudgeFn>(async (s) => s.criteria.map(() => ({ reason: "fits", score: o.score ?? 5 })));
  const pairwise = vi.fn<PairwiseJudgeFn>(o.pair ?? (async () => ({ answer: "yes", reason: "better" })));
  const previous = vi.fn(async () => (o.previous === undefined ? "the old answer" : o.previous));
  const d: Omit<SkillEvalEngineDeps, "store"> = { replay: async () => ({ output }), judge, rubric, pairwise, previous, scan: async () => [] };
  return { d, judge, rubric, pairwise, previous };
}

const run = (d: Omit<SkillEvalEngineDeps, "store">, expected: unknown) => judgeCase(d, "r1", { id: "c1", input: "the input", expected }, signal());
const answersOf = (detail: unknown) => (detail as { answers: CheckResult[] }).answers;

/** An LLM that records its requests and answers each with `answer`. */
class FakeLLM implements LLMProvider {
  requests: LLMRequest[] = [];
  constructor(private readonly answer: (req: LLMRequest) => unknown) {}
  async complete(req: LLMRequest): Promise<LLMResponse> {
    this.requests.push(req);
    const parsed = this.answer(req);
    return { text: JSON.stringify(parsed), parsed, stop_reason: "end", usage: { input_tokens: 1, output_tokens: 1, cost_usd: null } };
  }
}

describe("deterministic checks", () => {
  it("each kind passes and fails on the output, with no model call", () => {
    const one = (check: unknown) => {
      const r = parseCaseChecks([check]);
      if (!("value" in r)) throw new Error(r.refused);
      return (output: string) => runDeterministic(r.value.checks[0] as Parameters<typeof runDeterministic>[0], output).pass;
    };
    expect(one({ kind: "contains", value: "hi" })("say hi")).toBe(true);
    expect(one({ kind: "contains", value: "hi" })("bye")).toBe(false);
    expect(one({ kind: "does-not-contain", value: "TODO" })("done")).toBe(true);
    expect(one({ kind: "does-not-contain", value: "TODO" })("TODO later")).toBe(false);
    expect(one({ kind: "regex", pattern: "^v\\d+$", flags: "i" })("V12")).toBe(true);
    expect(one({ kind: "regex", pattern: "^v\\d+$" })("version")).toBe(false);
    expect(one({ kind: "max length", max: 5 })("12345")).toBe(true);
    expect(one({ kind: "max length", max: 5 })("123456")).toBe(false);
    expect(one({ kind: "valid JSON" })('{"a":1}')).toBe(true);
    expect(one({ kind: "valid JSON" })("{a:1}")).toBe(false);
    const schema = { kind: "JSON schema subset", schema: { type: "object", required: ["n"], additionalProperties: false, properties: { n: { type: "integer", minimum: 1 }, tags: { type: "array", items: { enum: ["a", "b"] } } } } };
    expect(one(schema)('{"n":2,"tags":["a"]}')).toBe(true);
    expect(one(schema)('{"n":0}')).toBe(false);
    expect(one(schema)('{"tags":[]}')).toBe(false);
    expect(one(schema)('{"n":1,"x":1}')).toBe(false);
    expect(one(schema)('{"n":1,"tags":["c"]}')).toBe(false);
    expect(one(schema)("not json")).toBe(false);
  });

  it("run before any model call; a failed must-have one fails the case and no judge is called", async () => {
    const { d, judge, rubric, pairwise, previous } = deps("no greeting here");
    const r = await run(d, ["is polite", { kind: "contains", value: "hello" }, { kind: "rubric", criterion: "clear", anchors: ANCHORS }, { kind: "pairwise", criterion: "better" }]);
    expect(r.verdict).toBe("fail");
    expect(judge).not.toHaveBeenCalled();
    expect(rubric).not.toHaveBeenCalled();
    expect(pairwise).not.toHaveBeenCalled();
    expect(previous).not.toHaveBeenCalled();
    expect(answersOf(r.detail)).toEqual([expect.objectContaining({ check: 'contains "hello"', kind: "contains", answer: "no", must: true, value: 0 })]);
  });

  it("a failed check that is not must-have still lets the judges run, and counts in the score", async () => {
    const { d, judge } = deps("hello");
    const r = await run(d, { checks: ["is polite", { kind: "max length", max: 2, must: false }], threshold: 0.5 });
    expect(judge).toHaveBeenCalledTimes(1);
    expect(r.verdict).toBe("pass");
    expect((r.detail as { score: number }).score).toBe(0.5);
  });
});

describe("rubric criteria", () => {
  it("are scored 1 to 5 by their anchors, valued (score − 1) ÷ 4 and weighted", async () => {
    const { d, rubric } = deps("hello", { score: 4 });
    const r = await run(d, [{ kind: "rubric", criterion: "clear", anchors: ANCHORS, weight: 3 }, { kind: "contains", value: "hello" }]);
    expect(rubric).toHaveBeenCalledWith(expect.objectContaining({ criteria: [{ criterion: "clear", anchors: ANCHORS }] }), expect.anything());
    expect(answersOf(r.detail)[0]).toMatchObject({ kind: "rubric", score: 4, value: 0.75, weight: 3, must: false, reason: "fits" });
    expect((r.detail as { score: number; threshold: number })).toMatchObject({ score: (3 * 0.75 + 1) / 4, threshold: JUDGED_THRESHOLD });
    expect(r.verdict).toBe("pass");
  });

  it("the judge gets one anchor sentence per level and answers its reason before its score", async () => {
    const llm = new FakeLLM(() => ({ answers: [{ reason: "it is half right", score: 3 }] }));
    const a = await skillRubricJudge(llm, "SYSTEM", "standard")({ input: "i", output: "o", criteria: [{ criterion: "clear", anchors: ANCHORS }] }, signal());
    expect(a).toEqual([{ reason: "it is half right", score: 3 }]);
    const req = llm.requests[0]!;
    for (const [level, anchor] of Object.entries(ANCHORS)) expect(req.messages[0]!.content).toContain(`${level}: ${anchor}`);
    const items = (req.output_schema as { properties: { answers: { items: { required: string[] } } } }).properties.answers.items;
    expect(items.required).toEqual(["reason", "score"]);
    expect(parseRubricAnswers({ answers: [{ reason: "r", score: 6 }] }, 1)).toBeNull();
    expect(parseRubricAnswers({ answers: [{ reason: "r", score: 2.5 }] }, 1)).toBeNull();
    expect(parseRubricAnswers({ answers: [{ reason: "", score: 2 }] }, 1)).toBeNull();
  });

  it("a rubric score below the threshold fails a must-have rubric; an unanswerable rubric errors the case", async () => {
    const low = await run(deps("x", { score: 2 }).d, [{ kind: "rubric", criterion: "clear", anchors: ANCHORS, must: true }]);
    expect(low.verdict).toBe("fail");
    const { d } = deps("x");
    const errored = await run({ ...d, rubric: async () => null }, [{ kind: "rubric", criterion: "clear", anchors: ANCHORS }]);
    expect(errored).toMatchObject({ verdict: "errored", detail: { error: "judge_failed" } });
  });
});

describe("pairwise checks", () => {
  it("ask whether the new answer beats the previous one twice, with the order swapped", async () => {
    const { d, pairwise, previous } = deps("the new answer");
    const r = await run(d, [{ kind: "pairwise", criterion: "more helpful" }]);
    expect(previous).toHaveBeenCalledWith("c1");
    expect(pairwise.mock.calls.map(([s]) => s)).toEqual([
      { input: "the input", criterion: "more helpful", a: "the new answer", b: "the old answer", candidate: "A" },
      { input: "the input", criterion: "more helpful", a: "the old answer", b: "the new answer", candidate: "B" },
    ]);
    expect(r.verdict).toBe("pass");
    expect(answersOf(r.detail)[0]).toMatchObject({ kind: "pairwise", answer: "yes", value: 1, must: false });
  });

  it("win only when both calls agree; one no is a loss valued 0", async () => {
    for (const first of ["yes", "no"] as const) {
      const pair: PairwiseJudgeFn = async (s) => ({ answer: s.candidate === "A" ? first : first === "yes" ? "no" : "yes", reason: "r" });
      const r = await run(deps("new", { pair }).d, [{ kind: "pairwise", criterion: "better" }]);
      expect(answersOf(r.detail)[0]).toMatchObject({ answer: "no", value: 0 });
      expect(r.verdict).toBe("fail");
    }
  });

  it("with no previous answer to compare, is left out of the case score and the judge is not asked", async () => {
    const { d, pairwise } = deps("hello", { previous: null });
    const r = await run(d, [{ kind: "contains", value: "hello" }, { kind: "pairwise", criterion: "better", weight: 5 }]);
    expect(pairwise).not.toHaveBeenCalled();
    expect(answersOf(r.detail)[1]).toMatchObject({ kind: "pairwise", value: null });
    expect((r.detail as { score: number }).score).toBe(1);
    expect(r.verdict).toBe("pass");
    expect(caseScore([{ weight: 1, value: 0.5 }, { weight: 9, value: null }])).toBe(0.5);
  });

  it("the pairwise judge shows the answers only as A and B and asks about the named one", async () => {
    const llm = new FakeLLM(() => ({ reason: "A is clearer", answer: "yes" }));
    const a = await skillPairwiseJudge(llm, "PAIR", "standard")({ input: "i", criterion: "clear", a: "first", b: "second", candidate: "B" }, signal());
    expect(a).toEqual({ answer: "yes", reason: "A is clearer" });
    const content = llm.requests[0]!.messages[0]!.content;
    expect(content).toContain("does answer B beat answer A");
    expect(content.indexOf("first")).toBeLessThan(content.indexOf("second"));
    expect(content).not.toMatch(/previous|newer/i);
    expect(llm.requests[0]!.system).toBe("PAIR");
  });

  it("the previous answer is the stored one for the case from the newest run on another skill version", async () => {
    const runs = [
      { id: "r3", skill_version: "v2" }, { id: "r2", skill_version: "v1" }, { id: "r1", skill_version: "v0" }, { id: "r0", skill_version: null },
    ];
    const replays: Record<string, { case_id: string; answer: string | null }[]> = {
      r3: [{ case_id: "c1", answer: "same version" }], r2: [{ case_id: "c1", answer: null }, { case_id: "c2", answer: "v1 c2" }], r1: [{ case_id: "c1", answer: "v0 c1" }], r0: [{ case_id: "c1", answer: "old" }],
    };
    const listSkillEvalReplays = vi.fn(async (id: string) => replays[id]! as never);
    const store = { listSkillEvalRuns: vi.fn(async () => runs as never), listSkillEvalReplays };
    const previous = previousAnswers(store, "skills/x", "v2");
    expect(await previous("c1")).toBe("v0 c1");
    expect(await previous("c2")).toBe("v1 c2");
    expect(await previous("c9")).toBeNull();
    expect(store.listSkillEvalRuns).toHaveBeenCalledTimes(1);
    expect(listSkillEvalReplays.mock.calls.map(([id]) => id).filter((id) => id === "r2")).toEqual(["r2"]);
    expect(listSkillEvalReplays).not.toHaveBeenCalledWith("r3");
  });
});

describe("the case score and pass rule", () => {
  const result = (r: Partial<CheckResult>): CheckResult => ({ check: "c", answer: "yes", reason: "r", kind: "rubric", weight: 1, must: false, value: 1, ...r });

  it("the score is the weighted sum; a case passes when every must-have check passes and the score reaches the threshold", () => {
    const results = [result({ weight: 3, value: 1 }), result({ weight: 1, value: 0, answer: "no" })];
    expect(caseScore(results)).toBe(0.75);
    expect(caseVerdict(results, 0.75)).toBe("pass");
    expect(caseVerdict(results, 0.8)).toBe("fail");
    expect(caseVerdict([...results, result({ kind: "contains", must: true, answer: "no", value: 0, weight: 0 })], 0.5)).toBe("fail");
  });

  it("stored string checks stay must-have yes/no checks at threshold 1", async () => {
    const parsed = parseCaseChecks(["a", "b"]);
    expect(parsed).toEqual({ value: { checks: [{ kind: "yes/no", check: "a", weight: 1, must: true }, { kind: "yes/no", check: "b", weight: 1, must: true }], threshold: 1 } });
    expect(parseCaseChecks({ checks: ["a"] })).toMatchObject({ value: { threshold: 1 } });
    expect(parseCaseChecks(["a", { kind: "valid JSON" }])).toMatchObject({ value: { threshold: 1 } });
    expect(parseCaseChecks(["a", { kind: "rubric", criterion: "c", anchors: ANCHORS }])).toMatchObject({ value: { threshold: JUDGED_THRESHOLD } });

    const { d } = deps("x");
    const oneNo = await run({ ...d, judge: async (s) => s.checks.map((_, i) => ({ answer: i === 0 ? "no" as const : "yes" as const, reason: "r" })) }, ["a", "b", "c"]);
    expect(oneNo.verdict).toBe("fail");
    expect(await run(d, ["a", "b"])).toMatchObject({ verdict: "pass", detail: { score: 1, threshold: 1 } });
  });

  it("refuses an unknown kind, a rubric with a missing anchor and a weight below 0", () => {
    const { "5": _five, ...four } = ANCHORS;
    expect(parseCaseChecks([{ kind: "vibes" }])).toEqual({ refused: expect.stringContaining("unknown check kind") });
    expect(parseCaseChecks([{ kind: "rubric", criterion: "c", anchors: four }])).toEqual({ refused: expect.stringContaining("no anchor for level 5") });
    expect(parseCaseChecks([{ kind: "contains", value: "x", weight: -0.5 }])).toEqual({ refused: expect.stringContaining("weight") });
  });
});
