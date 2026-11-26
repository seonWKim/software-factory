import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { ImproveReportId, RunId, Timestamp, UserId, WorkItemId } from "../src/core/types.js";
import { FakeClock } from "../src/impl/clock/fake-clock.js";
import { SqlFactoryStore } from "../src/impl/store/sql/sql-factory-store.js";
import { SqliteDriver } from "../src/impl/store/sqlite/sqlite-driver.js";
import type { FactoryStore } from "../src/interfaces/factory-store.js";
import { SKILL_DRAFT_STATES, type SkillDraftState } from "../src/interfaces/skill-draft-store.js";
import { newStore, human, issue, system, w1, w2, PROJECT_KEY, OTHER_PROJECT_KEY } from "./helpers/store.js";

const LEASE = 60_000;

describe.each([{ name: "sqlite", make: newStore }])("FactoryStore contract: $name", ({ name, make: makeBackend }) => {
  const make = makeBackend;
  describe("skill drafts: states and the daily count (design 07-self-improvement, skill improvement)", () => {
    const draft = (id: string, state: SkillDraftState = "tried") => ({ id, project_key: PROJECT_KEY, skill_ref: "skills/a", state, tokens: 120, detail: { score: 0.8 } });

    it("holds a draft row in each of tried, proposed, promoted, rejected and held, read back as written", async () => {
      const { store } = await make();
      expect([...SKILL_DRAFT_STATES]).toEqual(["tried", "proposed", "promoted", "rejected", "held"]);
      for (const state of SKILL_DRAFT_STATES) {
        const added = await store.addSkillDraft(draft(`d-${state}`, state));
        expect(added).toMatchObject({ ...draft(`d-${state}`, state), created_at: "2026-01-01T00:00:00.000Z", updated_at: "2026-01-01T00:00:00.000Z" });
        expect(await store.getSkillDraft(`d-${state}`)).toEqual(added);
      }
      expect((await store.listSkillDrafts(PROJECT_KEY)).map((d) => d.state).sort()).toEqual([...SKILL_DRAFT_STATES].sort());
      expect(await store.listSkillDrafts(OTHER_PROJECT_KEY)).toEqual([]);
      expect(await store.getSkillDraft("missing")).toBeNull();
    });

    it("is idempotent on the id: a second add returns the stored row", async () => {
      const { store } = await make();
      const first = await store.addSkillDraft(draft("d1"));
      expect(await store.addSkillDraft({ ...draft("d1"), tokens: 9 })).toEqual(first);
    });

    it("refuses any other state, on add and on a state change, and stores nothing", async () => {
      const { store } = await make();
      await expect(store.addSkillDraft({ ...draft("d1"), state: "merged" as SkillDraftState })).rejects.toThrow(/state/);
      expect(await store.getSkillDraft("d1")).toBeNull();
      await store.addSkillDraft(draft("d2"));
      await expect(store.setSkillDraftState("d2", "tried", "done" as SkillDraftState)).rejects.toThrow(/state/);
      expect((await store.getSkillDraft("d2"))!.state).toBe("tried");
    });

    it("the table itself refuses another state, past the store's check", async () => {
      const { store } = await make();
      await expect(store.db.run("INSERT INTO controller_skill_drafts (id, project_key, skill_ref, state, tokens, detail, created_at, updated_at) VALUES ('x', 'p', 's', 'merged', 0, '{}', 't', 't')")).rejects.toThrow();
    });

    it("changes state only from the state expected, stamped with the store clock", async () => {
      const { store, clock } = await make();
      await store.addSkillDraft(draft("d1"));
      clock.advance(60_000);
      expect(await store.setSkillDraftState("d1", "proposed", "promoted")).toBe(false);
      expect(await store.setSkillDraftState("d1", "tried", "proposed", { note: "better" })).toBe(true);
      expect(await store.getSkillDraft("d1")).toMatchObject({ state: "proposed", detail: { note: "better" }, created_at: "2026-01-01T00:00:00.000Z", updated_at: "2026-01-01T00:01:00.000Z" });
      expect(await store.setSkillDraftState("d1", "proposed", "held")).toBe(true);
      expect((await store.getSkillDraft("d1"))!.detail).toEqual({ note: "better" });
      expect(await store.setSkillDraftState("missing", "tried", "proposed")).toBe(false);
    });

    it("the daily count is one row per project and UTC day, raised only while below the cap", async () => {
      const { store, clock } = await make(new FakeClock("2026-11-24T23:59:00.000Z"));
      expect(await store.takeSkillDraftSlot(PROJECT_KEY, 2)).toBe(true);
      expect(await store.takeSkillDraftSlot(PROJECT_KEY, 2)).toBe(true);
      expect(await store.takeSkillDraftSlot(PROJECT_KEY, 2)).toBe(false);
      expect(await store.skillDraftCount(PROJECT_KEY)).toBe(2);
      expect(await store.takeSkillDraftSlot(OTHER_PROJECT_KEY, 2)).toBe(true);
      clock.advance(60_000); // past midnight UTC: a new day starts at 0
      expect(await store.skillDraftCount(PROJECT_KEY)).toBe(0);
      expect(await store.takeSkillDraftSlot(PROJECT_KEY, 2)).toBe(true);
      const rows = await store.db.all("SELECT project_key, day, count FROM controller_skill_draft_days ORDER BY project_key, day");
      expect(rows).toEqual([
        { project_key: PROJECT_KEY, day: "2026-11-24", count: 2 },
        { project_key: PROJECT_KEY, day: "2026-11-25", count: 1 },
        { project_key: OTHER_PROJECT_KEY, day: "2026-11-24", count: 1 },
      ]);
    });

    it("a cap of 0 takes no slot and writes no row", async () => {
      const { store } = await make();
      expect(await store.takeSkillDraftSlot(PROJECT_KEY, 0)).toBe(false);
      expect(await store.skillDraftCount(PROJECT_KEY)).toBe(0);
      expect(await store.db.all("SELECT day FROM controller_skill_draft_days")).toEqual([]);
    });
  });

  describe("skill version gates: the owner's settle of a held version (design 07-self-improvement)", () => {
    const USER = "local:owner" as UserId;
    const heldVersion = async (store: Awaited<ReturnType<typeof make>>["store"], ref_id: string, hash: string) => {
      const v = (await store.recordSkillVersion({ ref_id, folder_hash: hash, text: hash, source: "claude" }))!;
      await store.db.run("UPDATE controller_skill_version_gates SET state = 'held' WHERE ref_id = ? AND version = ?", [ref_id, v.version]);
      return v.version;
    };

    it("lists held gates newest first and no gate in another state", async () => {
      const { store, clock } = await make();
      await heldVersion(store, "sr_a", "a1");
      clock.advance(1000);
      await store.recordSkillVersion({ ref_id: "sr_a", folder_hash: "a2", text: "a2", source: "claude" });
      clock.advance(1000);
      await heldVersion(store, "sr_b", "b1");
      const held = await store.listHeldSkillVersionGates(10);
      expect(held.map((g) => [g.ref_id, g.version, g.state])).toEqual([["sr_b", 1, "held"], ["sr_a", 1, "held"]]);
      expect((await store.listHeldSkillVersionGates(1)).map((g) => g.ref_id)).toEqual(["sr_b"]);
    });

    it("settles a held gate to passed or rejected by a conditional update: only while it is held, with who settled it", async () => {
      const { store } = await make();
      await heldVersion(store, "sr_a", "a1");
      await heldVersion(store, "sr_a", "a2");
      expect(await store.settleSkillVersionGate("sr_a", 2, "passed", USER)).toBe(true);
      expect(await store.getSkillVersionGate("sr_a", 2)).toMatchObject({ state: "passed", detail: expect.objectContaining({ settled_by: USER }) });
      // A second settle, of either kind, writes nothing: the gate is no longer held.
      expect(await store.settleSkillVersionGate("sr_a", 2, "rejected", USER)).toBe(false);
      expect(await store.getSkillVersionGate("sr_a", 2)).toMatchObject({ state: "passed" });
      expect(await store.settleSkillVersionGate("sr_a", 1, "rejected", USER)).toBe(true);
      expect(await store.getSkillVersionGate("sr_a", 1)).toMatchObject({ state: "rejected" });
      // A pending gate, and a version with no gate, are never settled.
      await store.recordSkillVersion({ ref_id: "sr_a", folder_hash: "a3", text: "a3", source: "claude" });
      expect(await store.settleSkillVersionGate("sr_a", 3, "passed", USER)).toBe(false);
      expect(await store.getSkillVersionGate("sr_a", 3)).toMatchObject({ state: "pending" });
      expect(await store.settleSkillVersionGate("sr_none", 1, "passed", USER)).toBe(false);
    });
  });

  describe("schedules: updateSchedule (design 08-schedules)", () => {
    const DAILY = { id: "sch_1", title: "Daily", cadence: { kind: "daily" as const, spec: "09:00" }, zone: "UTC", created_by: "local:owner" as UserId };
    const DUE = "2026-11-23T09:00:00.000Z" as Timestamp;
    const added = async () => {
      const { store, clock } = await make(new FakeClock("2026-11-22T12:00:00.000Z"));
      await store.addSchedule({ ...DAILY, created_at: "2026-11-22T12:00:00.000Z" as Timestamp, next_due_at: DUE });
      return { store, clock };
    };
    const one = async (store: FactoryStore) => (await store.listSchedules())[0]!;

    it("sets only the patch's fields, only while next_due_at is still the value read (IS NULL when null)", async () => {
      const { store } = await added();
      const before = await one(store);
      expect(await store.updateSchedule("sch_1", "2026-11-24T09:00:00.000Z" as Timestamp, { title: "Lost" })).toBe(false);
      expect(await store.updateSchedule("sch_1", null, { title: "Lost" })).toBe(false);
      expect(await store.updateSchedule("nope", DUE, { title: "Lost" })).toBe(false);
      expect(await one(store)).toEqual(before);
      // missed_rule is written only while next_due_at still holds the value read.
      expect(await store.updateSchedule("sch_1", "2026-11-24T09:00:00.000Z" as Timestamp, { missed_rule: "skip" })).toBe(false);
      expect(await one(store)).toEqual(before);
      expect(await store.updateSchedule("sch_1", DUE, { title: "Nightly", missed_rule: "skip", token_cap: 50, action: { kind: "agent", settings: { prompt: "p" } } })).toBe(true);
      expect(await one(store)).toEqual({ ...before, title: "Nightly", missed_rule: "skip", token_cap: 50, action: { kind: "agent", settings: { prompt: "p" } } });
      expect(await store.updateSchedule("sch_1", DUE, { next_due_at: null })).toBe(true);
      expect(await store.updateSchedule("sch_1", DUE, { next_due_at: null })).toBe(false);
      expect(await store.updateSchedule("sch_1", null, { cadence: { kind: "interval", spec: "60" }, zone: "Asia/Seoul", action: null })).toBe(true);
      expect(await one(store)).toMatchObject({ next_due_at: null, cadence: { kind: "interval", spec: "60" }, zone: "Asia/Seoul", action: null, title: "Nightly" });
    });

    it("a pause made between a claim's read and its write makes that claim fire nothing", async () => {
      const { store, clock } = await added();
      clock.set(new Date("2026-11-23T10:00:00.000Z"));
      const [due] = await store.listDueSchedules(clock.now().toISOString() as Timestamp);
      expect(due?.next_due_at).toBe(DUE);
      expect(await store.updateSchedule("sch_1", due!.next_due_at, { next_due_at: null })).toBe(true); // the pause
      expect(await store.claimScheduleOccurrence({ schedule_id: "sch_1", occurrence_at: DUE, next_due_at: "2026-11-24T09:00:00.000Z" as Timestamp, outcome: "fired" })).toBeNull();
      expect(await one(store)).toMatchObject({ next_due_at: null, running_since: null });
      expect(await store.listScheduleRuns("sch_1")).toEqual([]);
    });

    it("scheduleNow is the store's Clock's time", async () => {
      const { store, clock } = await added();
      expect(store.scheduleNow()).toBe(clock.now().toISOString());
    });

    it("a new schedule's trigger, USD caps, cap raise, paused and last run default to none, and the store writes and reads them back", async () => {
      const { store } = await added();
      expect(await one(store)).toMatchObject({ trigger: null, run_cap_usd: null, daily_cap_usd: null, cap_raise: null, paused: false, last_run_at: null });
      const extra = {
        trigger: "merge" as const, run_cap_usd: 0.5, daily_cap_usd: 2, cap_raise: { usd: 1, day: "2026-11-22", hold_key: "h1" }, paused: true,
        last_run_at: "2026-11-22T09:00:00.000Z" as Timestamp,
      };
      const s = await store.addSchedule({ ...DAILY, id: "sch_2", created_at: "2026-11-22T12:00:01.000Z" as Timestamp, next_due_at: null, ...extra });
      expect(s).toMatchObject({ id: "sch_2", cadence: { kind: "daily", spec: "09:00" }, ...extra });
      expect((await store.listSchedules()).find((x) => x.id === "sch_2")).toEqual(s);
    });
  });

  describe("routines: updateRoutine, raiseRoutineCap and suggestions (src/core/check-page.ts)", () => {
    const MADE = "2026-11-22T12:00:00.000Z" as Timestamp;
    const DUE = "2026-11-23T09:00:00.000Z" as Timestamp;
    const added = async () => {
      const { store, clock } = await make(new FakeClock(MADE));
      await store.addRoutine({
        id: "rt_1", name: "License", instruction: "Check the license.", url: null, schedule: { kind: "daily", spec: "09:00" }, zone: "UTC", trigger: null,
        run_cap_usd: null, daily_cap_usd: 1, created_by: "local:owner" as UserId, created_at: MADE, next_due_at: DUE,
      });
      return { store, clock };
    };

    it("adds once, and moves marks or pauses only while the marks are still the ones read (IS NULL when null)", async () => {
      const { store } = await added();
      const before = (await store.getRoutine("rt_1"))!;
      expect(before).toMatchObject({ paused: false, cap_raise: null, last_run_at: null, next_due_at: DUE });
      expect(await store.addRoutine({ ...before, name: "Other" })).toEqual(before);
      expect(await store.updateRoutine("rt_1", { next_due_at: DUE, last_run_at: MADE }, { paused: true })).toBe(false);
      expect(await store.updateRoutine("rt_1", { next_due_at: null, last_run_at: null }, { paused: true })).toBe(false);
      expect(await store.getRoutine("rt_1")).toEqual(before);
      const marks = { next_due_at: "2026-11-24T09:00:00.000Z" as Timestamp, last_run_at: DUE };
      expect(await store.updateRoutine("rt_1", { next_due_at: DUE, last_run_at: null }, marks)).toBe(true);
      expect(await store.updateRoutine("rt_1", { next_due_at: DUE, last_run_at: null }, marks)).toBe(false);
      expect(await store.updateRoutine("rt_1", marks, { paused: true })).toBe(true);
      expect(await store.listRoutines()).toEqual([{ ...before, ...marks, paused: true }]);
    });

    it("raises the cap once per hold, adds on the same day and starts again on a new one", async () => {
      const { store } = await added();
      expect(await store.raiseRoutineCap("rt_1", { hold_key: "h1", usd: 0.5, day: "2026-11-23" })).toBe(true);
      expect(await store.raiseRoutineCap("rt_1", { hold_key: "h1", usd: 0.5, day: "2026-11-23" })).toBe(false);
      expect(await store.raiseRoutineCap("rt_1", { hold_key: "h2", usd: 0.25, day: "2026-11-23" })).toBe(true);
      expect((await store.getRoutine("rt_1"))!.cap_raise).toEqual({ usd: 0.75, day: "2026-11-23", hold_key: "h2" });
      expect(await store.raiseRoutineCap("rt_1", { hold_key: "h3", usd: 0.4, day: "2026-11-24" })).toBe(true);
      expect((await store.getRoutine("rt_1"))!.cap_raise).toEqual({ usd: 0.4, day: "2026-11-24", hold_key: "h3" });
    });

    it("answers a suggestion only while it reads pending; a snooze reads as pending again once it runs out", async () => {
      const { store, clock } = await added();
      expect(await store.addRoutineSuggestions("rt_1", "run_1", [{ fingerprint: "f1", text: "one" }, { fingerprint: "f2", text: "two" }])).toEqual({ added: 2, duplicates: 0 });
      const [one, two] = await store.listRoutineSuggestions("rt_1");
      expect(await store.decideRoutineSuggestion(one!.id, { to: "accepted", by: "local:owner", filed_ref: "local-7" })).toBe(true);
      expect(await store.decideRoutineSuggestion(one!.id, { to: "dismissed", by: "local:owner" })).toBe(false);
      expect(await store.getRoutineSuggestion(one!.id)).toMatchObject({ state: "accepted", filed_ref: "local-7", decided_by: "local:owner", decided_at: MADE });
      expect(await store.decideRoutineSuggestion(two!.id, { to: "snoozed", by: "local:owner", snooze_ms: 1000 })).toBe(true);
      expect(await store.getRoutineSuggestion(two!.id)).toMatchObject({ state: "snoozed", snoozed_until: "2026-11-22T12:00:01.000Z" });
      expect(await store.decideRoutineSuggestion(two!.id, { to: "dismissed", by: "local:owner" })).toBe(false);
      clock.advance(1000);
      expect(await store.getRoutineSuggestion(two!.id)).toMatchObject({ state: "pending" });
      expect(await store.decideRoutineSuggestion(two!.id, { to: "dismissed", by: "local:owner" })).toBe(true);
      expect(await store.getRoutineSuggestion("nope")).toBeNull();
    });
  });

  describe("work items", () => {
    it("intake is idempotent on (source.type, source.id) and enqueues once", async () => {
      const { store } = await make();
      const enqueue = { kind: "triage" as const, idempotency_key: "o/r#1:triage" };
      const a = await store.createWorkItem(issue(1), system, { enqueue });
      const b = await store.createWorkItem(issue(1), system, { enqueue });
      expect(a.created).toBe(true);
      expect(b.created).toBe(false);
      expect(b.item.id).toBe(a.item.id);
      expect(await store.listRuns(a.item.id)).toHaveLength(1);
      expect(await store.listStateChanges(a.item.id)).toHaveLength(1);
    });

    it("intake can start held on upstream, with a detail on its intake row and no run", async () => {
      const { store } = await make();
      const detail = { parent_work_item_id: "wi_parent", phase: 2, phases: 3, depends_on: "o/r#10" };
      const a = await store.createWorkItem(
        { ...issue(11), hold: { blocked_on: "upstream", blocked_reason: "phase_hold" } },
        system,
        { detail },
      );
      expect(a.item).toMatchObject({ stage: "NEW", blocked_on: "upstream", blocked_reason: "phase_hold" });
      expect(await store.listRuns(a.item.id)).toHaveLength(0);
      const [row] = await store.listStateChanges(a.item.id);
      expect(row).toMatchObject({ reason: "intake", detail });
      expect(row!.changes).toMatchObject({ blocked_on: { from: "none", to: "upstream" }, blocked_reason: { from: null, to: "phase_hold" } });
      // A repeat is the same item, still held.
      const b = await store.createWorkItem({ ...issue(11), hold: { blocked_on: "upstream", blocked_reason: "phase_hold" } }, system, { detail });
      expect(b).toMatchObject({ created: false, item: { id: a.item.id, blocked_reason: "phase_hold" } });
      // Without hold or detail, intake is as before.
      const c = await store.createWorkItem(issue(12), system);
      expect(c.item).toMatchObject({ blocked_on: "none", blocked_reason: null });
      expect((await store.listStateChanges(c.item.id))[0]!.detail).toBeNull();
    });

    it("a phase stores its parent link and phase number; listPhases returns a parent's phases in phase order", async () => {
      const { store } = await make();
      const parent = (await store.createWorkItem(issue(20), system)).item;
      expect(parent).toMatchObject({ parent_id: null, phase: null });
      // Filed out of order on purpose: listPhases sorts by phase, not by intake.
      const p2 = (await store.createWorkItem({ ...issue(22), parent: { id: parent.id, phase: 2 } }, system)).item;
      const p1 = (await store.createWorkItem({ ...issue(21), parent: { id: parent.id, phase: 1 } }, system)).item;
      const other = (await store.createWorkItem(issue(30), system)).item;
      await store.createWorkItem({ ...issue(31), parent: { id: other.id, phase: 1 } }, system);
      expect(p1).toMatchObject({ parent_id: parent.id, phase: 1 });
      expect((await store.getWorkItem(p2.id))!).toMatchObject({ parent_id: parent.id, phase: 2 });
      expect((await store.listPhases(parent.id)).map((p) => [p.id, p.phase])).toEqual([[p1.id, 1], [p2.id, 2]]);
      expect(await store.listPhases(p1.id)).toEqual([]);
      // The link is store-owned: a transition keeps it.
      const r = await store.transition({ id: p2.id, expected_version: p2.version, patch: { blocked_on: "human" }, actor: system, reason: "t" });
      expect(r.ok && r.item).toMatchObject({ parent_id: parent.id, phase: 2 });
    });

    it("transition applies only on the expected version; the loser gets version_conflict", async () => {
      const { store } = await make();
      const { item } = await store.createWorkItem(issue(1), system);
      const base = { id: item.id, expected_version: 1, actor: system, reason: "test" };
      const [first, second] = await Promise.all([
        store.transition({ ...base, patch: { stage: "READY" } }),
        store.transition({ ...base, patch: { stage: "CLOSED", close_reason: "wont_do" } }),
      ]);
      // Either may win; exactly one applies.
      const winner = first.ok ? first : second;
      const loser = first.ok ? second : first;
      if (!winner.ok) throw new Error("neither transition applied");
      expect(loser).toMatchObject({ ok: false, reason: "version_conflict", current: { version: 2, stage: winner.item.stage } });
    });

    it("records only changed fields, with from/to, in state_changes", async () => {
      const { store } = await make();
      const { item } = await store.createWorkItem(issue(1), system);
      const r = await store.transition({
        id: item.id,
        expected_version: 1,
        patch: { stage: "READY", blocked_on: "human", loop_count: 0 },
        actor: human,
        reason: "spec_posted",
      });
      if (!r.ok) throw new Error(r.reason);
      expect(r.state_change.changes).toEqual({
        stage: { from: "NEW", to: "READY" },
        blocked_on: { from: "none", to: "human" },
      });
      expect(r.state_change.actor).toEqual(human);
      expect(r.item.version).toBe(2);
    });

    it("acks a finished run and enqueues the next run atomically", async () => {
      const { store } = await make();
      const { item } = await store.createWorkItem(issue(1), system, { enqueue: { kind: "triage", idempotency_key: "t" } });
      const run = (await store.claimRun({ worker_id: w1, kinds: ["triage"], lease_ms: LEASE }))!;
      await store.completeRun(run.id, run.lease!.token, { status: "succeeded", summary: "", data: {} });

      const r = await store.transition({
        id: item.id,
        expected_version: 1,
        patch: { stage: "READY" },
        actor: system,
        reason: "triaged",
        ack_run: run.id,
        enqueue: { kind: "implement", idempotency_key: "i" },
      });
      expect(r.ok && r.enqueued?.kind).toBe("implement");
      expect(await store.listUnacknowledgedRuns(10)).toHaveLength(0);

      // Acking twice is refused and changes nothing.
      const again = await store.transition({
        id: item.id, expected_version: 2, patch: { stage: "RUNNING" }, actor: system, reason: "x", ack_run: run.id,
      });
      expect(again).toEqual({ ok: false, reason: "run_not_ackable" });
      expect((await store.getWorkItem(item.id))!.version).toBe(2);
    });

    it("re-enqueueing an existing idempotency key is a no-op", async () => {
      const { store } = await make();
      const { item } = await store.createWorkItem(issue(1), system, { enqueue: { kind: "triage", idempotency_key: "k" } });
      const r = await store.transition({
        id: item.id, expected_version: 1, patch: {}, actor: system, reason: "x", enqueue: { kind: "triage", idempotency_key: "k" },
      });
      expect(r.ok && r.enqueued).toBeNull();
      expect(await store.listRuns(item.id)).toHaveLength(1);
    });
  });

  describe("state change detail and PR lookups", () => {
    it("round-trips detail through transition and listStateChanges; it is null when not given", async () => {
      const { store } = await make();
      const { item } = await store.createWorkItem(issue(1), system);
      const detail = { reverting_commit: "abc123", reverting_pr: 50 };
      const r = await store.transition({ id: item.id, expected_version: 1, patch: {}, actor: system, reason: "reverted", detail });
      if (!r.ok) throw new Error(r.reason);
      expect(r.state_change.detail).toEqual(detail);
      const [intake, reverted] = await store.listStateChanges(item.id);
      expect(intake!.detail).toBeNull();
      expect(reverted).toMatchObject({ reason: "reverted", detail, changes: {} });
    });

    it("finds a work item by (project, change_ref) and by merge_sha", async () => {
      const { store } = await make();
      const { item } = await store.createWorkItem(issue(1), system);
      await store.createWorkItem(issue(2), system);
      expect(await store.getWorkItemByPr(PROJECT_KEY, "34")).toBeNull();
      expect(await store.getWorkItemByMergeSha(PROJECT_KEY, "m1")).toBeNull();
      await store.transition({ id: item.id, expected_version: 1, patch: { change_ref: "34", merge_sha: "m1" }, actor: system, reason: "x" });
      expect((await store.getWorkItemByPr(PROJECT_KEY, "34"))!.id).toBe(item.id);
      expect((await store.getWorkItemByMergeSha(PROJECT_KEY, "m1"))!.id).toBe(item.id);
      expect(await store.getWorkItemByPr(OTHER_PROJECT_KEY, "34")).toBeNull();
      expect(await store.getWorkItemByMergeSha(OTHER_PROJECT_KEY, "m1")).toBeNull();
      expect(await store.getWorkItemByPr(PROJECT_KEY, "35")).toBeNull();
    });
  });

  describe("merge checks (design 05-merge-conflict, Re-check)", () => {
    it("clearMergeCheck removes only that item's stored check, leaves the item as it was, and is safe to run twice", async () => {
      const { store } = await make();
      const { item: a } = await store.createWorkItem(issue(1), system);
      const { item: b } = await store.createWorkItem(issue(2), system);
      const check = { mergeable: true, conflicts: [], head_sha: "a".repeat(40), base_sha: "b".repeat(40) };
      await store.recordMergeCheck({ work_item_id: a.id, ...check });
      await store.recordMergeCheck({ work_item_id: b.id, ...check });
      expect(await store.clearMergeCheck(a.id)).toBe(true);
      expect(await store.getMergeCheck(a.id)).toBeNull();
      expect(await store.getMergeCheck(b.id)).not.toBeNull();
      expect(await store.clearMergeCheck(a.id)).toBe(false);
      const after = (await store.getWorkItem(a.id))!;
      expect([after.stage, after.blocked_on, after.blocked_reason, after.version]).toEqual([a.stage, a.blocked_on, a.blocked_reason, a.version]);
      expect(await store.listStateChanges(a.id)).toHaveLength((await store.listStateChanges(b.id)).length);
    });
  });

  describe("runs and leases", () => {
    async function queued() {
      const ctx = await make();
      const { item } = await ctx.store.createWorkItem(issue(1), system, { enqueue: { kind: "triage", idempotency_key: "t" } });
      return { ...ctx, item };
    }

    it("only one worker claims a run", async () => {
      const { store } = await queued();
      const [a, b] = await Promise.all([
        store.claimRun({ worker_id: w1, kinds: ["triage"], lease_ms: LEASE }),
        store.claimRun({ worker_id: w2, kinds: ["triage"], lease_ms: LEASE }),
      ]);
      expect([a, b].filter(Boolean)).toHaveLength(1);
    });

    it("claims only the requested kinds", async () => {
      const { store } = await queued();
      expect(await store.claimRun({ worker_id: w1, kinds: ["review"], lease_ms: LEASE })).toBeNull();
    });

    const ok = { status: "succeeded" as const, summary: "", data: { kept: true } };

    /** heartbeat, completeRun and appendHandoff with `token` all return lease_lost. */
    async function expectAllLost(store: FactoryStore, runId: RunId, item: WorkItemId, token: number) {
      const lost = { ok: false, reason: "lease_lost" };
      expect(await store.heartbeat(runId, token, LEASE)).toEqual(lost);
      expect(await store.completeRun(runId, token, ok)).toEqual(lost);
      expect(
        await store.appendHandoff({ run_id: runId, work_item_id: item, commit_sha: "abc", worked_on: "", next_steps: "" }, token),
      ).toEqual(lost);
    }

    it("heartbeat extends the lease", async () => {
      const { store, clock } = await queued();
      const run = (await store.claimRun({ worker_id: w1, kinds: ["triage"], lease_ms: LEASE }))!;
      clock.advance(LEASE - 1);
      expect((await store.heartbeat(run.id, run.lease!.token, LEASE)).ok).toBe(true);
      const after = (await store.getRun(run.id))!;
      expect(new Date(after.lease!.expires_at).getTime()).toBe(clock.now().getTime() + LEASE);
    });

    it("last model output (design 05-restarts): stored by its lease holder, read across running runs, never by the heartbeat", async () => {
      const { store, clock } = await queued();
      await store.createWorkItem(issue(2), system, { enqueue: { kind: "triage", idempotency_key: "o/r#2:triage" } });
      const a = (await store.claimRun({ worker_id: w1, kinds: ["triage"], lease_ms: LEASE }))!;
      const b = (await store.claimRun({ worker_id: w2, kinds: ["triage"], lease_ms: LEASE }))!;
      // A running run with no output yet (and the heartbeat) leaves it null.
      expect(await store.heartbeat(a.id, a.lease!.token, LEASE)).toMatchObject({ ok: true });
      expect(await store.latestRunningOutput()).toBeNull();
      expect(await store.recordRunOutput(a.id, a.lease!.token)).toBe(true);
      const first = clock.now().toISOString();
      clock.advance(1_000);
      expect(await store.recordRunOutput(b.id, b.lease!.token)).toBe(true);
      expect(await store.latestRunningOutput()).toBe(clock.now().toISOString());
      // A stale token writes nothing; a finished run is no longer read.
      expect(await store.recordRunOutput(a.id, a.lease!.token + 1)).toBe(false);
      await store.completeRun(b.id, b.lease!.token, ok);
      expect(await store.recordRunOutput(b.id, b.lease!.token)).toBe(false);
      expect(await store.latestRunningOutput()).toBe(first);
    });

    it("host sleep: an expired lease nobody reclaimed is renewed by its holder (status and token decide, not the clock)", async () => {
      const { store, clock, item } = await queued();
      const run = (await store.claimRun({ worker_id: w1, kinds: ["triage"], lease_ms: LEASE }))!;
      clock.advance(LEASE * 5);
      const hb = await store.heartbeat(run.id, run.lease!.token, LEASE);
      expect(hb.ok).toBe(true);
      const renewed = (await store.getRun(run.id))!;
      expect(renewed.status).toBe("running");
      expect(new Date(renewed.lease!.expires_at).getTime()).toBeGreaterThan(clock.now().getTime());

      // Handoffs and completion after expiry are accepted too, and the outcome is kept.
      clock.advance(LEASE * 5);
      const h = await store.appendHandoff(
        { run_id: run.id, work_item_id: item.id, commit_sha: "abc", worked_on: "x", next_steps: "y" },
        run.lease!.token,
      );
      expect(h.ok).toBe(true);
      const done = await store.completeRun(run.id, run.lease!.token, ok);
      expect(done.ok).toBe(true);
      expect((await store.getRun(run.id))!).toMatchObject({ status: "succeeded", outcome: ok, attempt: 1 });
    });

    it("fencing: after the reaper requeued the run, the old token is rejected everywhere", async () => {
      const { store, clock, item } = await queued();
      const first = (await store.claimRun({ worker_id: w1, kinds: ["triage"], lease_ms: LEASE }))!;
      clock.advance(LEASE + 1);
      expect(await store.expireLeases(3)).toEqual([first.id]);
      expect((await store.getRun(first.id))!.status).toBe("queued");
      await expectAllLost(store, first.id, item.id, first.lease!.token);
      expect((await store.getRun(first.id))!.status).toBe("queued");
    });

    it("fencing: after the reaper failed the run (attempts used up), the old token is rejected everywhere", async () => {
      const { store, clock, item } = await queued();
      const first = (await store.claimRun({ worker_id: w1, kinds: ["triage"], lease_ms: LEASE }))!;
      clock.advance(LEASE + 1);
      expect(await store.expireLeases(1)).toEqual([first.id]);
      expect((await store.getRun(first.id))!.status).toBe("failed");
      await expectAllLost(store, first.id, item.id, first.lease!.token);
      expect((await store.getRun(first.id))!.outcome).toMatchObject({ error_code: "lease_expired" });
    });

    it("fencing: after expiry and reclaim, the old holder's token is rejected; the new holder completes after expiry", async () => {
      const { store, clock, item } = await queued();
      const first = (await store.claimRun({ worker_id: w1, kinds: ["triage"], lease_ms: LEASE }))!;
      clock.advance(LEASE + 1);
      expect(await store.expireLeases(3)).toEqual([first.id]);
      const second = (await store.claimRun({ worker_id: w2, kinds: ["triage"], lease_ms: LEASE }))!;
      expect(second.lease!.token).toBe(first.lease!.token + 1);
      expect(second.attempt).toBe(2);

      await expectAllLost(store, first.id, item.id, first.lease!.token);
      expect((await store.getRun(second.id))!.status).toBe("running");

      clock.advance(LEASE + 1);
      const fresh = await store.completeRun(second.id, second.lease!.token, ok);
      expect(fresh.ok).toBe(true);
      expect((await store.getRun(second.id))!).toMatchObject({ status: "succeeded", outcome: ok });
    });

    it("the reaper fails a run once attempts are used up", async () => {
      const { store, clock } = await queued();
      let id: RunId | undefined;
      for (let i = 0; i < 2; i++) {
        id = (await store.claimRun({ worker_id: w1, kinds: ["triage"], lease_ms: LEASE }))!.id;
        clock.advance(LEASE + 1);
        await store.expireLeases(2);
      }
      const run = (await store.getRun(id!))!;
      expect(run.status).toBe("failed");
      expect(run.outcome).toMatchObject({ error_code: "lease_expired", infra: true });
      expect(await store.listUnacknowledgedRuns(10)).toHaveLength(1);
    });

    it("handoffs are idempotent per (run, commit)", async () => {
      const { store, item } = await queued();
      const run = (await store.claimRun({ worker_id: w1, kinds: ["triage"], lease_ms: LEASE }))!;
      const h = { run_id: run.id, work_item_id: item.id, commit_sha: "abc", worked_on: "x", next_steps: "y" };
      await store.appendHandoff(h, run.lease!.token);
      await store.appendHandoff(h, run.lease!.token);
      expect(await store.listHandoffs(item.id)).toHaveLength(1);
    });
  });

  describe("run attempts (design §6): one record per claim", () => {
    const usage = { input_tokens: 10, output_tokens: 5, cache_read_tokens: 3, cache_write_tokens: 2, cost_usd: null, model: null };
    const close = { stage: "CLOSED" as const, close_reason: "wont_do" as const, blocked_on: "none" as const, blocked_reason: null };

    async function queued(key = "t") {
      const ctx = await make();
      const { item } = await ctx.store.createWorkItem(issue(1), system, { enqueue: { kind: "triage", idempotency_key: key } });
      return { ...ctx, item };
    }
    const claim = (store: FactoryStore, worker = w1) => store.claimRun({ worker_id: worker, kinds: ["triage"], lease_ms: LEASE });

    it("a claim writes one running record with the run, attempt 1, worker and start; queued runs have none", async () => {
      const { store, clock, item } = await queued();
      expect(await store.listRunAttempts(item.id)).toEqual([]);
      clock.advance(1_000);
      const run = (await claim(store))!;
      expect(await store.listRunAttempts(item.id)).toEqual([
        {
          run_id: run.id, attempt: 1, worker_id: w1, status: "running", started_at: clock.now().toISOString(),
          finished_at: null, error_code: null, failure_class: null, tokens: 0,
        },
      ]);
      // The fencing token is never part of the record.
      expect(Object.keys((await store.listRunAttempts(item.id))[0]!)).not.toContain("lease_token");
    });

    it("completeRun closes the claim's record: succeeded with tokens, no error code and no failure class", async () => {
      const { store, clock, item } = await queued();
      const run = (await claim(store))!;
      clock.advance(5_000);
      await store.completeRun(run.id, run.lease!.token, { status: "succeeded", summary: "", data: { tokens: 1234 } });
      expect(await store.listRunAttempts(item.id)).toEqual([
        {
          run_id: run.id, attempt: 1, worker_id: w1, status: "succeeded", started_at: run.started_at,
          finished_at: clock.now().toISOString(), error_code: null, failure_class: null, tokens: 1234,
        },
      ]);
    });

    it("a failed outcome stores its error code, failureClass() and outcomeTokens()", async () => {
      const cases = [
        [{ status: "failed" as const, error_code: "agent_error", detail: "", infra: false, usage }, "task", 20],
        [{ status: "failed" as const, error_code: "push_failed", detail: "", infra: true }, "infra", 0],
        [{ status: "failed" as const, error_code: "rate_limited", detail: "", infra: true, usage }, "rate_limited", 20],
        [{ status: "failed" as const, error_code: "agent_stalled", detail: "", infra: false }, "infra", 0],
      ] as const;
      // One store for every case (a fresh database per case is slow): one item each, claimed in turn.
      const { store } = await make();
      for (const [i, [outcome, cls, tokens]] of cases.entries()) {
        const { item } = await store.createWorkItem(issue(i + 1), system, { enqueue: { kind: "triage", idempotency_key: `t${i}` } });
        const run = (await claim(store))!;
        expect(run.work_item_id).toBe(item.id);
        await store.completeRun(run.id, run.lease!.token, outcome);
        expect(await store.listRunAttempts(item.id)).toMatchObject([
          { status: "failed", error_code: outcome.error_code, failure_class: cls, tokens },
        ]);
      }
    });

    it("a stale token closes nothing: the close is conditional on the token that opened the record", async () => {
      const { store, clock, item } = await queued();
      const first = (await claim(store))!;
      clock.advance(LEASE + 1);
      await store.expireLeases(3);
      const second = (await claim(store, w2))!;
      expect(await store.completeRun(first.id, first.lease!.token, { status: "succeeded", summary: "", data: { tokens: 9 } }))
        .toEqual({ ok: false, reason: "lease_lost" });
      expect((await store.listRunAttempts(item.id)).map((a) => [a.attempt, a.worker_id, a.status, a.tokens])).toEqual([
        [1, w1, "lease_expired", 0],
        [2, w2, "running", 0],
      ]);
      await store.completeRun(second.id, second.lease!.token, { status: "succeeded", summary: "", data: { tokens: 9 } });
      expect((await store.listRunAttempts(item.id)).map((a) => a.status)).toEqual(["lease_expired", "succeeded"]);
    });

    it("the reaper closes a record as lease_expired, infra, tokens 0, whether it requeues, fails or cancels the run", async () => {
      const { store, clock, item } = await queued();
      for (let i = 0; i < 2; i++) {
        await claim(store);
        clock.advance(LEASE + 1);
        await store.expireLeases(2);
      }
      const at = clock.now().toISOString();
      expect((await store.listRuns(item.id))[0]!.status).toBe("failed");
      const attempts = await store.listRunAttempts(item.id);
      expect(attempts.map((a) => a.attempt)).toEqual([1, 2]);
      for (const a of attempts) {
        expect(a).toMatchObject({ status: "lease_expired", error_code: "lease_expired", failure_class: "infra", tokens: 0 });
      }
      expect(attempts[1]!.finished_at).toBe(at);

      // An expired run of a CLOSED item is cancelled, and its record still closes as lease_expired.
      const other = await queued("t2");
      await claim(other.store);
      await other.store.transition({ id: other.item.id, expected_version: 1, patch: close, actor: human, reason: "source_closed" });
      other.clock.advance(LEASE + 1);
      await other.store.expireLeases(3);
      expect((await other.store.listRuns(other.item.id))[0]!.status).toBe("cancelled");
      expect(await other.store.listRunAttempts(other.item.id)).toMatchObject([{ status: "lease_expired", failure_class: "infra" }]);
    });

    it("a close that stops running runs closes their records as cancelled", async () => {
      const { store, clock, item } = await queued();
      await claim(store);
      clock.advance(1_000);
      await store.transition({
        id: item.id, expected_version: 1, patch: close, actor: human, reason: "source_closed", cancel_running_runs: true,
      });
      expect(await store.listRunAttempts(item.id)).toMatchObject([
        { status: "cancelled", finished_at: clock.now().toISOString(), error_code: null, failure_class: null, tokens: 0 },
      ]);
    });

    it("pause and resume: the pause closes the record as paused, the resume opens attempt 2; run.attempt stays 1", async () => {
      const { store, clock, item } = await queued();
      const run = (await claim(store))!;
      clock.advance(1_000);
      const resume = { host: "h", folder: "sbx_1", base_sha: null, start_sha: null, head: null, bundle: null };
      expect((await store.pauseRun(run.id, run.lease!.token, { paused_by: "github:1", session_id: null, resume })).ok).toBe(true);
      const pausedAt = clock.now().toISOString();
      clock.advance(1_000);
      const resumed = (await claim(store, w2))!;
      expect(resumed.attempt).toBe(1);
      clock.advance(1_000);
      await store.completeRun(resumed.id, resumed.lease!.token, { status: "succeeded", summary: "", data: { tokens: 7 } });
      expect(await store.listRunAttempts(item.id)).toEqual([
        {
          run_id: run.id, attempt: 1, worker_id: w1, status: "paused", started_at: run.started_at, finished_at: pausedAt,
          error_code: null, failure_class: null, tokens: 0,
        },
        {
          run_id: run.id, attempt: 2, worker_id: w2, status: "succeeded", started_at: resumed.started_at,
          finished_at: clock.now().toISOString(), error_code: null, failure_class: null, tokens: 7,
        },
      ]);
      expect((await store.getRun(run.id))!.attempt).toBe(1);
    });

    it("lists the item's attempts by run, then attempt; other items' attempts are not included", async () => {
      const { store, item } = await queued();
      const a = (await claim(store))!;
      await store.completeRun(a.id, a.lease!.token, { status: "failed", error_code: "agent_error", detail: "", infra: false, usage });
      await store.transition({ id: item.id, expected_version: 1, patch: {}, actor: system, reason: "x", enqueue: { kind: "triage", idempotency_key: "t:2" } });
      const b = (await claim(store))!;
      await store.completeRun(b.id, b.lease!.token, { status: "succeeded", summary: "", data: { tokens: 50 } });
      const other = (await store.createWorkItem(issue(2), system, { enqueue: { kind: "triage", idempotency_key: "o" } })).item;
      await claim(store);
      expect((await store.listRunAttempts(item.id)).map((x) => [x.run_id, x.attempt, x.status, x.tokens])).toEqual([
        [a.id, 1, "failed", 20],
        [b.id, 1, "succeeded", 50],
      ]);
      expect(await store.listRunAttempts(other.id)).toHaveLength(1);
    });
  });

  describe("title and run timing columns", () => {
    it("records the title at intake, null when not given; transitions leave it alone", async () => {
      const { store } = await make();
      const { item } = await store.createWorkItem({ ...issue(1), title: "Add a status page" }, system);
      expect(item.title).toBe("Add a status page");
      const { item: untitled } = await store.createWorkItem(issue(2), system);
      expect(untitled.title).toBeNull();
      await store.transition({ id: item.id, expected_version: 1, patch: { problem: "the spec" }, actor: system, reason: "x" });
      expect(await store.getWorkItem(item.id)).toMatchObject({ title: "Add a status page", problem: "the spec" });
      expect((await store.getWorkItem(untitled.id))!.title).toBeNull();
    });

    it("sets started_at on each claim and finished_at on completion; queued runs have neither", async () => {
      const { store, clock } = await make();
      await store.createWorkItem(issue(1), system, { enqueue: { kind: "triage", idempotency_key: "t" } });
      const [queued] = await store.listRunsByStatus(["queued"], 10);
      expect(queued).toMatchObject({ started_at: null, finished_at: null });

      clock.advance(1_000);
      const run = (await store.claimRun({ worker_id: w1, kinds: ["triage"], lease_ms: LEASE }))!;
      expect(run.started_at).toBe(clock.now().toISOString());
      expect(run.finished_at).toBeNull();

      clock.advance(5_000);
      await store.heartbeat(run.id, run.lease!.token, LEASE);
      expect((await store.getRun(run.id))!.started_at).toBe(run.started_at);

      clock.advance(5_000);
      await store.completeRun(run.id, run.lease!.token, { status: "succeeded", summary: "", data: {} });
      const done = (await store.getRun(run.id))!;
      expect(done.started_at).toBe(run.started_at);
      expect(done.finished_at).toBe(clock.now().toISOString());
    });

    it("the reaper sets finished_at only when it fails the run; a requeue clears nothing and a reclaim restarts", async () => {
      const { store, clock } = await make();
      await store.createWorkItem(issue(1), system, { enqueue: { kind: "triage", idempotency_key: "t" } });
      const first = (await store.claimRun({ worker_id: w1, kinds: ["triage"], lease_ms: LEASE }))!;
      clock.advance(LEASE + 1);
      await store.expireLeases(2);
      expect((await store.getRun(first.id))!.finished_at).toBeNull();

      const second = (await store.claimRun({ worker_id: w2, kinds: ["triage"], lease_ms: LEASE }))!;
      expect(second.started_at).toBe(clock.now().toISOString());
      expect(second.started_at).not.toBe(first.started_at);
      clock.advance(LEASE + 1);
      await store.expireLeases(2);
      const failed = (await store.getRun(first.id))!;
      expect(failed.status).toBe("failed");
      expect(failed.finished_at).toBe(clock.now().toISOString());
    });
  });

  describe("filed pattern takes and open items by title (design 07-self-improvement)", () => {
    /** `n` improve reports on one item's runs, a second apart. */
    async function reports(n: number) {
      const { store, clock } = await make();
      const { item } = await store.createWorkItem(issue(1), system);
      const out = [];
      for (let i = 0; i < n; i++) {
        const { run } = await store.enqueueRun({ work_item_id: item.id, kind: "improve", idempotency_key: `improve-${i}` });
        out.push((await store.recordImproveReport({ run_id: run.id, project: PROJECT_KEY, window_start: "2026-03-04T00:00:00.000Z" as Timestamp, window_end: "2026-03-05T00:00:00.000Z" as Timestamp, groups: [], patterns: [] })).report);
        clock.advance(1_000);
      }
      return { store, clock, reports: out };
    }
    const input = (report_id: ImproveReportId) => ({ project: PROJECT_KEY, pattern_key: "k", error_code: "hotspot", detail: "web/src/pages.ts", report_id });

    it("of two takes of a new pattern only the one that inserted it is taken; both get the stored row", async () => {
      const { store, reports: [a, b] } = await reports(2);
      const [x, y] = await Promise.all([store.takeFiledPattern(input(a!.id)), store.takeFiledPattern(input(b!.id))]);
      expect([x.taken, y.taken].sort()).toEqual([false, true]);
      expect(x.row).toEqual(y.row);
      expect(x.row).toMatchObject({ filed_ref: null, report_id: (x.taken ? a : b)!.id });
    });

    it("a restart of a half-done claim, as read, is taken once, keeps its report and starts its claim time again", async () => {
      const { store, clock, reports: [a, b, c] } = await reports(3);
      const { row } = await store.takeFiledPattern(input(a!.id));
      clock.advance(60_000);
      const first = await store.takeFiledPattern(input(b!.id), { restart: row });
      expect(first).toMatchObject({ taken: true, row: { id: row.id, report_id: a!.id, filed_ref: null, created_at: clock.now().toISOString() } });
      // A second caller that read the same claim lost the race: its claim time has moved on.
      expect(await store.takeFiledPattern(input(c!.id), { restart: row })).toEqual({ taken: false, row: first.row });
    });

    it("a replace takes the row from the named report once, with no item", async () => {
      const { store, reports: [a, b, c] } = await reports(3);
      const { row } = await store.takeFiledPattern(input(a!.id));
      await store.setFiledPatternRef(row.id, a!.id, { type: "local", id: "old", link: "" });
      expect(await store.takeFiledPattern(input(b!.id), { replace: a!.id })).toMatchObject({ taken: true, row: { id: row.id, report_id: b!.id, filed_ref: null } });
      expect(await store.takeFiledPattern(input(c!.id), { replace: a!.id })).toMatchObject({ taken: false, row: { report_id: b!.id } });
    });

    it("getOpenWorkItemByTitle finds an item of the project with that exact title not CLOSED", async () => {
      const { store } = await make();
      const title = "Reduce conflicts on web/src/pages.ts";
      expect(await store.getOpenWorkItemByTitle(PROJECT_KEY, title)).toBeNull();
      const { item: closed } = await store.createWorkItem({ ...issue(1), title }, system);
      await store.transition({ id: closed.id, expected_version: 1, actor: system, reason: "x", patch: { stage: "CLOSED", close_reason: "completed" } });
      await store.createWorkItem({ ...issue(2), title, project: OTHER_PROJECT_KEY }, system);
      await store.createWorkItem({ ...issue(3), title: `${title}x` }, system);
      expect(await store.getOpenWorkItemByTitle(PROJECT_KEY, title)).toBeNull();
      const { item: open } = await store.createWorkItem({ ...issue(4), title }, system);
      expect((await store.getOpenWorkItemByTitle(PROJECT_KEY, title))!.id).toBe(open.id);
    });
  });

  describe("comment links", () => {
    it("spec_comment_url and failure_comment_url default to null and round-trip through transition()", async () => {
      const { store } = await make();
      const { item } = await store.createWorkItem(issue(1), system);
      expect(item.spec_comment_url).toBeNull();
      expect(item.failure_comment_url).toBeNull();
      expect((await store.getWorkItem(item.id))!).toMatchObject({ spec_comment_url: null, failure_comment_url: null });

      const spec = "https://github.com/o/r/issues/1#issuecomment-11";
      const r = await store.transition({
        id: item.id, expected_version: 1, actor: system, reason: "triaged",
        patch: { stage: "READY", blocked_on: "human", blocked_reason: "spec_pending", spec_comment_url: spec },
      });
      if (!r.ok) throw new Error(r.reason);
      expect(r.item.spec_comment_url).toBe(spec);
      expect(r.state_change.changes.spec_comment_url).toEqual({ from: null, to: spec });

      const fail = "https://github.com/o/r/issues/1#issuecomment-22";
      await store.transition({ id: item.id, expected_version: 2, actor: system, reason: "x", patch: { failure_comment_url: fail } });
      expect(await store.getWorkItem(item.id)).toMatchObject({ spec_comment_url: spec, failure_comment_url: fail });
      expect((await store.getWorkItemBySource("github_issue", item.source.id))!.failure_comment_url).toBe(fail);
      expect((await store.listWorkItemsWhere({ limit: 10 }))[0]).toMatchObject({ spec_comment_url: spec, failure_comment_url: fail });

      await store.transition({ id: item.id, expected_version: 3, actor: system, reason: "x", patch: { failure_comment_url: null } });
      expect(await store.getWorkItem(item.id)).toMatchObject({ spec_comment_url: spec, failure_comment_url: null });
    });
  });

  describe("read-only queries", () => {
    it("findWorkItemIds returns the IDs that start with the prefix: the full ID, a short one, `wi_` alone; none for an empty or overlong prefix", async () => {
      const { store } = await make();
      // 17 items: two of them share their first hex character (pigeonhole), so a one-character prefix matches several.
      const ids: WorkItemId[] = [];
      for (let n = 1; n <= 17; n++) ids.push((await store.createWorkItem(issue(n), system)).item.id);
      const [a] = ids as [WorkItemId];
      expect(await store.findWorkItemIds(a)).toEqual([a]);
      expect(await store.findWorkItemIds(a.slice(0, 11))).toContain(a);
      expect(await store.findWorkItemIds("wi_")).toEqual([...ids].sort());
      const first = ids.map((id) => id.slice(0, 4)).find((p, i, all) => all.indexOf(p) !== i)!;
      const shared = ids.filter((id) => id.startsWith(first)).sort();
      expect(shared.length).toBeGreaterThan(1);
      expect(await store.findWorkItemIds(first)).toEqual(shared);
      expect(await store.findWorkItemIds(`${a}0`)).toEqual([]);
      expect(await store.findWorkItemIds("")).toEqual([]);
      expect(await store.findWorkItemIds("wi_g")).toEqual([]);
    });

    it("listWorkItemsWhere filters by stage, blocked_on and closed, most recently updated first", async () => {
      const { store, clock } = await make();
      const ids = [];
      for (let n = 1; n <= 4; n++) {
        clock.advance(1_000);
        ids.push((await store.createWorkItem(issue(n), system)).item.id);
      }
      const [a, b, c, d] = ids as [WorkItemId, WorkItemId, WorkItemId, WorkItemId];
      clock.advance(1_000);
      await store.transition({ id: a, expected_version: 1, patch: { stage: "READY", blocked_on: "human", blocked_reason: "spec_review" }, actor: system, reason: "x" });
      clock.advance(1_000);
      await store.transition({ id: b, expected_version: 1, patch: { stage: "CLOSED", close_reason: "wont_do" }, actor: system, reason: "x" });
      clock.advance(1_000);
      await store.transition({ id: c, expected_version: 1, patch: { stage: "REVIEW", blocked_on: "human", blocked_reason: "merge_pending" }, actor: system, reason: "x" });

      const idsOf = (xs: { id: WorkItemId }[]) => xs.map((x) => x.id);
      expect(idsOf(await store.listWorkItemsWhere({ limit: 10 }))).toEqual([c, b, a, d]);
      expect(idsOf(await store.listWorkItemsWhere({ exclude_closed: true, limit: 10 }))).toEqual([c, a, d]);
      expect(idsOf(await store.listWorkItemsWhere({ stage: "CLOSED", exclude_closed: true, limit: 10 }))).toEqual([b]);
      expect(idsOf(await store.listWorkItemsWhere({ stage: "READY", limit: 10 }))).toEqual([a]);
      expect(idsOf(await store.listWorkItemsWhere({ blocked_on: "human", limit: 10 }))).toEqual([c, a]);
      expect(idsOf(await store.listWorkItemsWhere({ blocked_on: "human", stage: "REVIEW", limit: 10 }))).toEqual([c]);
      expect(idsOf(await store.listWorkItemsWhere({ limit: 2 }))).toEqual([c, b]);
    });

    it("countWorkItemsByStage counts every stage, 0 when empty", async () => {
      const { store } = await make();
      expect(await store.countWorkItemsByStage()).toEqual({ NEW: 0, READY: 0, RUNNING: 0, REVIEW: 0, CLOSED: 0 });
      const { item } = await store.createWorkItem(issue(1), system);
      await store.createWorkItem(issue(2), system);
      await store.transition({ id: item.id, expected_version: 1, patch: { stage: "CLOSED", close_reason: "wont_do" }, actor: system, reason: "x" });
      expect(await store.countWorkItemsByStage()).toEqual({ NEW: 1, READY: 0, RUNNING: 0, REVIEW: 0, CLOSED: 1 });
    });

    it("system items are left out of countWorkItemsByStage and of lists that exclude them", async () => {
      const { store } = await make();
      const { item } = await store.createWorkItem(issue(1), system);
      const sys = await store.createWorkItem({ ...issue(2), hold: { blocked_on: "upstream", blocked_reason: "system_item" } }, system);
      expect((await store.countWorkItemsByStage()).NEW).toBe(1);
      expect((await store.listWorkItemsWhere({ exclude_system: true, limit: 10 })).map((i) => i.id)).toEqual([item.id]);
      expect(await store.countWorkItemsWhere({ exclude_system: true })).toBe(1);
      expect((await store.listWorkItemsWhere({ limit: 10 })).map((i) => i.id)).toContain(sys.item.id);
    });

    it("listRunsByStatus returns runs in the given statuses, oldest first, up to the limit", async () => {
      const { store, clock } = await make();
      for (let n = 1; n <= 3; n++) {
        clock.advance(1_000);
        await store.createWorkItem(issue(n), system, { enqueue: { kind: "triage", idempotency_key: `t${n}` } });
      }
      const claimed = (await store.claimRun({ worker_id: w1, kinds: ["triage"], lease_ms: LEASE }))!;
      expect(claimed.idempotency_key).toBe("t1");
      expect((await store.listRunsByStatus(["queued"], 10)).map((r) => r.idempotency_key)).toEqual(["t2", "t3"]);
      expect((await store.listRunsByStatus(["queued"], 1)).map((r) => r.idempotency_key)).toEqual(["t2"]);
      expect((await store.listRunsByStatus(["running"], 10)).map((r) => r.id)).toEqual([claimed.id]);
      expect(await store.listRunsByStatus(["queued", "running"], 10)).toHaveLength(3);
      expect(await store.listRunsByStatus([], 10)).toEqual([]);
    });

    it("listRunsFinishedWithin returns runs finished inside the window, newest first", async () => {
      const { store, clock } = await make();
      const DAY = 24 * 60 * 60 * 1000;
      for (let n = 1; n <= 3; n++) {
        await store.createWorkItem(issue(n), system, { enqueue: { kind: "triage", idempotency_key: `t${n}` } });
      }
      const finish = async (outcome: Parameters<FactoryStore["completeRun"]>[2]) => {
        const r = (await store.claimRun({ worker_id: w1, kinds: ["triage"], lease_ms: LEASE }))!;
        await store.completeRun(r.id, r.lease!.token, outcome);
        return r.id;
      };
      const old = await finish({ status: "succeeded", summary: "", data: { tokens: 5 } });
      clock.advance(DAY);
      const recentOk = await finish({ status: "succeeded", summary: "", data: { tokens: 7 } });
      clock.advance(1_000);
      const recentFail = await finish({ status: "failed", error_code: "x", detail: "", infra: false });
      clock.advance(1_000);

      const within = await store.listRunsFinishedWithin(DAY);
      expect(within.map((r) => r.id)).toEqual([recentFail, recentOk]);
      expect(within.map((r) => r.id)).not.toContain(old);
      expect((await store.listRunsFinishedWithin(DAY + 10_000)).map((r) => r.id)).toEqual([recentFail, recentOk, old]);
    });

    it("countWorkItemsWhere counts every match, with no limit, by stage, blocked_on and closed", async () => {
      const { store } = await make();
      const filter = { blocked_on: "human" as const, exclude_closed: true };
      expect(await store.countWorkItemsWhere(filter)).toBe(0);
      const ids = [];
      for (let n = 1; n <= 6; n++) ids.push((await store.createWorkItem(issue(n), system)).item.id);
      const block = (id: WorkItemId, patch: Parameters<FactoryStore["transition"]>[0]["patch"]) =>
        store.transition({ id, expected_version: 1, patch, actor: system, reason: "x" });
      await block(ids[0]!, { stage: "READY", blocked_on: "human", blocked_reason: "spec_pending" });
      await block(ids[1]!, { stage: "REVIEW", blocked_on: "human", blocked_reason: "merge_pending" });
      await block(ids[2]!, { stage: "RUNNING", blocked_on: "human", blocked_reason: "max_attempts" });
      await block(ids[3]!, { stage: "CLOSED", close_reason: "rejected", blocked_on: "human", blocked_reason: "x" });
      await block(ids[4]!, { stage: "RUNNING", blocked_on: "upstream" });
      expect(await store.countWorkItemsWhere(filter)).toBe(3);
      expect(await store.countWorkItemsWhere({ blocked_on: "human" })).toBe(4);
      expect(await store.countWorkItemsWhere({ blocked_on: "human", stage: "REVIEW" })).toBe(1);
      expect(await store.countWorkItemsWhere({})).toBe(6);
      expect(await store.countWorkItemsWhere({ exclude_closed: true })).toBe(5);
    });

    it("the read methods write nothing", async () => {
      const { store } = await make();
      const { item } = await store.createWorkItem(issue(1), system, { enqueue: { kind: "triage", idempotency_key: "t" } });
      const before = { item: await store.getWorkItem(item.id), runs: await store.listRuns(item.id), sc: await store.listStateChanges(item.id) };
      await store.listWorkItemsWhere({ limit: 10 });
      await store.countWorkItemsWhere({ blocked_on: "human", exclude_closed: true });
      await store.countWorkItemsByStage();
      await store.listRunsByStatus(["queued", "running"], 10);
      await store.listRunsFinishedWithin(1_000);
      expect({ item: await store.getWorkItem(item.id), runs: await store.listRuns(item.id), sc: await store.listStateChanges(item.id) }).toEqual(before);
    });
  });

  describe("controller_verdicts", () => {
    const user = { kind: "user" as const, id: "github:1" as UserId };
    const verdict = (id: WorkItemId, expected_version: number, comment_id = "c1") => ({
      id, expected_version, actor: user, verdict: "changes" as const, severity: "minor" as const,
      reason: "rename it", comment_id, target: "pr" as const, implicit: false, pr_head: null,
    });

    it("records a verdict: version + 1, a human_verdict state change with empty changes, and a linked verdict row", async () => {
      const { store } = await make();
      const { item } = await store.createWorkItem(issue(1), system);
      await store.transition({
        id: item.id, expected_version: 1, actor: system, reason: "x",
        patch: { stage: "REVIEW", blocked_on: "human", blocked_reason: "merge_pending", change_ref: "9" },
      });
      const r = await store.recordVerdict(verdict(item.id, 2));
      if (!r.ok) throw new Error(r.reason);
      expect(r.item).toMatchObject({ version: 3, stage: "REVIEW", blocked_on: "human", blocked_reason: "merge_pending" });
      expect(r.state_change).toMatchObject({ version: 3, actor: user, reason: "human_verdict", changes: {}, detail: null });
      expect(r.verdict).toMatchObject({
        work_item_id: item.id, state_change_id: r.state_change.id, verdict: "changes", severity: "minor",
        reason: "rename it", comment_id: "c1", target: "pr",
      });
      expect(await store.listVerdicts(item.id)).toEqual([r.verdict]);
      expect((await store.listStateChanges(item.id)).at(-1)).toEqual(r.state_change);

      const accept = await store.recordVerdict({ ...verdict(item.id, 3, "c2"), verdict: "accept", severity: "none", reason: null, target: "issue" });
      expect(accept.ok && accept.verdict.reason).toBeNull();
      expect((await store.listVerdicts(item.id)).map((v) => v.comment_id)).toEqual(["c1", "c2"]);
    });

    it("a duplicate comment id is a no-op, whatever the expected version", async () => {
      const { store } = await make();
      const { item } = await store.createWorkItem(issue(1), system);
      const first = await store.recordVerdict(verdict(item.id, 1));
      if (!first.ok) throw new Error(first.reason);
      for (const v of [2, 1]) {
        expect(await store.recordVerdict(verdict(item.id, v))).toEqual({ ok: false, reason: "duplicate", verdict: first.verdict });
      }
      expect((await store.getWorkItem(item.id))!.version).toBe(2);
      expect(await store.listVerdicts(item.id)).toHaveLength(1);
      expect(await store.listStateChanges(item.id)).toHaveLength(2);
    });

    it("replace (a one-tap verdict): a different verdict under the same comment id updates its one row; the same one is a duplicate", async () => {
      const { store } = await make();
      const { item } = await store.createWorkItem(issue(1), system);
      const key = "button:C1:1800000000.000100:run_1";
      const good = await store.recordVerdict({ ...verdict(item.id, 1, key), verdict: "accept", severity: "none", reason: null, replace: true });
      if (!good.ok) throw new Error(good.reason);
      const bad = await store.recordVerdict({ ...verdict(item.id, 2, key), reason: null, replace: true });
      if (!bad.ok) throw new Error(bad.reason);
      expect(bad.verdict).toMatchObject({ id: good.verdict.id, comment_id: key, verdict: "changes", severity: "minor", reason: null, state_change_id: bad.state_change.id });
      expect(await store.listVerdicts(item.id)).toEqual([bad.verdict]);
      expect(bad.state_change).toMatchObject({ version: 3, reason: "human_verdict", actor: user });
      expect(await store.recordVerdict({ ...verdict(item.id, 3, key), reason: null, replace: true })).toEqual({ ok: false, reason: "duplicate", verdict: bad.verdict });
      // Without replace, a stored comment id stays a duplicate.
      expect(await store.recordVerdict({ ...verdict(item.id, 3, key), verdict: "accept", severity: "none", reason: null })).toMatchObject({ ok: false, reason: "duplicate" });
      expect((await store.getWorkItem(item.id))!.version).toBe(3);
    });

    it("concurrent deliveries of one comment store one verdict", async () => {
      const { store } = await make();
      const { item } = await store.createWorkItem(issue(1), system);
      const rs = await Promise.all([store.recordVerdict(verdict(item.id, 1)), store.recordVerdict(verdict(item.id, 1))]);
      expect(rs.filter((r) => r.ok)).toHaveLength(1);
      expect(await store.listVerdicts(item.id)).toHaveLength(1);
      expect(await store.listStateChanges(item.id)).toHaveLength(2);
    });

    it("an implicit verdict: an implicit_verdict state change, implicit and pr_head stored, no other field changed", async () => {
      const { store } = await make();
      const { item } = await store.createWorkItem(issue(1), system);
      const r = await store.recordVerdict({ ...verdict(item.id, 1, "implicit:pushed:h2"), actor: system, implicit: true, pr_head: "h2" });
      if (!r.ok) throw new Error(r.reason);
      expect(r.item).toMatchObject({ version: 2, stage: item.stage, blocked_on: item.blocked_on, blocked_reason: item.blocked_reason });
      expect(r.state_change).toMatchObject({ version: 2, actor: system, reason: "implicit_verdict", changes: {} });
      expect(r.verdict).toMatchObject({ implicit: true, pr_head: "h2", comment_id: "implicit:pushed:h2" });
      expect(await store.listVerdicts(item.id)).toEqual([r.verdict]);
    });

    it("one verdict per PR head: a second implicit one is a duplicate; an explicit one replaces the implicit one", async () => {
      const { store } = await make();
      const { item } = await store.createWorkItem(issue(1), system);
      const implicit = { ...verdict(item.id, 1, "implicit:pushed:h2"), actor: system, implicit: true, pr_head: "h2" };
      const first = await store.recordVerdict(implicit);
      if (!first.ok) throw new Error(first.reason);
      const again = await store.recordVerdict({ ...implicit, expected_version: 2, comment_id: "implicit:merged:m1", verdict: "accept" });
      expect(again).toEqual({ ok: false, reason: "duplicate", verdict: first.verdict });
      // Another head is its own.
      const other = await store.recordVerdict({ ...implicit, expected_version: 2, comment_id: "implicit:pushed:h3", pr_head: "h3" });
      expect(other.ok).toBe(true);

      const explicit = await store.recordVerdict({ ...verdict(item.id, 3, "c9"), verdict: "accept", severity: "none", reason: null, pr_head: "h2" });
      if (!explicit.ok) throw new Error(explicit.reason);
      expect((await store.listVerdicts(item.id)).map((v) => [v.comment_id, v.pr_head, v.implicit])).toEqual([
        ["implicit:pushed:h3", "h3", true],
        ["c9", "h2", false],
      ]);
      // An implicit one after the explicit one on that head stores nothing; the replaced one's state change stays.
      expect(await store.recordVerdict({ ...implicit, expected_version: 4, comment_id: "implicit:merged:m2" })).toMatchObject({ ok: false, reason: "duplicate" });
      expect((await store.listStateChanges(item.id)).map((c) => c.reason)).toEqual(["intake", "implicit_verdict", "implicit_verdict", "human_verdict"]);
    });

    it("applies only on the expected version; a conflict stores nothing", async () => {
      const { store } = await make();
      const { item } = await store.createWorkItem(issue(1), system);
      await store.transition({ id: item.id, expected_version: 1, actor: system, reason: "x", patch: { stage: "READY" } });
      const r = await store.recordVerdict(verdict(item.id, 1));
      expect(r).toMatchObject({ ok: false, reason: "version_conflict", current: { version: 2, stage: "READY" } });
      expect(await store.listVerdicts(item.id)).toEqual([]);
      expect(await store.listStateChanges(item.id)).toHaveLength(2);
      expect(await store.recordVerdict(verdict("wi_missing" as WorkItemId, 1))).toEqual({ ok: false, reason: "not_found" });
    });
  });

  describe("signal ledger (design 11-signal-ledger)", () => {
    it("recordSignal stores a (source, source_ref) once; latestSignalTimes and listSignalRefs read the stored rows per source", async () => {
      const { store } = await make();
      const s = { source: "verdicts", source_ref: "vd_1", kind: "human_verdict", work_item_id: "wi_1" as WorkItemId, role: null, rule: null, at: "2026-11-11T00:00:00.000Z" as Timestamp };
      expect(await store.recordSignal(s)).toBe(true);
      expect(await store.recordSignal({ ...s, kind: "implicit_verdict", at: "2026-11-12T00:00:00.000Z" as Timestamp })).toBe(false);
      expect(await store.recordSignal({ ...s, source_ref: "vd_2", role: "review", rule: "spec-t1", at: "2026-11-11T01:00:00.000Z" as Timestamp })).toBe(true);
      expect(await store.recordSignal({ ...s, source: "failed_runs", source_ref: "run_1", kind: "run_failed", at: "2026-11-11T00:30:00.000Z" as Timestamp })).toBe(true);
      const latest = await store.latestSignalTimes();
      expect(latest.get("verdicts")).toBe("2026-11-11T01:00:00.000Z");
      expect(latest.get("failed_runs")).toBe("2026-11-11T00:30:00.000Z");
      expect(latest.has("review_findings")).toBe(false);
      const refs = await store.listSignalRefs([
        { source: "verdicts", since: "2026-11-11T00:10:00.000Z" as Timestamp },
        { source: "failed_runs", since: "2026-11-11T00:00:00.000Z" as Timestamp },
      ]);
      expect(refs.map((r) => `${r.source}/${r.source_ref}`).sort()).toEqual(["failed_runs/run_1", "verdicts/vd_2"]);
      expect(await store.listSignalRefs([])).toEqual([]);
    });

    it("reads state changes by reason, verdicts and finished runs across items, from a time", async () => {
      const { store, clock } = await make();
      const a = (await store.createWorkItem(issue(1), system)).item;
      const b = (await store.createWorkItem(issue(2), system)).item;
      clock.advance(1000);
      const since = clock.now().toISOString() as Timestamp;
      const ra = await store.transition({ id: a.id, expected_version: 1, patch: {}, actor: human, reason: "spec_approved", enqueue: { kind: "review", idempotency_key: "r:a" } });
      clock.advance(1000);
      const rb = await store.transition({ id: b.id, expected_version: 1, patch: {}, actor: human, reason: "reverted" });
      expect(ra.ok && rb.ok).toBe(true);
      const reasons = ["spec_approved", "reverted"];
      expect((await store.listStateChangesSince({ reasons, since: null })).map((c) => c.reason)).toEqual(["spec_approved", "reverted"]);
      expect((await store.listStateChangesSince({ reasons: ["intake"], since })).length).toBe(0);
      expect((await store.listStateChangesSince({ reasons: ["intake"], since: null })).map((c) => c.work_item_id).sort()).toEqual([a.id, b.id].sort());
      expect((await store.listStateChangesSince({ reasons, since: null, work_item_ids: [b.id] })).map((c) => c.reason)).toEqual(["reverted"]);
      expect(await store.listStateChangesSince({ reasons: [], since: null })).toEqual([]);

      const v = await store.recordVerdict({ id: b.id, expected_version: 2, actor: human, verdict: "accept", severity: "none", reason: null, comment_id: "c1", target: "pr", implicit: false, pr_head: null });
      expect(v.ok).toBe(true);
      expect((await store.listVerdictsSince(since)).map((x) => x.comment_id)).toEqual(["c1"]);
      clock.advance(1000);
      expect(await store.listVerdictsSince(clock.now().toISOString() as Timestamp)).toEqual([]);

      const run = (await store.claimRun({ worker_id: w1, kinds: ["review"], lease_ms: 60_000 }))!;
      await store.completeRun(run.id, run.lease!.token, { status: "failed", error_code: "x", detail: "", infra: false });
      expect((await store.listRunsFinishedSince({ status: "failed", since })).map((r) => r.id)).toEqual([run.id]);
      expect((await store.listRunsFinishedSince({ status: "failed", kinds: ["implement"], since: null }))).toEqual([]);
      expect((await store.listRunsFinishedSince({ status: "succeeded", since: null }))).toEqual([]);
      clock.advance(1000);
      expect(await store.listRunsFinishedSince({ status: "failed", since: clock.now().toISOString() as Timestamp })).toEqual([]);
    });
  });

  describe("owner notices (design 09-notifications)", () => {
    const at = (h: number) => `2026-11-12T0${h}:00:00.000Z` as Timestamp;
    const notice = { work_item_id: "wi_1", wait_key: "sc_1", kind: "spec" as const, created_at: at(1), held_until: null, count: 1 };

    it("recordNotice stores a (work item, wait key) once; listNoticesFor reads by item ID", async () => {
      const { store } = await make();
      expect(await store.recordNotice(notice)).toBe(true);
      expect(await store.recordNotice({ ...notice, kind: "merge", created_at: at(2) })).toBe(false);
      expect(await store.recordNotice({ ...notice, wait_key: "sc_2", created_at: at(3) })).toBe(true);
      expect(await store.recordNotice({ ...notice, work_item_id: "wi_2" })).toBe(true);
      expect(await store.recordNotice({ ...notice, work_item_id: "", wait_key: "quiet:x", kind: "summary", count: 3 })).toBe(true);
      const of1 = await store.listNoticesFor(["wi_1"]);
      expect(of1.map((n) => [n.wait_key, n.kind, n.created_at, n.delivered_at]).sort()).toEqual([["sc_1", "spec", at(1), null], ["sc_2", "spec", at(3), null]]);
      expect((await store.listNoticesFor(["", "wi_2"])).map((n) => [n.work_item_id, n.count]).sort()).toEqual([["", 3], ["wi_2", 1]]);
      expect(await store.listNoticesFor([])).toEqual([]);
    });

    it("listHeldNotices and listPendingNotices split the undelivered notices on held_until, oldest first", async () => {
      const { store } = await make();
      await store.recordNotice({ ...notice, wait_key: "sc_held", created_at: at(2), held_until: at(7) });
      await store.recordNotice({ ...notice, wait_key: "sc_late", created_at: at(3) });
      await store.recordNotice({ ...notice, wait_key: "sc_early", created_at: at(1) });
      expect((await store.listHeldNotices()).map((n) => [n.wait_key, n.held_until])).toEqual([["sc_held", at(7)]]);
      expect((await store.listPendingNotices()).map((n) => n.wait_key)).toEqual(["sc_early", "sc_late"]);
    });
  });

  describe("notice records (design 05-sources, replies under a notice)", () => {
    it("recordNoticeMessage stores a notice's item IDs once per (channel, ts); getNoticeMessage reads them in order", async () => {
      const { store, clock } = await make();
      expect(await store.recordNoticeMessage({ channel: "C1", ts: "1.000100", work_item_ids: ["wi_2", "wi_1"] })).toBe(true);
      clock.advance(1_000);
      expect(await store.recordNoticeMessage({ channel: "C1", ts: "1.000100", work_item_ids: ["wi_3"] })).toBe(false);
      expect(await store.recordNoticeMessage({ channel: "C2", ts: "1.000100", work_item_ids: [] })).toBe(true);
      const first = await store.getNoticeMessage("C1", "1.000100");
      expect(first).toMatchObject({ channel: "C1", ts: "1.000100", work_item_ids: ["wi_2", "wi_1"] });
      expect(await store.getNoticeMessage("C2", "1.000100")).toMatchObject({ work_item_ids: [] });
      expect(await store.getNoticeMessage("C1", "2.000100")).toBeNull();
    });

    it("recordNoticeQuestion stores a reply's words once per ID; getNoticeQuestion reads them", async () => {
      const { store } = await make();
      const q = { id: "Ev01", channel: "C1", notice_ts: "1.000100", text: "go ahead and merge" };
      expect(await store.recordNoticeQuestion(q)).toBe(true);
      expect(await store.recordNoticeQuestion({ ...q, text: "approve" })).toBe(false);
      expect(await store.getNoticeQuestion("Ev01")).toMatchObject(q);
      expect(await store.getNoticeQuestion("Ev02")).toBeNull();
    });
  });

  describe("listStatsRecords", () => {
    it("returns every item with its tier, stage, token_cost, the requested reasons, its explicit verdict severities and its implicit count", async () => {
      const { store, clock } = await make();
      expect(await store.listStatsRecords(["spec_rejected", "retry_requested"])).toEqual([]);

      clock.advance(1_000);
      const a = (await store.createWorkItem(issue(1), system)).item;
      clock.advance(1_000);
      const b = (await store.createWorkItem(issue(2), system)).item;
      await store.transition({ id: a.id, expected_version: 1, actor: system, reason: "triaged", patch: { stage: "READY", tier: 2, token_cost: 40 } });
      await store.transition({ id: a.id, expected_version: 2, actor: human, reason: "retry_requested", patch: {} });
      await store.recordVerdict({
        id: a.id, expected_version: 3, actor: { kind: "user", id: "github:1" as UserId }, verdict: "changes",
        severity: "major", reason: "r", comment_id: "c1", target: "pr", implicit: false, pr_head: null,
      });
      await store.transition({ id: a.id, expected_version: 4, actor: human, reason: "retry_requested", patch: {} });
      await store.recordVerdict({
        id: a.id, expected_version: 5, actor: { kind: "user", id: "github:1" as UserId }, verdict: "accept",
        severity: "none", reason: null, comment_id: "c2", target: "pr", implicit: false, pr_head: "h1",
      });
      await store.recordVerdict({
        id: a.id, expected_version: 6, actor: system, verdict: "reverted", severity: "major", reason: "reverted",
        comment_id: "implicit:reverted:a", target: "pr", implicit: true, pr_head: null,
      });
      await store.transition({
        id: b.id, expected_version: 1, actor: human, reason: "spec_rejected",
        patch: { stage: "CLOSED", close_reason: "rejected" },
      });

      expect(await store.listStatsRecords(["spec_rejected", "retry_requested"])).toEqual([
        { id: a.id, tier: 2, stage: "READY", token_cost: 40, reasons: ["retry_requested", "retry_requested"], severities: ["major", "none"], implicit: 1, origin: "factory", pushed: false, merged: false },
        { id: b.id, tier: null, stage: "CLOSED", token_cost: 0, reasons: ["spec_rejected"], severities: [], implicit: 0, origin: "factory", pushed: false, merged: false },
      ]);
      expect((await store.listStatsRecords([])).map((r) => r.reasons)).toEqual([[], []]);
    });

    it("sets pushed for an implicit changes verdict and merged for CLOSED completed only", async () => {
      const { store, clock } = await make();
      const close = async (id: WorkItemId, version: number, close_reason: "completed" | "rejected") => {
        const r = await store.transition({ id, expected_version: version, actor: system, reason: "x", patch: { stage: "CLOSED", close_reason } });
        if (!r.ok) throw new Error(r.reason);
      };
      const implicit = (id: WorkItemId, version: number, verdict: "changes" | "accept", head: string) =>
        store.recordVerdict({
          id, expected_version: version, actor: system, verdict, severity: verdict === "changes" ? "critical" : "none",
          reason: "x", comment_id: `implicit:${head}`, target: "pr", implicit: true, pr_head: head,
        });
      const pushedMerged = (await store.createWorkItem(issue(1), system)).item;
      clock.advance(1_000);
      const acceptMerged = (await store.createWorkItem(issue(2), system)).item;
      clock.advance(1_000);
      const pushedRejected = (await store.createWorkItem(issue(3), system)).item;
      clock.advance(1_000);
      const explicitChanges = (await store.createWorkItem(issue(4), system)).item;
      await implicit(pushedMerged.id, 1, "changes", "h1");
      await implicit(pushedMerged.id, 2, "accept", "h2");
      await close(pushedMerged.id, 3, "completed");
      await implicit(acceptMerged.id, 1, "accept", "h3");
      await close(acceptMerged.id, 2, "completed");
      await implicit(pushedRejected.id, 1, "changes", "h4");
      await close(pushedRejected.id, 2, "rejected");
      await store.recordVerdict({
        id: explicitChanges.id, expected_version: 1, actor: { kind: "user", id: "github:1" as UserId }, verdict: "changes",
        severity: "major", reason: "r", comment_id: "c1", target: "pr", implicit: false, pr_head: null,
      });
      await close(explicitChanges.id, 2, "completed");

      const flags = (await store.listStatsRecords([])).map((r) => ({ id: r.id, pushed: r.pushed, merged: r.merged }));
      expect(flags).toEqual([
        { id: pushedMerged.id, pushed: true, merged: true },
        { id: acceptMerged.id, pushed: false, merged: true },
        { id: pushedRejected.id, pushed: true, merged: false },
        { id: explicitChanges.id, pushed: false, merged: true },
      ]);
    });

    it("writes nothing", async () => {
      const { store } = await make();
      const { item } = await store.createWorkItem(issue(1), system, { enqueue: { kind: "triage", idempotency_key: "t" } });
      const before = { item: await store.getWorkItem(item.id), runs: await store.listRuns(item.id), sc: await store.listStateChanges(item.id) };
      await store.listStatsRecords(["intake", "spec_rejected"]);
      expect({ item: await store.getWorkItem(item.id), runs: await store.listRuns(item.id), sc: await store.listStateChanges(item.id) }).toEqual(before);
    });
  });

  describe("retry waits and the claim pause", () => {
    it("a run enqueued with not_before is not claimed before it, by any worker, and is claimed at that exact time", async () => {
      const { store, clock } = await make();
      const { item } = await store.createWorkItem(issue(1), system);
      const at = new Date(clock.now().getTime() + 60_000).toISOString();
      const r = await store.transition({
        id: item.id, expected_version: 1, patch: {}, actor: system, reason: "x",
        enqueue: { kind: "triage", idempotency_key: "t:a1", not_before: at as never },
      });
      expect(r.ok && r.enqueued?.not_before).toBe(at);
      clock.advance(59_999);
      expect(await store.claimRun({ worker_id: w1, kinds: ["triage"], lease_ms: LEASE })).toBeNull();
      expect(await store.claimRun({ worker_id: w2, kinds: ["triage"], lease_ms: LEASE })).toBeNull();
      clock.advance(1);
      expect((await store.claimRun({ worker_id: w2, kinds: ["triage"], lease_ms: LEASE }))?.idempotency_key).toBe("t:a1");
    });

    it("a waiting run does not hold up a later run that may start now", async () => {
      const { store, clock } = await make();
      const { item } = await store.createWorkItem(issue(1), system);
      await store.transition({
        id: item.id, expected_version: 1, patch: {}, actor: system, reason: "x",
        enqueue: { kind: "triage", idempotency_key: "wait", not_before: new Date(clock.now().getTime() + 1_000).toISOString() as never },
      });
      await store.createWorkItem(issue(2), system, { enqueue: { kind: "triage", idempotency_key: "now" } });
      expect((await store.claimRun({ worker_id: w1, kinds: ["triage"], lease_ms: LEASE }))?.idempotency_key).toBe("now");
    });

    it("the reaper requeues an expired run with the backoff it is given, stored on the run", async () => {
      const { store, clock } = await make();
      await store.createWorkItem(issue(1), system, { enqueue: { kind: "triage", idempotency_key: "t" } });
      const run = (await store.claimRun({ worker_id: w1, kinds: ["triage"], lease_ms: LEASE }))!;
      clock.advance(LEASE + 1);
      expect(await store.expireLeases(3, (attempt) => attempt * 10_000)).toEqual([run.id]);
      const requeued = (await store.getRun(run.id))!;
      expect(requeued).toMatchObject({ status: "queued", not_before: new Date(clock.now().getTime() + 10_000).toISOString() });
      clock.advance(9_999);
      expect(await store.claimRun({ worker_id: w2, kinds: ["triage"], lease_ms: LEASE })).toBeNull();
      clock.advance(1);
      expect((await store.claimRun({ worker_id: w2, kinds: ["triage"], lease_ms: LEASE }))?.id).toBe(run.id);
    });

    it("a claim pause stops every claim until resume_at; it only ever moves later", async () => {
      const { store, clock } = await make();
      await store.createWorkItem(issue(1), system, { enqueue: { kind: "triage", idempotency_key: "t" } });
      const until = new Date(clock.now().getTime() + 30_000).toISOString();
      expect(await store.getClaimPause()).toBeNull();
      expect(await store.pauseClaims(until as never)).toEqual({ extended: true, resume_at: until });
      // An earlier time does not shorten it; the same time again is not an extension.
      expect(await store.pauseClaims(new Date(clock.now().getTime() + 1_000).toISOString() as never)).toEqual({ extended: false, resume_at: until });
      expect(await store.pauseClaims(until as never)).toEqual({ extended: false, resume_at: until });
      expect(await store.getClaimPause()).toBe(until);

      clock.advance(29_999);
      expect(await store.claimRun({ worker_id: w1, kinds: ["triage"], lease_ms: LEASE })).toBeNull();
      expect(await store.claimRun({ worker_id: w2, kinds: ["triage"], lease_ms: LEASE })).toBeNull();
      clock.advance(1);
      expect(await store.claimRun({ worker_id: w2, kinds: ["triage"], lease_ms: LEASE })).not.toBeNull();
    });

    const pauseRows = async (store: FactoryStore) => (await store.listTableRows({ table: "worker_claim_pauses", limit: 200 }))!.rows;
    const later = (clock: { now(): Date }, ms: number) => new Date(clock.now().getTime() + ms).toISOString() as Timestamp;

    it.each(["rate_limit", "forge_auth", "preflight_access", "model_stall"] as const)(
      "endClaimPause ends an active %s pause, and the next claim takes a queued triage run",
      async (pause) => {
        const { store, clock } = await make();
        await store.createWorkItem(issue(1), system, { enqueue: { kind: "triage", idempotency_key: "t" } });
        await store.pauseClaims(later(clock, 60_000), pause);
        expect(await store.getClaimPause(pause)).not.toBeNull();
        expect(await store.endClaimPause(pause)).toEqual({ ended: true });
        expect(await store.getClaimPause(pause)).toBeNull();
        expect((await store.claimRun({ worker_id: w1, kinds: ["triage"], lease_ms: LEASE }))?.idempotency_key).toBe("t");
      },
    );

    // Bug: the missing model credential's pause lives in one process (or runs out at a time), so another worker
    // claims agent runs that fail, or the pause starts again on every check and logs once per tick.
    it("the model_credential pause is one row every store on the database sees: started once, in effect until ended", async () => {
      const dir = mkdtempSync(join(tmpdir(), "sf-credential-pause-"));
      const clock = new FakeClock();
      const open = async () => {
        const s = new SqlFactoryStore(new SqliteDriver(join(dir, "factory.db")), clock);
        await s.migrate();
        return s;
      };
      const [a, b] = [await open(), await open()];
      const forever = "9999-12-31T23:59:59.999Z" as Timestamp;
      expect((await a.pauseClaims(forever, "model_credential")).started).toBe(true);
      expect((await b.pauseClaims(forever, "model_credential")).started).toBe(false);
      clock.advance(400 * 24 * 3_600_000);
      expect(await b.getClaimPause("model_credential")).toBe(forever);
      expect(await b.endClaimPause("model_credential")).toEqual({ ended: true });
      expect(await a.getClaimPause("model_credential")).toBeNull();
      expect((await a.pauseClaims(forever, "model_credential")).started).toBe(true);
      await a.close();
      await b.close();
    });

    it("ending a model_stall pause also clears model_stall_since, even after the probe time passed", async () => {
      const { store, clock } = await make();
      await store.pauseClaims(later(clock, 1_000), "model_stall");
      clock.advance(5_000);
      expect(await store.getClaimPause("model_stall_since")).not.toBeNull();
      expect(await store.endClaimPause("model_stall")).toEqual({ ended: true });
      expect(await store.getClaimPause("model_stall_since")).toBeNull();
      expect(await store.getClaimPause("model_stall")).toBeNull();
    });

    it("a second endClaimPause, or one with no pause in effect, succeeds and changes no claim_pauses row", async () => {
      const { store, clock } = await make();
      for (const pause of ["rate_limit", "forge_auth", "preflight_access", "model_stall"] as const) {
        expect(await store.endClaimPause(pause)).toEqual({ ended: false });
      }
      expect(await pauseRows(store)).toEqual([]);

      for (const pause of ["rate_limit", "forge_auth", "preflight_access", "model_stall"] as const) {
        await store.pauseClaims(later(clock, 60_000), pause);
        await store.endClaimPause(pause);
      }
      // A pause that ran out by itself is not in effect either.
      const sorted = async () => (await pauseRows(store)).sort((a, b) => String(a.name).localeCompare(String(b.name)));
      const before = await sorted();
      clock.advance(1_000);
      for (const pause of ["rate_limit", "forge_auth", "preflight_access", "model_stall"] as const) {
        expect(await store.endClaimPause(pause)).toEqual({ ended: false });
      }
      expect(await sorted()).toEqual(before);
    });

    it("claimProbe moves a due model_stall probe time once: a second caller for the same due time gets false", async () => {
      const { store, clock } = await make();
      const due = later(clock, 1_000);
      await store.pauseClaims(due, "model_stall");
      clock.advance(1_000);
      const next = later(clock, 60_000);
      expect(await store.claimProbe("model_stall", due, next)).toBe(true);
      expect(await store.getClaimPause("model_stall")).toBe(next);
      // The same due time again, also with another next time: already taken, nothing moves.
      expect(await store.claimProbe("model_stall", due, later(clock, 90_000))).toBe(false);
      expect(await store.getClaimPause("model_stall")).toBe(next);
    });

    it("a stall right after a model_stall pause ended before its probe time starts a new pause", async () => {
      const { store, clock } = await make();
      await store.pauseClaims(later(clock, 60_000), "model_stall");
      expect(await store.endClaimPause("model_stall")).toEqual({ ended: true });
      expect(await store.pauseClaims(later(clock, 60_000), "model_stall")).toMatchObject({ started: true });
      expect(await store.getClaimPause("model_stall")).toBe(later(clock, 60_000));
    });

    it("claimProbe takes no model_stall probe once the pause ended, so it never starts the pause again", async () => {
      const { store, clock } = await make();
      expect(await store.claimProbe("model_stall", later(clock, 0), later(clock, 60_000))).toBe(false);
      const due = later(clock, 1_000);
      await store.pauseClaims(due, "model_stall");
      clock.advance(1_000);
      await store.endClaimPause("model_stall");
      expect(await store.claimProbe("model_stall", due, later(clock, 60_000))).toBe(false);
      expect(await store.getClaimPause("model_stall")).toBeNull();
    });

    it("endClaimPause refuses model_stall_since and model_answered, which are not pauses of their own", async () => {
      const { store } = await make();
      await expect(store.endClaimPause("model_stall_since")).rejects.toThrow(/not a pause/);
      await expect(store.endClaimPause("model_answered")).rejects.toThrow(/not a pause/);
    });

    describe("pause history (design 07-self-improvement)", () => {
      const at = (iso: string) => iso as Timestamp;
      const historyRows = async (store: FactoryStore) => (await store.listTableRows({ table: "controller_pause_history", limit: 200 }))!.rows;

      it("pauseAt matches an ended pause from its start, inclusive, to its end, exclusive", async () => {
        const { store } = await make();
        const outage = { name: "model_stall" as const, started_at: at("2026-11-16T17:00:00.000Z"), ended_at: at("2026-11-16T19:30:00.000Z") };
        expect(await store.recordEndedPause(outage)).toBe(true);
        expect(await store.pauseAt(at("2026-11-16T16:59:59.999Z"))).toBeNull();
        expect(await store.pauseAt(outage.started_at)).toEqual(outage);
        expect(await store.pauseAt(at("2026-11-16T19:29:59.999Z"))).toEqual(outage);
        expect(await store.pauseAt(outage.ended_at)).toBeNull();
      });

      it("a pause is stored once: a second record of the same pause is a no-op and never overwrites the row", async () => {
        const { store } = await make();
        const p = { name: "network" as const, started_at: at("2026-11-16T17:00:00.000Z"), ended_at: at("2026-11-16T17:10:00.000Z") };
        expect(await store.recordEndedPause(p)).toBe(true);
        expect(await store.recordEndedPause({ ...p, ended_at: at("2026-11-16T18:00:00.000Z") })).toBe(false);
        expect(await historyRows(store)).toEqual([expect.objectContaining({ name: "network", started_at: p.started_at, ended_at: p.ended_at })]);
      });

      it.each(["model_stall", "network"] as const)("ending a %s pause records it once, from its since row to now; while open, pauseAt matches it", async (pause) => {
        const { store, clock } = await make();
        const started_at = clock.now().toISOString() as Timestamp;
        await store.pauseClaims(later(clock, 1_000), pause);
        clock.advance(5_000);
        // Still open, past its probe time: a time from its start on matches, with no end yet.
        expect(await store.pauseAt(started_at)).toEqual({ name: pause, started_at, ended_at: null });
        expect(await store.pauseAt(at(new Date(Date.parse(started_at) - 1).toISOString()))).toBeNull();
        expect(await historyRows(store)).toEqual([]);
        const ended_at = clock.now().toISOString() as Timestamp;
        expect(await store.endClaimPause(pause)).toEqual({ ended: true });
        expect(await store.endClaimPause(pause)).toEqual({ ended: false });
        expect(await historyRows(store)).toEqual([expect.objectContaining({ name: pause, started_at, ended_at })]);
        expect(await store.pauseAt(started_at)).toEqual({ name: pause, started_at, ended_at });
        expect(await store.pauseAt(ended_at)).toBeNull();
      });

      it("the other claim pauses are not pause history", async () => {
        const { store, clock } = await make();
        for (const pause of ["rate_limit", "forge_auth", "preflight_access", "github_rate_limit"] as const) {
          await store.pauseClaims(later(clock, 60_000), pause);
          expect(await store.pauseAt(clock.now().toISOString() as Timestamp)).toBeNull();
          await store.endClaimPause(pause);
        }
        expect(await historyRows(store)).toEqual([]);
      });
    });
  });
});
