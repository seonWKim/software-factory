import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Timestamp, UserId, WorkerId } from "../src/core/types.js";
import { LiveSettings, baseFromConfig } from "../src/core/settings.js";
import { BACKGROUND_JOBS } from "../src/controller/background-jobs.js";
import { CleanupUnit, type CleanupLeaseStore, type CleanupPort } from "../src/controller/units/cleanup/cleanup.unit.js";
import type { Ctx } from "../src/controller/units/context.js";
import { NoKeepAwake } from "../src/impl/awake/no-keep-awake.js";
import { FakeClock } from "../src/impl/clock/fake-clock.js";
import { PatternEgressScanner } from "../src/impl/egress/pattern-egress-scanner.js";
import { ACTIVITY_RETENTION_DAYS, prunedWithActivity } from "../src/impl/store/sql/activity.js";
import { migrateSqlite } from "../src/impl/store/sqlite/rehearse.js";
import { SqliteDriver } from "../src/impl/store/sqlite/sqlite-driver.js";
import { ControllerRole } from "../src/runtime/roles/controller-role.js";
import { MIGRATIONS_TABLE } from "../src/state/index.js";
import { Worker } from "../src/worker/index.js";
import { issue, newStore, system, w1 } from "./helpers/store.js";
import { FakeAuth, FakeRunner, FakeSandbox, MemoryStorage } from "./helpers/fakes/runner.js";
import { FakeBroker } from "./helpers/fakes/broker.js";
import { FakeForge } from "./helpers/fakes/forge.js";
import { FakeSource } from "./helpers/fakes/source.js";
import { alice, config, issueRef, prompts, recordingLog, silent, triageSpec } from "./helpers/fakes/config.js";

// The Activity record (design 08-schedules-actions): one controller_activity row per autonomous action, with its
// actor ID, kind, subject, outcome, reason, a transcript or log reference and its time, written in the transaction
// of the change it records.

const LEASE = 60_000;
const DAY = 86_400_000;
const actorOf = (kind: string) => BACKGROUND_JOBS.find((j) => j.kind === kind)!.actor_id;

describe("the actions table", () => {
  it("holds one row per action with actor ID, kind, subject, outcome, reason, reference and the store's time", async () => {
    const { store, clock } = await newStore(new FakeClock("2026-11-26T10:00:00.000Z"));
    const row = await store.recordActivity({ actor_id: "system:cleanup", kind: "cleanup", subject: "cleanup:h1", outcome: "removed", reason: "unused", ref: "log:controller:cleanup sweep" });
    expect(row).toMatchObject({ actor_id: "system:cleanup", kind: "cleanup", subject: "cleanup:h1", outcome: "removed", reason: "unused", ref: "log:controller:cleanup sweep", at: "2026-11-26T10:00:00.000Z" });
    clock.advance(1000);
    const none = await store.recordActivity({ actor_id: "system:cleanup", kind: "cleanup", subject: "cleanup:h1", outcome: "failed", reason: "busy", ref: null });
    expect(none.ref).toBeNull();
    const cols = (await store.db.all("SELECT name FROM pragma_table_info('controller_activity')")).map((r) => r.name);
    expect(cols).toEqual(expect.arrayContaining(["actor_id", "kind", "subject", "outcome", "reason", "ref", "at"]));
    const listed = await store.listActivity({ kind: "cleanup" });
    expect(listed.map((a) => a.seq)).toEqual([none.seq, row.seq]); // newest first
  });

  it("is a fresh store's: no row for the migrations that built it (no backfill)", async () => {
    const { store } = await newStore();
    expect(await store.listActivity()).toEqual([]);
  });
});

describe("lease expiry", () => {
  it("writes one lease_expiry row per run it moved, with the reason and the run's transcript", async () => {
    const { store, clock } = await newStore();
    const { item } = await store.createWorkItem(issue(1), system, { enqueue: { kind: "triage", idempotency_key: "t" } });
    const run = (await store.claimRun({ worker_id: w1, kinds: ["triage"], lease_ms: LEASE }))!;
    clock.advance(LEASE + 1);
    expect(await store.expireLeases(3)).toEqual([run.id]);
    const [row] = await store.listActivity({ kind: "lease_expiry" });
    expect(row).toMatchObject({ actor_id: actorOf("lease_expiry"), subject: run.id, outcome: "requeued", ref: `/api/v1/items/${item.id}/runs/${run.id}/transcript` });
    expect(row!.reason).toContain("lease expired");
    expect(row!.reason).toContain("attempt 1 of 3");
    // Nothing left to expire: no new row.
    await store.expireLeases(3);
    expect(await store.listActivity({ kind: "lease_expiry" })).toHaveLength(1);
  });
});

describe("retention", () => {
  it("a history batch that deletes rows writes one retention row with its counts; one that deletes none writes none", async () => {
    const { store, clock } = await newStore(new FakeClock("2026-10-01T00:00:00.000Z"));
    await store.recordActivity({ actor_id: "system:cleanup", kind: "cleanup", subject: "old", outcome: "removed", reason: "r", ref: null });
    clock.advance((ACTIVITY_RETENTION_DAYS + 1) * DAY);
    const counts = await store.pruneHistory(90 * DAY, 100);
    expect(counts.controller_activity).toBe(1);
    const rows = await store.listActivity();
    expect(rows.map((a) => a.subject)).toEqual(["history"]);
    expect(rows[0]).toMatchObject({ actor_id: actorOf("retention"), kind: "retention", outcome: "deleted" });
    expect(rows[0]!.reason).toContain("controller_activity 1");
    expect(rows[0]!.ref).toMatch(/^log:/);
    await store.pruneHistory(90 * DAY, 100);
    expect(await store.listActivity({ kind: "retention" })).toHaveLength(1);
  });

  it("a batch that fails after deleting rolls back its deletes and its row together", async () => {
    const { store, clock } = await newStore();
    await store.recordActivity({ actor_id: "system:cleanup", kind: "cleanup", subject: "kept", outcome: "removed", reason: "r", ref: null });
    clock.advance((ACTIVITY_RETENTION_DAYS + 1) * DAY);
    const db = store.db;
    await expect(prunedWithActivity(db, () => clock.now().toISOString() as Timestamp, "history", DAY, async (tx) => {
      await tx.run("DELETE FROM controller_activity");
      throw new Error("boom");
    })).rejects.toThrow("boom");
    expect((await store.listActivity()).map((a) => a.subject)).toEqual(["kept"]);
  });
});

describe("a schedule run", () => {
  const DUE = "2026-11-23T09:00:00.000Z" as Timestamp;
  const added = async () => {
    const { store, clock } = await newStore(new FakeClock("2026-11-23T09:00:01.000Z"));
    await store.addSchedule({ id: "sch_1", title: "Daily", cadence: { kind: "daily", spec: "09:00" }, zone: "UTC", created_by: "local:owner" as UserId, created_at: "2026-11-22T12:00:00.000Z" as Timestamp, next_due_at: DUE });
    return { store, clock };
  };

  it("stores its reason and a reference on its run row and writes its schedule_run row in the claim", async () => {
    const { store } = await added();
    expect(await store.claimScheduleOccurrence({ schedule_id: "sch_1", occurrence_at: DUE, next_due_at: "2026-11-24T09:00:00.000Z" as Timestamp, outcome: "fired" })).not.toBeNull();
    const [run] = await store.db.all("SELECT reason, ref FROM controller_schedule_runs WHERE schedule_id = 'sch_1'");
    expect(run!.reason).toBe(`due at ${DUE}`);
    expect(String(run!.ref)).toContain("sch_1");
    const [row] = await store.listActivity({ kind: "schedule_run" });
    expect(row).toMatchObject({ actor_id: actorOf("schedule_run"), subject: "sch_1", outcome: "fired", reason: run!.reason, ref: run!.ref });
  });

  it("a lost claim stores no run row and no Activity row", async () => {
    const { store } = await added();
    expect(await store.claimScheduleOccurrence({ schedule_id: "sch_1", occurrence_at: "2026-11-22T09:00:00.000Z" as Timestamp, next_due_at: DUE, outcome: "fired" })).toBeNull();
    expect(await store.listActivity({ kind: "schedule_run" })).toEqual([]);
  });
});

describe("a transition's Activity row (auto-grant)", () => {
  it("commits with the transition and is not written when the transition loses its version", async () => {
    const { store } = await newStore();
    const { item } = await store.createWorkItem(issue(1), system);
    const activity = { actor_id: actorOf("auto_grant"), kind: "auto_grant", subject: item.id, outcome: "granted", reason: "test paths only", ref: null };
    const lost = await store.transition({ id: item.id, expected_version: item.version + 1, patch: {}, actor: system, reason: "retry_requested", activity });
    expect(lost.ok).toBe(false);
    expect(await store.listActivity()).toEqual([]);
    const won = await store.transition({ id: item.id, expected_version: item.version, patch: {}, actor: system, reason: "retry_requested", activity });
    expect(won.ok).toBe(true);
    expect(await store.listActivity()).toEqual([expect.objectContaining(activity)]);
  });

  it("an implement run's test-paths ask granted automatically writes one auto_grant row with the grant's reason and the run's transcript", async () => {
    const clock = new FakeClock();
    const { store } = await newStore(clock);
    const source = new FakeSource(), broker = new FakeBroker(), scanner = new PatternEgressScanner(async () => []);
    const tests = ["tests/ui-link-style.test.tsx"];
    let calls = 0;
    const runner = new FakeRunner({
      triage: () => ({ output: triageSpec }), review: () => ({ output: { verdict: "pass", tier: 2, findings: [], summary: "s" } }),
      implement: () => (++calls === 1 ? { output: { needs_human: { reason: "A test breaks.", question: "Allow it?", paths: tests } } } : { output: { summary: "s", next_steps: "n" } }),
    });
    const c = new ControllerRole({
      store, source, forge: new FakeForge(null, broker.calls), auth: new FakeAuth(), clock, config, log: recordingLog(), scanner,
      settings: new LiveSettings({ config, base: baseFromConfig(config), source: store }),
    });
    const worker = new Worker({
      id: "w1" as WorkerId, store, sandbox: new FakeSandbox(), runner, broker, storage: new MemoryStorage(), clock, config, prompts, log: silent, scanner,
      toolEnv: { PATH: "/usr/bin" }, awake: new NoKeepAwake(),
    });
    const step = async () => { await c.tickIntake(); while (await worker.tick()) await c.tickRuns(); await c.tickRuns(); };
    const src = issueRef(1);
    source.queue.push({ kind: "item_requested", source: src, requester: alice, title: "t", body: "b" });
    await step();
    source.queue.push({ kind: "spec_approved", source: src, comment_id: "9001", approver: alice });
    await c.tickIntake();
    await step();
    const it = (await store.getWorkItemBySource("github_issue", src.id))!;
    const asked = (await store.listRuns(it.id)).find((r) => r.kind === "implement")!;
    const rows = await store.listActivity({ kind: "auto_grant" });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ actor_id: actorOf("auto_grant"), subject: it.id, outcome: "granted", ref: `/api/v1/items/${it.id}/runs/${asked.id}/transcript` });
    expect(rows[0]!.reason).toContain("granted automatically");
  });
});

describe("a cleanup pass", () => {
  const ctx = (clock: FakeClock) => ({ k: { nowMs: () => clock.now().getTime(), d: { replica_id: null }, cfg: { lease_ms: LEASE } } }) as unknown as Ctx;

  it("writes one cleanup row with what it removed and why; a pass that removed nothing writes none", async () => {
    const { store, clock } = await newStore(new FakeClock("2026-11-20T10:00:00.000Z"));
    const pass = { removed: [{ resource: { label: "worktree sbx_1" } }], failed: [] };
    const port: CleanupPort = { host: "h1", enabled: () => true, closeStep: async () => pass, sweep: async () => ({ removed: [], failed: [] }) } as unknown as CleanupPort;
    await new CleanupUnit(ctx(clock)).cleanupStep(store as CleanupLeaseStore, port);
    const rows = await store.listActivity({ kind: "cleanup" });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ actor_id: actorOf("cleanup"), subject: "cleanup:h1", outcome: "removed" });
    expect(rows[0]!.reason).toContain("worktree sbx_1");
    expect(rows[0]!.reason).toContain("cleanup.keep_hours");
  });
});

describe("a supervised restart", () => {
  it("writes one restart row with its reason, once per stored restart", async () => {
    const { store } = await newStore();
    const r = { at: "2026-11-26T09:00:00.000Z", reason: "exit code 1" };
    expect(await store.recordChildRestart(r as never)).toEqual({ created: true });
    expect(await store.recordChildRestart(r as never)).toEqual({ created: false });
    const rows = await store.listActivity({ kind: "restart" });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ actor_id: actorOf("restart"), outcome: "restarted", at: r.at });
    expect(rows[0]!.reason).toContain("exit code 1");
  });
});

describe("a migration", () => {
  it("applied on an open writes one migration row with its reason", async () => {
    const { store } = await newStore();
    const id = "20261126T1201-state-controller-activity";
    await store.db.run(`DELETE FROM ${MIGRATIONS_TABLE} WHERE id = ?`, [id]); // pending again; the migration is safe to rerun
    await store.migrate();
    const rows = await store.listActivity({ kind: "migration" });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ actor_id: actorOf("migration"), subject: id, outcome: "applied" });
    expect(rows[0]!.reason).toContain("additive");
    await store.migrate();
    expect(await store.listActivity({ kind: "migration" })).toHaveLength(1);
  });

  it("applied by npm run migrate writes one migration row with its reason", async () => {
    const file = join(mkdtempSync(join(tmpdir(), "sf-activity-migrate-")), "factory.db");
    const id = "20261126T1201-state-controller-activity";
    const setup = new SqliteDriver(file);
    await setup.migrate();
    await setup.run(`DELETE FROM ${MIGRATIONS_TABLE} WHERE id = ?`, [id]); // pending again; the migration is safe to rerun
    await setup.close();
    const noSteps = { topicTables: async () => undefined, projectKeys: async () => 0 };
    expect(await migrateSqlite(file, "apply", noSteps, () => undefined)).toBe(0);
    const read = new SqliteDriver(file);
    try {
      const rows = await read.all("SELECT * FROM controller_activity WHERE kind = 'migration'");
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ actor_id: actorOf("migration"), subject: id, outcome: "applied" });
      expect(String(rows[0]!.reason)).toContain("npm run migrate");
      expect(String(rows[0]!.at)).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    } finally {
      await read.close();
    }
  });
});
