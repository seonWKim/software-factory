import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MODEL_CLASSES } from "../src/core/model-choice.js";
import { NO_SCORER, SCORER_HEADING, improvePrompts, judgeClass, scoreRun, scorerFor, type Judge } from "../src/core/scorer.js";
import type { WorkerId } from "../src/core/types.js";
import type { LLMProvider, LLMRequest, LLMResponse } from "../src/interfaces/llm-provider.js";
import { Worker } from "../src/worker/index.js";
import { NoKeepAwake } from "../src/impl/awake/no-keep-awake.js";
import { FakeClock } from "../src/impl/clock/fake-clock.js";
import { issue, newStore, system } from "./helpers/store.js";
import { FakeBroker, FakeRunner, FakeSandbox, MemoryStorage, cleanScanner, config, prompts, silent, triageSpec } from "./helpers/fakes.js";

/** The checked-in prompts/improve.md: its draft part and its scorer section. */
const IMPROVE_MD = readFileSync(join(import.meta.dirname, "..", "prompts", "improve.md"), "utf8");
/** A GitHub-token-shaped string the pattern scanner flags. */
const TOKEN = `ghp_${"a".repeat(36)}`;

/** An LLM that records its calls and answers each with `answer`. */
class CountingLLM implements LLMProvider {
  requests: LLMRequest[] = [];
  constructor(private readonly answer: (req: LLMRequest) => LLMResponse | Promise<LLMResponse> = () => graded(4, "the spec is clear and testable")) {}
  async complete(req: LLMRequest): Promise<LLMResponse> {
    this.requests.push(req);
    return this.answer(req);
  }
}

function graded(score: number, reason: string): LLMResponse {
  const parsed = { score, reason };
  return { text: JSON.stringify(parsed), parsed, stop_reason: "end", usage: { input_tokens: 50, output_tokens: 10, cost_usd: null } };
}

/** One triage run of a new item on fakes, as the agent `triage` scripts it; returns the stored run and the fakes. */
async function triageOnce(o: { llm?: LLMProvider; improve?: string; fail?: boolean } = {}) {
  const clock = new FakeClock();
  const { store } = await newStore(clock);
  const { item } = await store.createWorkItem(issue(1), system, { enqueue: { kind: "triage", idempotency_key: "t1" } });
  const runner = new FakeRunner({ triage: () => (o.fail ? { status: "failed", error: "boom" } : { output: triageSpec }) });
  const worker = new Worker({
    id: "w1" as WorkerId, store, sandbox: new FakeSandbox(), runner, broker: new FakeBroker(), storage: new MemoryStorage(), clock, config,
    prompts: { ...prompts, ...(o.improve !== undefined ? { improve: o.improve } : {}) }, log: silent, scanner: cleanScanner, toolEnv: {},
    awake: new NoKeepAwake(), ...(o.llm ? { llm: o.llm } : {}),
  });
  expect(await worker.tick()).toBe(true);
  const [run] = await store.listRuns(item.id);
  return { run: run!, runner };
}

describe("scorer off", () => {
  it("with no LLMProvider (plugins.llm not set) a succeeded run is stored with no grade, and the worker runs it with no error", async () => {
    const { run } = await triageOnce({ improve: IMPROVE_MD });
    expect(run.status).toBe("succeeded");
    expect(run.outcome?.status === "succeeded" && run.outcome.data).not.toHaveProperty("grades");
  });

  it("with no scorer section in the improve prompt, or no improve prompt, no judge is asked", async () => {
    for (const improve of [undefined, "IMPROVE"]) {
      const llm = new CountingLLM();
      const { run } = await triageOnce({ llm, ...(improve !== undefined ? { improve } : {}) });
      expect(run.status).toBe("succeeded");
      expect(run.outcome?.status === "succeeded" && run.outcome.data).not.toHaveProperty("grades");
      expect(llm.requests).toEqual([]);
    }
  });

  it("scorerFor gives NO_SCORER without a provider or a scorer prompt, and NO_SCORER grades nothing", async () => {
    expect(scorerFor(undefined, IMPROVE_MD)).toBe(NO_SCORER);
    expect(scorerFor(new CountingLLM(), undefined)).toBe(NO_SCORER);
    expect(scorerFor(new CountingLLM(), "IMPROVE")).toBe(NO_SCORER);
    const signal = new AbortController().signal;
    expect(await scoreRun({ scorer: NO_SCORER, scanner: cleanScanner, signal }, { kind: "triage", title: "t", producer: "cheap", data: { spec: 1 } })).toEqual([]);
  });
});

describe("scorer on", () => {
  it("a succeeded run gets one grade per judge in its outcome, and the judge's usage counts toward the run", async () => {
    const llm = new CountingLLM();
    const { run } = await triageOnce({ llm, improve: IMPROVE_MD });
    expect(run.status).toBe("succeeded");
    expect(run.outcome).toMatchObject({
      status: "succeeded",
      data: { grades: [{ judge: "llm:strong", score: 4, reason: "the spec is clear and testable" }], usage: { input_tokens: 60, output_tokens: 15 } },
    });
  });

  it("a failed run is not graded", async () => {
    const llm = new CountingLLM();
    const { run } = await triageOnce({ llm, improve: IMPROVE_MD, fail: true });
    expect(run.status).toBe("failed");
    expect(llm.requests).toEqual([]);
  });

  it("a judge that fails, refuses or answers out of schema gives no grade and never fails the run", async () => {
    const answers: (() => LLMResponse | Promise<LLMResponse>)[] = [
      () => { throw new Error("down"); },
      () => ({ ...graded(4, "x"), stop_reason: "refused" }),
      () => graded(9, "out of range"),
    ];
    for (const answer of answers) {
      const { run } = await triageOnce({ llm: new CountingLLM(answer), improve: IMPROVE_MD });
      expect(run.status).toBe("succeeded");
      expect(run.outcome?.status === "succeeded" && run.outcome.data).not.toHaveProperty("grades");
    }
  });

  it("a grade whose reason the egress scan flags is left out", async () => {
    const { run } = await triageOnce({ llm: new CountingLLM(() => graded(2, `it leaks ${TOKEN}`)), improve: IMPROVE_MD });
    expect(run.status).toBe("succeeded");
    expect(run.outcome?.status === "succeeded" && run.outcome.data).not.toHaveProperty("grades");
  });
});

describe("judge independence", () => {
  it("the judge is its own plain call on another model class, with the scorer prompt and only the run's output", async () => {
    const llm = new CountingLLM();
    const { runner } = await triageOnce({ llm, improve: IMPROVE_MD });
    // The run was produced by one agent call; the judge never went through the agent runner.
    expect(runner.specs).toHaveLength(1);
    const producer = runner.specs[0]!;
    expect(llm.requests).toHaveLength(1);
    const req = llm.requests[0]!;
    expect(req.model_class).not.toBe(producer.model_class);
    expect(req.system).toBe(improvePrompts(IMPROVE_MD).scorer);
    expect(req.system).not.toContain(prompts.triage);
    expect(req.messages).toHaveLength(1);
    expect(req.messages[0]!.content).toContain(triageSpec.problem);
    expect(req.messages[0]!.content).not.toContain(producer.prompt);
    expect(req).not.toHaveProperty("tools");
  });

  it("a judge's class is never the producer's", () => {
    for (const c of MODEL_CLASSES) expect(judgeClass(c)).not.toBe(c);
  });

  it("every judge sees the same subject, and a judge's grades come back in judge order", async () => {
    const seen: string[] = [];
    const judge = (id: string, score: number): Judge => ({
      id,
      grade: async (s) => {
        seen.push(`${id}:${s.producer}:${s.output}`);
        return { judge: id, score, reason: `${id} says ${score}` };
      },
    });
    const grades = await scoreRun(
      { scorer: { judges: [judge("a", 3), judge("b", 5)] }, scanner: cleanScanner, signal: new AbortController().signal },
      { kind: "implement", title: "t", producer: "standard", data: { pr: 1 } },
    );
    expect(grades.map((g) => [g.judge, g.score])).toEqual([["a", 3], ["b", 5]]);
    expect(seen).toEqual(['a:standard:{"pr":1}', 'b:standard:{"pr":1}']);
  });
});

describe("prompts/improve.md split", () => {
  it("the draft call's prompt is the text before the scorer section; the section is the judges' prompt", () => {
    const { draft, scorer } = improvePrompts(IMPROVE_MD);
    expect(IMPROVE_MD.startsWith(draft.trimEnd())).toBe(true);
    expect(draft).not.toContain(SCORER_HEADING);
    expect(scorer?.startsWith(SCORER_HEADING)).toBe(true);
    expect(scorer).toMatch(/- score:/);
    expect(scorer).toMatch(/- reason:/);
    expect(improvePrompts("IMPROVE")).toEqual({ draft: "IMPROVE", scorer: null });
  });
});
