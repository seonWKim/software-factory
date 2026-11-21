import { describe, expect, it } from "vitest";
import { storeSql } from "../src/impl/store/sql/store-sql.js";
import { pipeline } from "./helpers/fakes.js";

// Issue #718: a run whose journal holds a succeeded step written by another code_version (a deploy between the
// step and the takeover) is no longer failed as `not_resumable`. It ends as `code_version_restart`, an infra
// failure, and the controller requeues the step as a new run with a new journal, which runs from the start and
// counts as an infra restart (design 10-event-driven, "Claims still go through the store"; 05-restarts).

describe("a run journaled by another code_version", () => {
  it("is requeued as a new run from the start, counted as an infra restart, not failed with not_resumable", async () => {
    const f = await pipeline();
    const it0 = await f.submit();
    const [first] = await f.runs(it0, "triage");
    const sql = storeSql(f.store);
    // Old code finished the agent step, then the run went back to the queue (its worker restarted on a deploy).
    const at = f.clock.now().toISOString();
    await sql.run("UPDATE worker_runs SET code_version = ? WHERE id = ?", ["v-old", first!.id]);
    await sql.run(
      "INSERT INTO worker_run_steps (run_id, step_id, attempt, status, result_ref, error_code, started_at, finished_at) VALUES (?, 'run-agent', 1, 'succeeded', ?, NULL, ?, ?)",
      [first!.id, JSON.stringify({ written_by: "v-old" }), at, at],
    );

    await f.step();
    expect(await f.store.getRun(first!.id)).toMatchObject({
      status: "failed", outcome: { status: "failed", error_code: "code_version_restart", infra: true },
    });
    expect(f.agentCalls("triage")).toBe(0);
    expect(await f.item(it0)).toMatchObject({ blocked_on: "none", restart_count: 1 });
    const retry = (await f.runs(it0, "triage")).find((r) => r.id !== first!.id);
    expect(retry).toMatchObject({ status: "queued" });

    // The retry is a new run with its own journal: it runs the agent on the new code.
    f.clock.advance(f.config.retry_max_ms);
    await f.step();
    expect(await f.store.getRun(retry!.id)).toMatchObject({ status: "succeeded" });
    expect(f.agentCalls("triage")).toBeGreaterThan(0);
    const steps = await sql.all("SELECT result_ref FROM worker_run_steps WHERE run_id = ?", [retry!.id]);
    expect(steps.map((s) => String(s.result_ref))).not.toContain(JSON.stringify({ written_by: "v-old" }));
    expect((await f.runs(it0)).some((r) => r.outcome?.status === "failed" && r.outcome.error_code === "not_resumable")).toBe(false);
  });
});
