import { describe, expect, it } from "vitest";
import { Controller } from "../src/core/controller.js";
import { GATE_PATHS, MAX_DRAFT_CALLS, enqueueImprove, isGatePath, runImprove, systemSource } from "../src/core/improver.js";
import { Worker } from "../src/core/worker.js";
import type { ImproveReport, Run, RunId, WorkerId } from "../src/core/types.js";
import type { AgentRunner } from "../src/interfaces/agent-runner.js";
import type { FactoryStore } from "../src/interfaces/factory-store.js";
import type { LLMProvider, LLMRequest, LLMResponse } from "../src/interfaces/llm-provider.js";
import { NoKeepAwake } from "../src/impl/awake/no-keep-awake.js";
import { FakeClock } from "../src/impl/clock/fake-clock.js";
import { issue, newStore, system } from "./helpers/store.js";
import {
  FakeAuth, FakeBroker, FakeForge, FakeSandbox, FakeSlackPollSource, FakeSource, MemoryStorage, PROJECT, cleanScanner, config, prompts, silent,
} from "./helpers/fakes.js";

const IMPROVE_PROMPT = "IMPROVE";
/** A GitHub-token-shaped string the pattern scanner flags as `github_token`. */
const TOKEN = `ghp_${"a".repeat(36)}`;

/** An LLM that counts its calls and answers each with `answer`. */
class CountingLLM implements LLMProvider {
  requests: LLMRequest[] = [];
  constructor(private readonly answer: (req: LLMRequest, n: number) => LLMResponse | Promise<LLMResponse> = () => ok()) {}
  async complete(req: LLMRequest): Promise<LLMResponse> {
    this.requests.push(req);
    return this.answer(req, this.requests.length);
  }
}

function ok(parsed: unknown = { cause: "the flaky test", fix: "pin the port in tests/x.test.ts", touches: ["tests/x.test.ts"] }): LLMResponse {
  return { text: JSON.stringify(parsed), parsed, stop_reason: "end", usage: { input_tokens: 100, output_tokens: 20, cost_usd: null } };
}

const noRunner = { run: () => { throw new Error("the improve run called the agent runner"); } } as unknown as AgentRunner;
class NoSandbox extends FakeSandbox {
  override create(): never {
    throw new Error("the improve run made a sandbox");
  }
}

/** Fails a triage run of a new item `n` with `code` and `detail`; stores `transcript` for it when given. */
async function failRun(store: FactoryStore, storage: MemoryStorage, n: number, code: string, detail: string, transcript?: string): Promise<RunId> {
  const { item } = await store.createWorkItem(issue(n), system, { enqueue: { kind: "triage", idempotency_key: `t${n}` } });
  const run = (await store.claimRun({ worker_id: "seed" as WorkerId, kinds: ["triage"], lease_ms: 60_000 }))!;
  await store.completeRun(run.id, run.lease!.token, { status: "failed", error_code: code, detail, infra: false });
  if (transcript !== undefined) await storage.put(`transcripts/${item.id}/${run.id}.json`, new TextEncoder().encode(transcript));
  return run.id;
}

/**
 * A store with failed runs inside tomorrow's daily window and that window's improve run queued. `groups`: per
 * group, its run count; each group gets its own code. Plus one single-run pattern.
 */
async function world(groups: number[], transcripts: (group: number, i: number) => string | undefined = () => "npm test failed") {
  const clock = new FakeClock("2026-03-04T01:00:00.000Z");
  const { store } = await newStore(clock);
  const storage = new MemoryStorage();
  let n = 0;
  const ids: RunId[][] = [];
  for (const [g, size] of groups.entries()) {
    ids.push([]);
    for (let i = 0; i < size; i++) {
      clock.advance(1_000);
      ids[g]!.push(await failRun(store, storage, ++n, `code_${g}`, "same detail", transcripts(g, i)));
    }
  }
  clock.advance(1_000);
  const pattern = await failRun(store, storage, ++n, "lonely", "only once", "once");
  clock.set("2026-03-05T06:00:00.000Z");
  const { run } = await enqueueImprove({ store, clock }, PROJECT.key, "daily");
  return { clock, store, storage, ids, pattern, run };
}

function worker(w: Awaited<ReturnType<typeof world>>, llm: LLMProvider, broker = new FakeBroker()): Worker {
  return new Worker({
    id: "w1" as WorkerId, store: w.store, sandbox: new NoSandbox(), runner: noRunner, broker, storage: w.storage, llm,
    clock: w.clock, config, prompts: { ...prompts, improve: IMPROVE_PROMPT }, log: silent, scanner: cleanScanner, toolEnv: {}, awake: new NoKeepAwake(),
  });
}

async function report(w: Awaited<ReturnType<typeof world>>): Promise<{ run: Run; report: ImproveReport }> {
  const run = (await w.store.getRun(w.run.id))!;
  return { run, report: (await w.store.getImproveReport(run.id))! };
}

describe("improve: drafts", () => {
  it("one model call per group of two or more runs, none for a one-run pattern; usage counts toward the run", async () => {
    const w = await world([3, 2]);
    const llm = new CountingLLM();
    expect(await worker(w, llm).tick()).toBe(true);
    expect(llm.requests).toHaveLength(2);
    const { run, report: r } = await report(w);
    expect(run.status).toBe("succeeded");
    expect(r.groups.map((g) => g.draft?.status)).toEqual(["drafted", "drafted"]);
    expect(r.groups[0]!.draft).toEqual({
      status: "drafted", cause: "the flaky test", fix: "pin the port in tests/x.test.ts", touches: ["tests/x.test.ts"], touches_prompts_or_gate: false,
    });
    expect(r.patterns.map((p) => p.run_ids)).toEqual([[w.pattern]]);
    expect(r.patterns[0]!.draft).toBeUndefined();
    expect(run.outcome).toMatchObject({ status: "succeeded", data: { tokens: 240 } });
  });

  it("the call is a plain completion: only its fields, standard class, test data, the cause/fix/touches schema, a signal", async () => {
    const w = await world([2]);
    const llm = new CountingLLM();
    const broker = new FakeBroker();
    await worker(w, llm, broker).tick();
    const [req] = llm.requests;
    expect(Object.keys(req!).sort()).toEqual(["data_env", "max_tokens", "messages", "model_class", "output_schema", "signal", "system"]);
    expect(req).toMatchObject({ model_class: "standard", data_env: "test", system: IMPROVE_PROMPT });
    expect(req!.output_schema).toMatchObject({ required: ["cause", "fix", "touches"] });
    expect(req!.signal).toBeInstanceOf(AbortSignal);
    expect(req!.messages.map((m) => m.role)).toEqual(["user"]);
    expect(broker.calls).toEqual([]);
    expect(broker.preflights).toEqual([]);
  });

  it("a flagged tail is left out of the prompt and marked withheld with its rule; a run with no transcript is missing", async () => {
    const w = await world([3], (_, i) => (i === 0 ? `the log ends with ${TOKEN}` : i === 1 ? undefined : "clean tail text"));
    const llm = new CountingLLM();
    await worker(w, llm).tick();
    const prompt = llm.requests[0]!.messages[0]!.content;
    expect(prompt).not.toContain(TOKEN);
    expect(prompt).toContain("clean tail text");
    const { report: r } = await report(w);
    expect(r.groups[0]!.tails).toEqual([
      { run_id: w.ids[0]![0], status: "withheld", rules: ["github_token"] },
      { run_id: w.ids[0]![1], status: "missing" },
      { run_id: w.ids[0]![2], status: "included" },
    ]);
    expect(JSON.stringify(r)).not.toContain(TOKEN);
  });

  it.each([
    ["invalid_output", () => ok({ cause: "x" })],
    ["invalid_output", () => ({ ...ok(), parsed: undefined, text: "not json" })],
    ["refused", () => ({ ...ok(), stop_reason: "refused" as const })],
    ["max_tokens", () => ({ ...ok(), stop_reason: "max_tokens" as const })],
    ["error", () => ({ ...ok(), stop_reason: "error" as const })],
    ["error", () => Promise.reject(new Error("provider down"))],
  ])("%s marks the group's draft failed; the run still completes with its report", async (reason, answer) => {
    const w = await world([2, 2]);
    const llm = new CountingLLM((_req, n) => (n === 1 ? answer() : ok()));
    await worker(w, llm).tick();
    const { run, report: r } = await report(w);
    expect(run.status).toBe("succeeded");
    expect(r.groups.map((g) => g.draft)).toEqual([{ status: "failed", reason }, expect.objectContaining({ status: "drafted" })]);
  });

  it("a flagged draft is stored withheld with its rule, never its text", async () => {
    const w = await world([2]);
    const llm = new CountingLLM(() => ok({ cause: `leaked ${TOKEN}`, fix: "edit prompts/implement.md", touches: ["prompts/implement.md"] }));
    await worker(w, llm).tick();
    const { report: r } = await report(w);
    expect(r.groups[0]!.draft).toEqual({ status: "withheld", rules: ["github_token"], touches_prompts_or_gate: true });
    expect(JSON.stringify(r)).not.toContain(TOKEN);
  });

  it("touches_prompts_or_gate is set by the factory from the paths the fix names", async () => {
    const w = await world([2, 2]);
    const answers = [
      ok({ cause: "c", fix: "tighten the scan", touches: ["./src/impl/egress/pattern-egress-scanner.ts", "src/core/worker.ts"] }),
      ok({ cause: "c", fix: "retry", touches: ["src/core/worker.ts"] }),
    ];
    await worker(w, new CountingLLM((_req, n) => answers[n - 1]!)).tick();
    const { report: r } = await report(w);
    expect(r.groups.map((g) => g.draft?.status === "drafted" && g.draft.touches_prompts_or_gate)).toEqual([true, false]);
  });

  it("caps the calls per run, largest groups first; the report lists the groups it skipped", async () => {
    const sizes = Array.from({ length: MAX_DRAFT_CALLS + 2 }, (_, i) => (i < 2 ? 3 : 2));
    const w = await world(sizes, () => undefined);
    const llm = new CountingLLM();
    await worker(w, llm).tick();
    expect(llm.requests).toHaveLength(MAX_DRAFT_CALLS);
    const { report: r } = await report(w);
    const drafted = r.groups.filter((g) => g.draft?.status === "drafted");
    const skipped = r.groups.filter((g) => g.draft?.status === "skipped");
    expect(drafted).toHaveLength(MAX_DRAFT_CALLS);
    expect(skipped.map((g) => g.draft)).toEqual([{ status: "skipped", reason: "call_cap" }, { status: "skipped", reason: "call_cap" }]);
    // The two three-run groups are among the drafted ones; every skipped group is no larger than a drafted one.
    expect(drafted.slice(0, 2).map((g) => g.run_ids.length)).toEqual([3, 3]);
    expect(Math.max(...skipped.map((g) => g.run_ids.length))).toBeLessThanOrEqual(Math.min(...drafted.map((g) => g.run_ids.length)));
  });

  it("a retry of a run whose report exists makes no model call and stores no second report", async () => {
    const w = await world([2]);
    const llm = new CountingLLM();
    await worker(w, llm).tick();
    const { run, report: first } = await report(w);
    const d = { store: w.store, storage: w.storage, scanner: cleanScanner, llm, prompt: IMPROVE_PROMPT };
    expect(await runImprove(d, run, { project: PROJECT.key })).toEqual(first);
    expect(llm.requests).toHaveLength(1);
    expect(await w.store.getImproveReport(run.id)).toEqual(first);
  });

  it("nothing is filed or posted: filed_patterns stays empty, no source, forge or Slack adapter is called", async () => {
    const w = await world([2, 2]);
    const calls: string[] = [];
    const record = <T extends object>(name: string, target: T): T =>
      new Proxy(target, {
        get(t, key, recv) {
          const v = Reflect.get(t, key, recv) as unknown;
          return typeof v === "function" ? (...args: unknown[]) => (calls.push(`${name}.${String(key)}`), (v as (...a: unknown[]) => unknown).apply(t, args)) : v;
        },
      });
    const source = record("source", new FakeSource());
    const slack = record("slack", new FakeSlackPollSource());
    const forge = record("forge", new FakeForge());
    const c = new Controller({ store: w.store, sources: [source, slack], forge, auth: new FakeAuth(), clock: w.clock, config, log: silent, scanner: cleanScanner });
    calls.length = 0;
    await worker(w, new CountingLLM()).tick();
    await c.tickRuns();
    expect((await w.store.getRun(w.run.id))!.acknowledged_at).not.toBeNull();
    expect(calls).toEqual([]);
    expect((await w.store.listTables()).find((t) => t.name === "filed_patterns")!.rows).toBe(0);
    expect(await w.store.getWorkItemBySource("local", systemSource(PROJECT.key).id)).toMatchObject({ stage: "NEW" });
  });
});

describe("improve: the gate list", () => {
  it("holds the owner-only paths the merge check treats as gates", () => {
    expect(GATE_PATHS).toEqual(expect.arrayContaining([
      "prompts/", "src/impl/broker/", "src/impl/egress/", "src/impl/secrets/", "src/impl/sandbox/", "src/impl/auth/",
      "src/core/checks.ts", "src/core/policy.ts", ".claude/", "factory.config.json",
    ]));
  });

  it("matches files under a gate folder and gate files exactly, nothing looser", () => {
    for (const p of ["prompts/implement.md", "./src/impl/auth/x.ts", "/factory.config.json", "src/core/policy.ts", ".claude/settings.json", "prompts"]) {
      expect(isGatePath(p), p).toBe(true);
    }
    for (const p of ["src/core/worker.ts", "src/core/policy.test.ts", "docs/prompts/x.md", "src/impl/store/x.ts", "factory.config.json.bak"]) {
      expect(isGatePath(p), p).toBe(false);
    }
  });
});
