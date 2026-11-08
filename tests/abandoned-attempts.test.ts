import { describe, expect, it } from "vitest";
import { Controller } from "../src/core/controller.js";
import type { WorkerId } from "../src/core/types.js";
import { FakeClock } from "../src/impl/clock/fake-clock.js";
import { PatternEgressScanner } from "../src/impl/egress/pattern-egress-scanner.js";
import type { AbandonedAttempt } from "../src/interfaces/factory-store.js";
import { newStore } from "./helpers/store.js";
import { FakeAuth, FakeSource, alice, config, issueRef, recordingLog, settingsWith } from "./helpers/fakes.js";

// Design §5 Restarts (issue #210): an attempt the reaper cuts off gets an end line, "run abandoned".

async function setup(max_attempts = 3) {
  const clock = new FakeClock();
  const { store } = await newStore(clock);
  const source = new FakeSource();
  const log = recordingLog();
  const cfg = { ...config, settings: settingsWith({ max_attempts }) };
  const controller = new Controller({
    store, source, auth: new FakeAuth(), clock, config: cfg, log, scanner: new PatternEgressScanner(async () => []),
  });
  source.queue.push({ kind: "item_requested", source: issueRef(1), requester: alice, title: "t", body: "b" });
  await controller.tickIntake();
  const item = (await store.getWorkItemBySource("github_issue", issueRef(1).id))!;
  const abandoned = () => log.lines.filter((l) => l.msg === "run abandoned");
  const expired = () => log.lines.filter((l) => l.msg === "lease expired");
  return { clock, store, log, cfg, controller, item, abandoned, expired };
}

describe("abandoned attempts", () => {
  it("a run whose process died gets one abandoned line with its start, last heartbeat and duration", async () => {
    const f = await setup();
    const run = (await f.store.claimRun({ worker_id: "gone" as WorkerId, kinds: ["triage"], lease_ms: f.cfg.lease_ms }))!;
    const start = f.clock.now().getTime();
    // Two heartbeats, then the process is killed: no more heartbeats.
    f.clock.advance(f.cfg.heartbeat_ms);
    expect((await f.store.heartbeat(run.id, run.lease!.token, f.cfg.lease_ms)).ok).toBe(true);
    f.clock.advance(f.cfg.heartbeat_ms);
    expect((await f.store.heartbeat(run.id, run.lease!.token, f.cfg.lease_ms)).ok).toBe(true);
    const last = f.clock.now().getTime();
    f.clock.advance(f.cfg.lease_ms + 1);
    await f.controller.tickReaper();

    expect(f.abandoned()).toHaveLength(1);
    expect(f.abandoned()[0]).toMatchObject({
      level: "warn",
      fields: {
        run_id: run.id,
        work_item_id: f.item.id,
        attempt: 1,
        status: "abandoned",
        reason: "lease_expired",
        started_at: new Date(start).toISOString(),
        ended_at: new Date(last).toISOString(),
        duration_ms: last - start,
      },
    });
    expect(f.expired()).toEqual([{ level: "warn", msg: "lease expired", fields: { run_id: run.id } }]);
    // Outcome unchanged: requeued.
    expect((await f.store.getRun(run.id))!.status).toBe("queued");

    // A second reaper pass on the same lease writes nothing more.
    await f.controller.tickReaper();
    expect(f.abandoned()).toHaveLength(1);
    expect(f.expired()).toHaveLength(1);
  });

  it("is logged when attempts are used up (failed) and when the item is closed (cancelled)", async () => {
    const f = await setup(1);
    const run = (await f.store.claimRun({ worker_id: "gone" as WorkerId, kinds: ["triage"], lease_ms: f.cfg.lease_ms }))!;
    f.clock.advance(f.cfg.lease_ms + 1);
    await f.controller.tickReaper();
    expect((await f.store.getRun(run.id))!.status).toBe("failed");
    expect(f.abandoned().map((l) => l.fields)).toMatchObject([{ run_id: run.id, status: "abandoned", duration_ms: 0 }]);

    const g = await setup();
    const r2 = (await g.store.claimRun({ worker_id: "gone" as WorkerId, kinds: ["triage"], lease_ms: g.cfg.lease_ms }))!;
    const closed = await g.store.transition({
      id: g.item.id, expected_version: (await g.store.getWorkItem(g.item.id))!.version, patch: { stage: "CLOSED" },
      actor: { kind: "agent", id: "controller" }, reason: "test",
    } as never);
    expect(closed.ok).toBe(true);
    g.clock.advance(g.cfg.lease_ms + 1);
    await g.controller.tickReaper();
    expect((await g.store.getRun(r2.id))!.status).toBe("cancelled");
    expect(g.abandoned().map((l) => l.fields)).toMatchObject([{ run_id: r2.id, status: "abandoned", reason: "lease_expired" }]);
  });

  it("the store reports each attempt it closes only once, with a null duration when started_at is missing", async () => {
    const f = await setup();
    const run = (await f.store.claimRun({ worker_id: "gone" as WorkerId, kinds: ["triage"], lease_ms: f.cfg.lease_ms }))!;
    f.clock.advance(f.cfg.lease_ms + 1);
    const seen: AbandonedAttempt[] = [];
    // A row with no started_at (older rows): the line is still written, duration null.
    const db = (f.store as unknown as { db: { run(sql: string, p: unknown[]): Promise<number> } }).db;
    await db.run("UPDATE worker_runs SET started_at = NULL WHERE id = ?", [run.id]);
    expect(await f.store.expireLeases(3, undefined, (a) => seen.push(a))).toEqual([run.id]);
    expect(await f.store.expireLeases(3, undefined, (a) => seen.push(a))).toEqual([]);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ run_id: run.id, work_item_id: f.item.id, attempt: 1, started_at: null, duration_ms: null });
    expect(seen[0]!.ended_at).toBe(run.updated_at);
  });
});
