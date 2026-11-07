import { describe, expect, it } from "vitest";
import { stallConfig } from "../src/compose.js";
import { Controller } from "../src/core/controller.js";
import { AGENT_STALLED, failureClass, retryKey } from "../src/core/policy.js";
import type { RunKind, RunOutcome, Timestamp } from "../src/core/types.js";
import type { LLMRequest, LLMResponse } from "../src/interfaces/llm-provider.js";
import { modelStallChecks, modelStallLine } from "../src/ui/factory-status.js";
import { HealthMonitor } from "../src/ui/health.js";
import { FakeAuth, cleanScanner, pipeline } from "./helpers/fakes.js";
import { issue, system, w1 } from "./helpers/store.js";

// Design §5 Restarts, stalls: a run that ends `stalled` (the model printed nothing for stall_ms) spends no
// attempt and no restart. Its retry is queued under the step's key, and every claim pauses (`model_stall`)
// until a probe on the cheap model gets an answer; a failed probe moves the pause probe_interval_ms later.

const PROBE_MS = 600_000;
const iso = (ms: number) => new Date(ms).toISOString() as Timestamp;
const failed = (error_code: string, infra = false): RunOutcome => ({ status: "failed", error_code, detail: "", infra });

/** An LLM whose answers are scripted: true answers, false fails (stop_reason error), "throw" throws. */
function probeLLM(answers: (boolean | "throw")[]) {
  const requests: LLMRequest[] = [];
  return {
    requests,
    complete: async (req: LLMRequest): Promise<LLMResponse> => {
      requests.push(req);
      const a = answers.shift() ?? true;
      if (a === "throw") throw new Error("spawn failed");
      return { text: a ? "OK" : "", stop_reason: a ? "end" : "error", usage: { input_tokens: 1, output_tokens: 1, cost_usd: null } };
    },
  };
}

/** A pipeline whose first implement run stalls, and a second controller that runs the probes with `llm`. */
async function stalled(answers: (boolean | "throw")[] = [], error = "no model output for stall_ms (300000 ms) with no tool call open") {
  let first = true;
  const f = await pipeline({
    implement: () => {
      if (first) {
        first = false;
        return { status: "stalled", output: null, error };
      }
      return { output: { summary: "the summary", next_steps: "the next steps" } };
    },
  });
  const llm = probeLLM(answers);
  const prober = new Controller({ store: f.store, source: f.source, auth: new FakeAuth(), clock: f.clock, config: f.config, log: f.log, scanner: cleanScanner, llm });
  const a = await f.submit();
  await f.w1.tick(); // triage
  await f.controller.tickRuns();
  const stalledAt = f.clock.now().getTime();
  await f.w1.tick(); // implement: stalls
  await f.controller.tickRuns();
  return { ...f, a, llm, prober, stalledAt };
}

describe("failureClass", () => {
  it("agent_stalled is its own class, neither task nor infra", () => {
    expect(failureClass(failed(AGENT_STALLED))).toBe("stalled");
    expect(failureClass(failed("agent_timed_out", true))).toBe("infra");
    expect(failureClass(failed("agent_failed"))).toBe("task");
    expect(failureClass(failed("rate_limited"))).toBe("rate_limited");
  });
});

describe("stalled runs", () => {
  it("are stored with agent_stalled, not agent_timed_out, and requeued without counting", async () => {
    const f = await stalled();
    const [run, retry] = await f.runs(f.a, "implement");
    expect(run!.outcome).toMatchObject({ status: "failed", error_code: AGENT_STALLED, infra: false });
    expect(run!.outcome).not.toMatchObject({ error_code: "agent_timed_out" });

    // One retry under the step's key plus the retry suffix; the item's restart count is unchanged.
    expect(retry).toMatchObject({ status: "queued", idempotency_key: retryKey(run!.idempotency_key) });
    expect(await f.runs(f.a, "implement")).toHaveLength(2);
    expect(await f.item(f.a)).toMatchObject({ stage: "RUNNING", blocked_on: "none", restart_count: 0 });
    const change = (await f.store.listStateChanges(f.a.id)).find((c) => c.reason === "run_stalled");
    expect(change?.detail).toMatchObject({ failure: "stalled", task_failures: 0, infra_failures: 0 });

    // Applying it again enqueues nothing more.
    await f.controller.applyRun(run!);
    expect(await f.runs(f.a, "implement")).toHaveLength(2);
  });

  it("a first-output stall records agent_stalled and starts the model_stall pause, as a silence stall does", async () => {
    const f = await stalled([], "no model output within first_output_ms (180000 ms)");
    const [run, retry] = await f.runs(f.a, "implement");
    expect(run!.outcome).toMatchObject({ status: "failed", error_code: AGENT_STALLED, infra: false });
    expect(retry).toMatchObject({ status: "queued", idempotency_key: retryKey(run!.idempotency_key) });
    expect(await f.store.getClaimPause("model_stall")).toBe(iso(f.stalledAt + PROBE_MS));
  });

  it("many stalls never reach max_attempts or max_restart", async () => {
    const f = await pipeline({ implement: () => ({ status: "stalled", output: null, error: "silent" }) });
    const llm = probeLLM([]);
    const prober = new Controller({ store: f.store, source: f.source, auth: new FakeAuth(), clock: f.clock, config: f.config, log: f.log, scanner: cleanScanner, llm });
    const a = await f.submit();
    await f.step();
    for (let i = 0; i < 5; i++) {
      f.clock.advance(PROBE_MS);
      await prober.tickModelProbe();
      await f.step();
    }
    const runs = await f.runs(a, "implement");
    expect(runs.filter((r) => r.outcome?.status === "failed" && r.outcome.error_code === AGENT_STALLED)).toHaveLength(6);
    expect(runs.at(-1)!.status).toBe("queued");
    expect(await f.item(a)).toMatchObject({ blocked_on: "none", restart_count: 0 });
  });

  it("while the stall pause is in effect, claimRun returns null for every run kind", async () => {
    const f = await stalled();
    expect(await f.store.getClaimPause("model_stall")).toBe(iso(f.stalledAt + PROBE_MS));
    const kinds: RunKind[] = ["triage", "implement", "review", "update", "resolve"];
    for (const [i, kind] of kinds.entries()) {
      await f.store.createWorkItem(issue(100 + i), system, { enqueue: { kind, idempotency_key: `k-${kind}` } });
    }
    for (const kind of kinds) expect(await f.store.claimRun({ worker_id: w1, kinds: [kind], lease_ms: 60_000 })).toBeNull();
    expect(await f.store.claimRun({ worker_id: w1, kinds, lease_ms: 60_000 })).toBeNull();
    // Still paused once the probe time has passed but no probe has answered.
    f.clock.advance(PROBE_MS + 1);
    expect(await f.store.claimRun({ worker_id: w1, kinds, lease_ms: 60_000 })).toBeNull();
    expect(await f.w2.tick()).toBe(false);
  });

  it("a failed probe moves the pause 10 minutes later; a successful one lets claims resume and the retry completes", async () => {
    const f = await stalled([false, "throw", true]);
    // Before the probe time nothing is asked.
    f.clock.advance(PROBE_MS - 1);
    await f.prober.tickModelProbe();
    expect(f.llm.requests).toHaveLength(0);

    f.clock.advance(1);
    await f.prober.tickModelProbe();
    expect(f.llm.requests).toHaveLength(1);
    expect(f.llm.requests[0]).toMatchObject({ model_class: "cheap", messages: [{ role: "user" }] });
    expect(f.llm.requests[0]!.messages).toHaveLength(1);
    const t1 = f.clock.now().getTime();
    expect(await f.store.getClaimPause("model_stall")).toBe(iso(t1 + PROBE_MS));
    expect(await f.w1.tick()).toBe(false);

    // A probe that throws is a failed probe too.
    f.clock.advance(PROBE_MS);
    await f.prober.tickModelProbe();
    const t2 = f.clock.now().getTime();
    expect(await f.store.getClaimPause("model_stall")).toBe(iso(t2 + PROBE_MS));
    expect(await f.w1.tick()).toBe(false);
    expect(await modelStallLine(f.store)).toBe(`agents paused: model not answering since ${iso(f.stalledAt)}, next probe at ${iso(t2 + PROBE_MS)}`);

    f.clock.advance(PROBE_MS);
    await f.prober.tickModelProbe();
    expect(f.llm.requests).toHaveLength(3);
    expect(f.llm.requests.every((r) => r.model_class === "cheap")).toBe(true);
    expect(await f.store.getClaimPause("model_stall")).toBeNull();
    expect(await modelStallLine(f.store)).toBeNull();

    await f.step();
    expect((await f.runs(f.a, "implement")).map((r) => r.status)).toEqual(["failed", "succeeded"]);
    expect(await f.item(f.a)).toMatchObject({ stage: "REVIEW", blocked_reason: "merge_pending" });
    // No more probes once the pause ended.
    f.clock.advance(PROBE_MS);
    await f.prober.tickModelProbe();
    expect(f.llm.requests).toHaveLength(3);
  });

  it("a stall after a pause ended starts a new one with a new since time", async () => {
    const f = await stalled([true]);
    f.clock.advance(PROBE_MS);
    await f.prober.tickModelProbe();
    expect(await modelStallLine(f.store)).toBeNull();
    f.clock.advance(5_000);
    const again = f.clock.now().getTime();
    const p = await f.store.pauseClaims(iso(again + PROBE_MS), "model_stall");
    expect(p).toMatchObject({ started: true, resume_at: iso(again + PROBE_MS) });
    expect(await modelStallLine(f.store)).toBe(`agents paused: model not answering since ${iso(again)}, next probe at ${iso(again + PROBE_MS)}`);
    // A second stall during the same pause starts nothing and keeps the since time.
    f.clock.advance(1_000);
    expect(await f.store.pauseClaims(iso(again + 1_000 + PROBE_MS), "model_stall")).toMatchObject({ started: false });
    expect(await modelStallLine(f.store)).toBe(
      `agents paused: model not answering since ${iso(again)}, next probe at ${iso(again + 1_000 + PROBE_MS)}`,
    );
  });
});

describe("who probes a due stall pause", () => {
  const controllerWith = (f: Awaited<ReturnType<typeof stalled>>, llm: ReturnType<typeof probeLLM>) =>
    new Controller({ store: f.store, source: f.source, auth: new FakeAuth(), clock: f.clock, config: f.config, log: f.log, scanner: cleanScanner, llm });

  it("a controller that did not set the pause ends it once the first one stopped ticking", async () => {
    const f = await stalled([true]);
    const first = controllerWith(f, probeLLM([]));
    // The first controller ticks before the probe time, then stops (drained): it never ticks again.
    await first.tickModelProbe();
    f.clock.advance(PROBE_MS);
    await f.prober.tickModelProbe();
    expect(f.llm.requests).toHaveLength(1);
    expect(await f.store.getClaimPause("model_stall")).toBeNull();
    expect(await modelStallLine(f.store)).toBeNull();
  });

  it("two controllers that see the same due pause call the LLM once for that due time", async () => {
    const f = await stalled();
    const llm = probeLLM([false, false]);
    const [a, b] = [controllerWith(f, llm), controllerWith(f, llm)];
    f.clock.advance(PROBE_MS);
    await Promise.all([a.tickModelProbe(), b.tickModelProbe()]);
    expect(llm.requests).toHaveLength(1);
    expect(await f.store.getClaimPause("model_stall")).toBe(iso(f.clock.now().getTime() + PROBE_MS));
    // The next due time is probed once more, by either.
    f.clock.advance(PROBE_MS);
    await Promise.all([b.tickModelProbe(), a.tickModelProbe()]);
    expect(llm.requests).toHaveLength(2);
  });

  it("an answered probe writes model_answered and claimRun takes the queued retry at once", async () => {
    const f = await stalled([true]);
    f.clock.advance(PROBE_MS);
    await f.prober.tickModelProbe();
    const rows = (await f.store.listTableRows({ table: "claim_pauses", limit: 200 }))!.rows;
    expect(rows.find((r) => r.name === "model_answered")).toBeDefined();
    // The stalled run's retry waits on no time of its own (not_before = the stall), so nothing holds it.
    const [, retry] = await f.runs(f.a, "implement");
    expect(retry!.not_before! <= f.clock.now().toISOString()).toBe(true);
    expect((await f.store.claimRun({ worker_id: w1, kinds: ["implement"], lease_ms: 60_000 }))?.id).toBe(retry!.id);
  });

  it("with no LLM provider the pause ends at its probe time", async () => {
    const f = await stalled();
    f.clock.advance(PROBE_MS - 1);
    await f.controller.tickModelProbe();
    expect(await f.store.getClaimPause("model_stall")).toBe(iso(f.stalledAt + PROBE_MS));
    f.clock.advance(1);
    await f.controller.tickModelProbe();
    expect(await f.store.getClaimPause("model_stall")).toBeNull();
    await f.step();
    expect((await f.runs(f.a, "implement")).map((r) => r.status)).toEqual(["failed", "succeeded"]);
  });
});

describe("the stall pause line", () => {
  it("factory status and the dashboard show it during a pause, and not without one", async () => {
    const f = await stalled();
    const line = `agents paused: model not answering since ${iso(f.stalledAt)}, next probe at ${iso(f.stalledAt + PROBE_MS)}`;
    // factory status
    expect(await modelStallLine(f.store)).toBe(line);
    // the dashboard's Health panel
    const health = new HealthMonitor(() => modelStallChecks(f.store), f.clock, 0);
    expect(await health.section(cleanScanner, { refresh: false })).toContain(line);

    f.clock.advance(PROBE_MS);
    await f.prober.tickModelProbe();
    expect(await modelStallLine(f.store)).toBeNull();
    expect(await health.section(cleanScanner, { refresh: false })).not.toContain("agents paused");
  });
});

describe("stall config", () => {
  it("stall_ms defaults to 300000, first_output_ms to 180000 and probe_interval_ms to 600000", () => {
    expect(stallConfig({})).toEqual({ stall_ms: 300_000, first_output_ms: 180_000, probe_interval_ms: 600_000 });
    expect(stallConfig({ stall_ms: 60_000, first_output_ms: 30_000, probe_interval_ms: 120_000 })).toEqual({ stall_ms: 60_000, first_output_ms: 30_000, probe_interval_ms: 120_000 });
  });

  it("a value that is not a positive integer fails at startup", () => {
    for (const bad of [0, -1, 1.5, "300000", null]) {
      expect(() => stallConfig({ stall_ms: bad as never })).toThrow(/stall_ms must be a positive integer/);
      expect(() => stallConfig({ probe_interval_ms: bad as never })).toThrow(/probe_interval_ms must be a positive integer/);
      expect(() => stallConfig({ first_output_ms: bad as never })).toThrow(/first_output_ms must be a positive integer/);
    }
  });
});
