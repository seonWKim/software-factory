// The chat's eval run (design 04-chat-agent): src/core/chat-eval.ts, scripts/chat-eval.ts and the controller's daily
// chat-eval unit, with a fake Ask model and a fake judge only. No real model is called.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  CHAT_EVAL_CURSOR, CHAT_EVAL_PASS_BAR, CHAT_EVAL_QUESTIONS, type ChatEvalDeps, type ChatEvalQuestion, chatEvalDaily, chatEvalExitCode,
  chatEvalSchedule, parseChatEvalQuestions, runChatEval,
} from "../src/core/chat-eval.js";
import { ChatEvalUnit } from "../src/controller/units/chat-eval/chat-eval.unit.js";
import { CHAT_FAILURE_WORDS, chatEvalFailedKey, failuresOf } from "../src/core/alarms.js";
import type { FactoryStore } from "../src/interfaces/factory-store.js";
import { newStore } from "./helpers/store.js";
import { PatternEgressScanner } from "../src/impl/egress/pattern-egress-scanner.js";
import type { LLMProvider, LLMRequest, LLMResponse } from "../src/interfaces/llm-provider.js";
import { main } from "../scripts/chat-eval.js";

const ROOT = join(import.meta.dirname, "..");
const QUESTIONS_TEXT = readFileSync(join(ROOT, CHAT_EVAL_QUESTIONS), "utf8");
const USAGE = { input_tokens: 1, output_tokens: 1, cost_usd: 0 };
const FEATURE_MAP_TOOLS = ["list_areas", "list_features", "get_feature", "get_feature_schema"];
const ARGS: Record<string, string> = { list_areas: "{}", list_features: '{"area":"chat"}', get_feature: '{"id":"chat.send"}', get_feature_schema: '{"id":"chat.send"}' };

/**
 * The fake Ask model: for a question, first asks for the tools `calls(q)` names (each once), then replies
 * `reply:<id>`. Every request is kept.
 */
function fakeAsk(questions: readonly ChatEvalQuestion[], calls: (q: ChatEvalQuestion) => readonly string[] = (q) => q.tools) {
  const seen: LLMRequest[] = [];
  const llm: LLMProvider = {
    async complete(req): Promise<LLMResponse> {
      seen.push(req);
      const q = questions.find((x) => x.question === req.messages[0]!.content)!;
      const wanted = calls(q);
      if (req.messages.at(-1)!.role === "user" && wanted.length > 0) {
        return { text: "", tool_calls: wanted.map((name, i) => ({ id: `${q.id}_${i}`, name, arguments: ARGS[name] ?? "{}" })), stop_reason: "end", usage: USAGE };
      }
      return { text: `reply:${q.id}`, stop_reason: "end", usage: USAGE };
    },
  };
  return { llm, seen };
}

/** The fake judge: "yes" for the replies of the ids in `yes`, "no" for the rest. */
function fakeJudge(yes: ReadonlySet<string>) {
  const seen: LLMRequest[] = [];
  const judge: LLMProvider = {
    async complete(req): Promise<LLMResponse> {
      seen.push(req);
      const id = /reply:(\S+)/.exec(req.messages[0]!.content)?.[1] ?? "";
      return { text: yes.has(id) ? "yes" : "no", stop_reason: "end", usage: USAGE };
    },
  };
  return { judge, seen };
}

function deps(llm: LLMProvider, judge: LLMProvider): ChatEvalDeps {
  let n = 0;
  return { llm, judge, read: () => null, scanner: new PatternEgressScanner(async () => []), clock: { now: () => new Date("2026-11-27T09:00:00Z") }, newId: () => `id${n++}` };
}

const QUESTIONS = parseChatEvalQuestions(QUESTIONS_TEXT);
const ids = (n: number) => new Set(QUESTIONS.slice(0, n).map((q) => q.id));

describe("the eval runner", () => {
  it("reads the owner's questions file and sends each question through chatTurn in its own new session, with the four feature-map tools and the given Ask model", async () => {
    const ask = fakeAsk(QUESTIONS);
    const report = await runChatEval(deps(ask.llm, fakeJudge(ids(QUESTIONS.length)).judge), QUESTIONS);

    expect(report.results.map((r) => r.id)).toEqual(QUESTIONS.map((q) => q.id));
    const sessions = report.results.map((r) => r.session_id);
    expect(new Set(sessions).size).toBe(QUESTIONS.length);
    for (const s of sessions) expect(s).toMatch(/^cs_/);
    // Each question opens its session: the first request of a question holds only that question, no earlier turn.
    const firsts = ask.seen.filter((r) => r.messages.length === 1);
    expect(firsts.map((r) => r.messages[0]!.content)).toEqual(QUESTIONS.map((q) => q.question));
    for (const r of ask.seen) {
      expect(r.model_class).toBe("cheap");
      expect(r.tools!.map((t) => t.name)).toEqual(FEATURE_MAP_TOOLS);
    }
  });

  it("asks the judge with model_class standard, giving it the question's judged_answer and the reply", async () => {
    const q = QUESTIONS[0]!;
    const judge = fakeJudge(new Set([q.id]));
    await runChatEval(deps(fakeAsk([q]).llm, judge.judge), [q]);
    expect(judge.seen).toHaveLength(1);
    expect(judge.seen[0]!.model_class).toBe("standard");
    expect(judge.seen[0]!.messages[0]!.content).toContain(q.judged_answer);
    expect(judge.seen[0]!.messages[0]!.content).toContain(`reply:${q.id}`);
  });
});

describe("the pass rule", () => {
  const q: ChatEvalQuestion = { id: "two-tools", question: "What does chat.send take?", judged_answer: "Names its input.", tools: ["get_feature", "get_feature_schema"] };

  it("passes a reply that calls every listed tool and that the judge says yes to", async () => {
    const [r] = (await runChatEval(deps(fakeAsk([q]).llm, fakeJudge(new Set([q.id])).judge), [q])).results;
    expect(r).toMatchObject({ passed: true, judged: true, missing_tools: [] });
  });

  it("fails a reply that skips a listed tool, even one the judge would say yes to, without asking the judge", async () => {
    const judge = fakeJudge(new Set([q.id]));
    const [r] = (await runChatEval(deps(fakeAsk([q], () => ["get_feature"]).llm, judge.judge), [q])).results;
    expect(r).toMatchObject({ passed: false, judged: null, missing_tools: ["get_feature_schema"] });
    expect(judge.seen).toEqual([]);
  });

  it("fails a reply that calls every tool when the judge says no", async () => {
    const [r] = (await runChatEval(deps(fakeAsk([q]).llm, fakeJudge(new Set()).judge), [q])).results;
    expect(r).toMatchObject({ passed: false, judged: false, missing_tools: [] });
  });

  it("fails a turn that did not answer", async () => {
    const broken: LLMProvider = { complete: async () => ({ text: "", stop_reason: "error", usage: USAGE }) };
    const [r] = (await runChatEval(deps(broken, fakeJudge(new Set([q.id])).judge), [q])).results;
    expect(r).toMatchObject({ passed: false, failure: "model_error" });
  });
});

describe("the pass bar", () => {
  it("is 8", () => {
    expect(CHAT_EVAL_PASS_BAR).toBe(8);
    expect([chatEvalExitCode(7), chatEvalExitCode(8), chatEvalExitCode(9)]).toEqual([1, 0, 0]);
  });

  for (const [passes, code] of [[CHAT_EVAL_PASS_BAR - 1, 1], [CHAT_EVAL_PASS_BAR, 0], [QUESTIONS.length, 0]] as const) {
    it(`the script counts ${passes} passes, prints them out of the questions run, and exits ${code}`, async () => {
      const lines: string[] = [];
      const code_ = await main(async () => ({ deps: deps(fakeAsk(QUESTIONS).llm, fakeJudge(ids(passes)).judge), questions: QUESTIONS_TEXT }), (l) => lines.push(l));
      expect(code_).toBe(code);
      expect(lines.at(-1)).toContain(`${passes}/${QUESTIONS.length} passed (bar ${CHAT_EVAL_PASS_BAR})`);
      expect(lines.filter((l) => l.startsWith("PASS")).length).toBe(passes);
    });
  }
});

describe("the daily run", () => {
  it("is on only when chat_eval.schedule is daily", () => {
    expect(chatEvalDaily({ chat_eval: { schedule: "daily" } })).toBe(true);
    expect(chatEvalDaily({})).toBe(false);
    expect(chatEvalDaily({ chat_eval: {} })).toBe(false);
  });

  it("claims each UTC day once across replicas through the store cursor", async () => {
    const cursors = new Map<string, string>();
    const store = {
      getCursor: async (name: string) => cursors.get(name) ?? null,
      advanceCursor: async (name: string, expected: string | null, next: string) => {
        if ((cursors.get(name) ?? null) !== expected) return false;
        cursors.set(name, next);
        return true;
      },
    };
    const a = chatEvalSchedule(store, deps(fakeAsk([]).llm, fakeJudge(new Set()).judge), async () => QUESTIONS_TEXT);
    const b = chatEvalSchedule(store, deps(fakeAsk([]).llm, fakeJudge(new Set()).judge), async () => QUESTIONS_TEXT);
    expect(await a.claim("2026-11-27")).toBe(true);
    expect(await b.claim("2026-11-27")).toBe(false);
    expect(await b.claim("2026-11-28")).toBe(true);
    expect(cursors.get(CHAT_EVAL_CURSOR)).toBe("2026-11-28");
  });

  type Port = ConstructorParameters<typeof ChatEvalUnit>[0]["k"]["d"]["chat_eval"];
  /**
   * The unit on a fake kernel: its `alert` write goes to `store` (the store's own dedupe), and its UI scan flags any
   * text that holds `flag`.
   */
  function unit(port: Port, now: { ms: number }, store?: FactoryStore, flag = "\u0000never") {
    const logs: string[] = [];
    const scanned: string[] = [];
    const log = { info: (m: string) => logs.push(m), warn: (m: string) => logs.push(m), error: (m: string) => logs.push(m), debug: () => {} };
    const reader = { scan: async (channel: string, text: string) => (scanned.push(`${channel}:${text}`), { clean: !text.includes(flag) }) };
    const commit = async (b: { writes: { kind: string; alert: Parameters<FactoryStore["recordAlert"]>[0]; dedupe_ms: number }[] }) => {
      for (const w of b.writes) if (w.kind === "alert") await store!.recordAlert(w.alert, w.dedupe_ms);
    };
    const ctx = { k: { d: { chat_eval: port, log }, nowMs: () => now.ms, reader, commit } } as unknown as ConstructorParameters<typeof ChatEvalUnit>[0];
    return { u: new ChatEvalUnit(ctx), logs, scanned };
  }

  /** A port that claims every day and answers `run` with the next of `outcomes` (an Error is thrown). */
  function scripted(outcomes: (Awaited<ReturnType<NonNullable<Port>["run"]>> | Error)[]): NonNullable<Port> {
    let i = 0;
    return {
      claim: async () => true,
      run: async () => {
        const o = outcomes[i++]!;
        if (o instanceof Error) throw o;
        return o;
      },
    };
  }

  const chatAlerts = async (store: FactoryStore) => (await store.listAlerts({ limit: 100 })).filter((a) => a.pattern === "chat_eval_failed");
  const BELOW = {
    passed: 0, total: 12, bar: CHAT_EVAL_PASS_BAR, ok: false,
    results: [{ failure: "too_many_steps" }, { failure: "model_error", detail: "claude-cli: Not logged in" }, { failure: "model_error" }, { failure: "model_error" }, { failure: null }],
  };

  it("the controller unit starts the run once a UTC day, with no owner action, and logs its result", async () => {
    let runs = 0;
    const claimed = new Set<string>();
    const port = {
      claim: async (day: string) => (claimed.has(day) ? false : (claimed.add(day), true)),
      run: async () => (runs++, { passed: 8, total: 12, bar: 8, ok: true }),
    };
    const now = { ms: Date.parse("2026-11-27T09:00:00Z") };
    const { u, logs } = unit(port, now);
    await u.evalStep();
    await u.running;
    await u.evalStep();
    expect(runs).toBe(1);
    expect(logs).toContain("chat eval run finished");
    now.ms = Date.parse("2026-11-28T00:01:00Z");
    await u.evalStep();
    await u.running;
    expect(runs).toBe(2);
  });

  it("the finished line counts the failed turns by reason with the first provider detail, so 0/12 says why", () => {
    const results = [
      { failure: "model_error", detail: "claude-cli: Not logged in" }, { failure: "model_error" }, { failure: null }, { failure: "too_many_steps" },
    ];
    expect(failuresOf(results)).toEqual({ failures: "model_error:2,too_many_steps:1", failure_detail: "claude-cli: Not logged in" });
    expect(failuresOf([{ failure: null }])).toEqual({});
  });

  it("a run that ends with ok false stores one chat_eval_failed alert for the UTC day with the counts, the bar and the top reason", async () => {
    const { store } = await newStore();
    const now = { ms: Date.parse("2026-11-27T00:00:00Z") };
    const { u, scanned } = unit(scripted([BELOW]), now, store);
    await u.evalStep();
    await u.running;
    const alerts = await chatAlerts(store);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({ pattern_key: chatEvalFailedKey("2026-11-27"), count: 0 });
    expect(alerts[0]!.pattern_key).toBe("chat_eval_failed:2026-11-27");
    const detail = alerts[0]!.detail!;
    expect(detail).toContain(`Chat check failed today: 0 of 12 answered (needs ${CHAT_EVAL_PASS_BAR}).`);
    expect(detail).toContain(`Most failures: ${CHAT_FAILURE_WORDS.model_error} (3).`);
    expect(detail).toContain("claude-cli: Not logged in");
    expect(scanned).toContain(`ui:${detail}`);
  });

  it("a run that throws stores one chat_eval_failed alert naming the error", async () => {
    const { store } = await newStore();
    const { u } = unit(scripted([new Error("questions file missing")]), { ms: Date.parse("2026-11-27T00:00:00Z") }, store);
    await u.evalStep();
    await u.running;
    const alerts = await chatAlerts(store);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.detail).toBe("Chat check failed today: the run stopped with an error: questions file missing.");
  });

  it("two failing runs on the same UTC day store one alert", async () => {
    const { store } = await newStore();
    const now = { ms: Date.parse("2026-11-27T00:00:00Z") };
    const a = unit(scripted([BELOW]), now, store);
    const b = unit(scripted([new Error("boom")]), now, store);
    await a.u.evalStep();
    await a.u.running;
    now.ms = Date.parse("2026-11-27T23:59:00Z");
    await b.u.evalStep();
    await b.u.running;
    expect((await chatAlerts(store)).map((x) => x.pattern_key)).toEqual(["chat_eval_failed:2026-11-27"]);
  });

  it("a passing run stores no alert", async () => {
    const { store } = await newStore();
    const { u } = unit(scripted([{ passed: CHAT_EVAL_PASS_BAR, total: 12, bar: CHAT_EVAL_PASS_BAR, ok: true, results: [{ failure: "model_error" }] }]), { ms: Date.parse("2026-11-27T00:00:00Z") }, store);
    await u.evalStep();
    await u.running;
    expect(await chatAlerts(store)).toEqual([]);
  });

  it("a detail the UI scan flags is stored as null", async () => {
    const { store } = await newStore();
    const { u } = unit(scripted([new Error("token sk-secret")]), { ms: Date.parse("2026-11-27T00:00:00Z") }, store, "sk-secret");
    await u.evalStep();
    await u.running;
    const alerts = await chatAlerts(store);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.detail).toBeNull();
  });

  it("evalStep returns while the run is still running", async () => {
    const { store } = await newStore();
    let finish!: (r: typeof BELOW) => void;
    const port = { claim: async () => true, run: () => new Promise<typeof BELOW>((res) => { finish = res; }) };
    const { u } = unit(port, { ms: Date.parse("2026-11-27T00:00:00Z") }, store);
    await u.evalStep();
    expect(u.running).not.toBeNull();
    expect(await chatAlerts(store)).toEqual([]);
    finish(BELOW);
    await u.running;
    expect(await chatAlerts(store)).toHaveLength(1);
  });

  it("with no run wired (the key absent) the unit does nothing", async () => {
    const { u, logs } = unit(undefined, { ms: Date.parse("2026-11-27T09:00:00Z") });
    await u.evalStep();
    expect(u.running).toBeNull();
    expect(logs).toEqual([]);
  });
});
