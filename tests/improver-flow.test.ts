import { describe, expect, it } from "vitest";
import { ControllerRole } from "../src/runtime/roles/controller-role.js";
import { FLAKY_TEST, GATE_PATHS, MAX_DRAFT_CALLS, enqueueImprove, isGatePath, runImprove, systemSource } from "../src/core/improver.js";
import { Worker } from "../src/worker/index.js";
import type { ImproveReport, Run, RunId, WorkerId } from "../src/core/types.js";
import type { AgentRunner } from "../src/interfaces/agent-runner.js";
import type { FactoryStore } from "../src/interfaces/factory-store.js";
import type { LLMProvider, LLMRequest, LLMResponse } from "../src/interfaces/llm-provider.js";
import { NoKeepAwake } from "../src/impl/awake/no-keep-awake.js";
import { FakeClock } from "../src/impl/clock/fake-clock.js";
import { LocalSource } from "../src/impl/source/local-source.js";
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

function ok(parsed: unknown = { cause: "the flaky test", fix: "pin the port in tests/x.test.ts", touches: ["tests/x.test.ts"], needs_person: false }): LLMResponse {
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

/** Fails another triage run (idempotency key `key`) on the item of run `of` with `code`, as failRun's runs. */
async function failAgain(store: FactoryStore, of: RunId, code: string, key: string): Promise<RunId> {
  const { run: queued } = await store.enqueueRun({ work_item_id: (await store.getRun(of))!.work_item_id, kind: "triage", idempotency_key: key });
  const run = (await store.claimRun({ worker_id: "seed" as WorkerId, kinds: ["triage"], lease_ms: 60_000 }))!;
  expect(run.id).toBe(queued.id);
  await store.completeRun(run.id, run.lease!.token, { status: "failed", error_code: code, detail: "same detail", infra: false });
  return run.id;
}

/** A green merge-check run of a new item `n` whose one rerun passed `flaky` (design §4): its outcome names them. */
async function flakyMergeCheck(store: FactoryStore, n: number, flaky: string[]): Promise<RunId> {
  await store.createWorkItem(issue(n), system, { enqueue: { kind: "merge-check", idempotency_key: `m${n}` } });
  const run = (await store.claimRun({ worker_id: "seed" as WorkerId, kinds: ["merge-check"], lease_ms: 60_000 }))!;
  await store.completeRun(run.id, run.lease!.token, { status: "succeeded", summary: "", data: { result: "green", flaky_tests: flaky } });
  return run.id;
}

/**
 * A store with failed runs inside tomorrow's daily window and that window's improve run queued. `groups`: per
 * group, its run count; each group gets its own code. Plus one single-run pattern. `more`: per group, its runs added
 * again on the item of its first run (so a group can have more runs than items).
 */
async function world(
  groups: number[], transcripts: (group: number, i: number) => string | undefined = () => "npm test failed", flaky: string[][] = [],
  more: number[] = [],
) {
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
  for (const [g, count] of more.entries()) {
    for (let i = 0; i < count; i++) {
      clock.advance(1_000);
      ids[g]!.push(await failAgain(store, ids[g]![0]!, `code_${g}`, `again${g}-${i}`));
    }
  }
  clock.advance(1_000);
  const pattern = await failRun(store, storage, ++n, "lonely", "only once", "once");
  const checks: RunId[] = [];
  for (const names of flaky) {
    clock.advance(1_000);
    checks.push(await flakyMergeCheck(store, ++n, names));
  }
  clock.set("2026-03-05T06:00:00.000Z");
  const { run } = await enqueueImprove({ store, clock }, PROJECT.key, "daily");
  return { clock, store, storage, ids, pattern, checks, run };
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
      status: "drafted", cause: "the flaky test", fix: "pin the port in tests/x.test.ts", touches: ["tests/x.test.ts"], touches_prompts_or_gate: false, needs_person: false,
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
    expect(req!.output_schema).toMatchObject({ required: ["cause", "fix", "touches", "needs_person"] });
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
    ["invalid_output", () => ok({ cause: "c", fix: "f", touches: [] })],
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
    const llm = new CountingLLM(() => ok({ cause: `leaked ${TOKEN}`, fix: "edit prompts/implement.md", touches: ["prompts/implement.md"], needs_person: false }));
    await worker(w, llm).tick();
    const { report: r } = await report(w);
    expect(r.groups[0]!.draft).toEqual({ status: "withheld", rules: ["github_token"], touches_prompts_or_gate: true, needs_person: false });
    expect(JSON.stringify(r)).not.toContain(TOKEN);
  });

  it("touches_prompts_or_gate is set by the factory from the paths the fix names", async () => {
    const w = await world([2, 2]);
    const answers = [
      ok({ cause: "c", fix: "tighten the scan", touches: ["./src/impl/egress/pattern-egress-scanner.ts", "src/core/worker.ts"], needs_person: false }),
      ok({ cause: "c", fix: "retry", touches: ["src/core/worker.ts"], needs_person: true }),
    ];
    await worker(w, new CountingLLM((_req, n) => answers[n - 1]!)).tick();
    const { report: r } = await report(w);
    expect(r.groups.map((g) => g.draft?.status === "drafted" && g.draft.touches_prompts_or_gate)).toEqual([true, false]);
    // needs_person is the model's answer, kept as it gave it.
    expect(r.groups.map((g) => g.draft?.status === "drafted" && g.draft.needs_person)).toEqual([false, true]);
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
    const c = new ControllerRole({ store: w.store, sources: [source, slack], forge, auth: new FakeAuth(), clock: w.clock, config, log: silent, scanner: cleanScanner });
    calls.length = 0;
    await worker(w, new CountingLLM()).tick();
    await c.tickRuns();
    expect((await w.store.getRun(w.run.id))!.acknowledged_at).not.toBeNull();
    expect(calls).toEqual([]);
    expect((await w.store.listTables()).find((t) => t.name === "controller_filed_patterns")!.rows).toBe(0);
    expect(await w.store.getWorkItemBySource("local", systemSource(PROJECT.key).id)).toMatchObject({ stage: "NEW" });
  });
});

describe("improve: what a failure pattern needs before it is filed", () => {
  it("3 runs on 2 items files one item; 2 runs on 1 item, 3 runs on 1 item and 2 runs on 2 items stay in the report only", async () => {
    // code_0: 3 runs on 2 items; code_1: 2 runs on 1 item; code_2: 3 runs on 1 item; code_3: 2 runs on 2 items.
    const w = await world([2, 1, 1, 2], undefined, [], [1, 1, 2, 0]);
    await worker(w, new CountingLLM()).tick();
    const c = new ControllerRole({ store: w.store, sources: [new LocalSource(w.store)], auth: new FakeAuth(), clock: w.clock, config, log: silent, scanner: cleanScanner });
    await c.applyRun((await w.store.getRun(w.run.id))!);

    const { report: r } = await report(w);
    const byCode = new Map(r.groups.map((g) => [g.error_code, g]));
    expect([...byCode.keys()].sort()).toEqual(["code_0", "code_1", "code_2", "code_3"]);
    expect(byCode.get("code_0")).toMatchObject({ filing: { status: "filed" } });
    expect([byCode.get("code_0")!.run_ids.length, byCode.get("code_0")!.work_item_ids.length]).toEqual([3, 2]);
    for (const code of ["code_1", "code_2", "code_3"]) expect(byCode.get(code)!.filing, code).toBeUndefined();
    const filed = (await w.store.listWorkItems(100)).filter((i) => i.source.id.startsWith("local-filed-"));
    expect(filed.map((i) => i.title)).toEqual(["Recurring failure: code_0 in 3 runs"]);
  });
});

describe("improve: flaky tests from merge checks", () => {
  it("the report lists each flaky test a merge check named in its window, with its runs, and asks no model about it", async () => {
    const A = "tests/a.test.ts > merged > flaky", B = "tests/b.test.ts > other > case 2";
    const w = await world([], undefined, [[A], [A, B]]);
    const llm = new CountingLLM();
    await worker(w, llm).tick();
    const { run, report: r } = await report(w);
    expect(run.status).toBe("succeeded");
    expect(llm.requests).toEqual([]);
    expect(r.groups).toEqual([]);
    const flaky = r.patterns.filter((p) => p.error_code === FLAKY_TEST);
    expect(flaky).toEqual([
      { error_code: FLAKY_TEST, detail: A, run_ids: w.checks, work_item_ids: expect.any(Array) },
      { error_code: FLAKY_TEST, detail: B, run_ids: [w.checks[1]], work_item_ids: expect.any(Array) },
    ]);
    // The failed runs' patterns are kept, before the flaky tests.
    expect(r.patterns[0]).toMatchObject({ error_code: "lonely", run_ids: [w.pattern] });
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
    for (const p of ["src/core/worker.ts", "src/core/policy.test.ts", "docs/prompts/x.md", "src/impl/store/x.ts", "factory.config.json.bak",
      "src/impl/github/github-issue-source.ts"]) {
      expect(isGatePath(p), p).toBe(false);
    }
  });
});
