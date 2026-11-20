import { describe, expect, it } from "vitest";
import { Worker } from "../src/worker/index.js";
import type { WorkerId } from "../src/core/types.js";
import { NoKeepAwake } from "../src/impl/awake/no-keep-awake.js";
import { FakeClock } from "../src/impl/clock/fake-clock.js";
import { PatternEgressScanner } from "../src/impl/egress/pattern-egress-scanner.js";
import { storeSql } from "../src/impl/store/sql/store-sql.js";
import { issue, newStore, system } from "./helpers/store.js";
import { FakeBroker, FakeRunner, FakeSandbox, MemoryStorage, config, prompts, recordingLog, triageSpec } from "./helpers/fakes.js";

// Issue #718: a run whose journal holds a succeeded step written by another code_version (a deploy between the
// step and the takeover) is no longer failed as `not_resumable`. The worker that claims it on new code drops the
// old journal and runs the run from the start (design 10-event-driven, "Claims still go through the store").

describe("a run journaled by another code_version", () => {
  it("is run again from the start on the new code, not failed with not_resumable", async () => {
    const clock = new FakeClock();
    const { store } = await newStore(clock);
    const { item } = await store.createWorkItem(issue(1), system, { enqueue: { kind: "triage", idempotency_key: "t" } });
    const [queued] = await store.listRuns(item.id);
    const sql = storeSql(store);
    // Old code finished the agent step, then the run went back to the queue (its worker restarted on a deploy).
    const at = clock.now().toISOString();
    await sql.run("UPDATE worker_runs SET code_version = ? WHERE id = ?", ["v-old", queued!.id]);
    await sql.run(
      "INSERT INTO worker_run_steps (run_id, step_id, attempt, status, result_ref, error_code, started_at, finished_at) VALUES (?, 'run-agent', 1, 'succeeded', ?, NULL, ?, ?)",
      [queued!.id, JSON.stringify({ written_by: "v-old" }), at, at],
    );

    let agentRuns = 0;
    const runner = new FakeRunner({
      triage: () => {
        agentRuns++;
        return { output: triageSpec };
      },
    });
    const log = recordingLog();
    const worker = new Worker({
      id: "w1" as WorkerId, store, sandbox: new FakeSandbox(), runner, broker: new FakeBroker(), storage: new MemoryStorage(),
      clock, config, prompts, log, scanner: new PatternEgressScanner(async () => []), toolEnv: {}, awake: new NoKeepAwake(), code_version: "v-new",
    });

    expect(await worker.tick()).toBe(true);
    const run = (await store.getRun(queued!.id))!;
    expect(run.outcome).not.toMatchObject({ error_code: "not_resumable" });
    expect(run).toMatchObject({ status: "succeeded" });
    // From the start: the agent step ran on the new code, and the journal holds only the new code's step.
    expect(agentRuns).toBe(1);
    const steps = await sql.all("SELECT step_id, attempt, status, result_ref FROM worker_run_steps WHERE run_id = ?", [run.id]);
    expect(steps.map((s) => [s.step_id, Number(s.attempt), s.status])).toEqual([["run-agent", run.attempt, "succeeded"]]);
    expect(steps.map((s) => String(s.result_ref))).not.toContain(JSON.stringify({ written_by: "v-old" }));
    const [row] = await sql.all("SELECT code_version FROM worker_runs WHERE id = ?", [run.id]);
    expect(row).toMatchObject({ code_version: "v-new" });
    expect(log.lines.find((l) => l.msg === "journal from another code_version dropped; the run starts over")?.fields).toMatchObject({
      run_id: run.id, code_version: "v-old",
    });
  });
});
