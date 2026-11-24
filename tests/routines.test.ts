import { describe, expect, it } from "vitest";
import {
  SNOOZE_MS, type Routine, type RoutineInput, addRoutine, afterSlot, carrierSource, dailyCap, dueSlot, fingerprint, firstDue, overDailyCap,
  overRunCap, queueRoutineRun, routineFindings, routineProblem,
} from "../src/core/routines.js";
import type { Timestamp, UserId } from "../src/core/types.js";
import { FakeClock } from "../src/impl/clock/fake-clock.js";
import type { SqlFactoryStore } from "../src/impl/store/sql/sql-factory-store.js";
import { LocalSource } from "../src/impl/source/local-source.js";
import type { EgressScanner } from "../src/interfaces/egress-scanner.js";
import { ControllerRole } from "../src/runtime/roles/controller-role.js";
import { tickAt } from "../src/shared/ticks/tick-generator.js";
import { scheduledAction } from "../src/core/controller-deps.js";
import { FakeAuth } from "./helpers/fakes/runner.js";
import { config, silent } from "./helpers/fakes/config.js";
import { newStore, w1 } from "./helpers/store.js";

// Routines (src/core/routines.ts). The schedule and trigger math runs on times read from a FakeClock;
// the schedule unit's pass, driven by the controller, fires a due routine's run; the routines unit stores its findings as pending
// suggestions (duplicates skipped and counted, flagged ones withheld) and answers a suggestion.

const OWNER = "local:owner" as UserId;
const MADE = "2026-11-23T00:00:00.000Z";
const input = (over: Partial<RoutineInput> = {}): RoutineInput => ({
  id: "rt_1", name: "License", instruction: "Check that the README names the license.", url: null, schedule: { kind: "daily", spec: "09:00" }, zone: "UTC",
  trigger: null, run_cap_usd: null, daily_cap_usd: null, created_by: OWNER, ...over,
});
const made = (over: Partial<RoutineInput> = {}, at = new Date(MADE)): Routine => ({
  ...input(over), created_at: at.toISOString() as Timestamp, next_due_at: firstDue(input(over), at), cap_raise: null, paused: false, last_run_at: null,
});

describe("a routine's form", () => {
  it("is a schedule or a trigger: both or neither is refused, and nothing is stored", async () => {
    const stored: unknown[] = [];
    const store = { addRoutine: async (r: never) => (stored.push(r), r) };
    const now = new FakeClock(MADE).now();
    expect(await addRoutine(store, input({ trigger: "merge" }), now)).toEqual({ ok: false, problem: "a routine runs on a schedule or on a trigger, not both" });
    expect(await addRoutine(store, input({ schedule: null }), now)).toEqual({ ok: false, problem: "a routine needs a schedule or a trigger" });
    expect(stored).toEqual([]);
    expect(routineProblem(input({ schedule: null, trigger: "deploy" as never }))).toContain('"deploy" is not a trigger');
    expect(routineProblem(input({ schedule: { kind: "daily", spec: "25:00" } }))).not.toBeNull();
    expect(routineProblem(input({ url: "ftp://x" }))).toBe("a routine's page is an http or https URL");
    expect(routineProblem(input({ daily_cap_usd: 0 }))).toBe("a cap is a positive dollar amount, or none");
    expect(routineProblem(input({ schedule: null, trigger: "merge", url: "https://status.example.com/" }))).toBeNull();
  });
});

describe("schedule and trigger math, from the injected Clock", () => {
  /** The slots a routine made at MADE fires, ticking the FakeClock a minute at a time up to `until`. */
  function slots(over: Partial<RoutineInput>, until: string): string[] {
    const clock = new FakeClock(MADE);
    let r = made(over, clock.now());
    const fired: string[] = [];
    while (clock.now().getTime() < Date.parse(until)) {
      clock.advance(60_000);
      const slot = dueSlot(r, clock.now(), null);
      if (slot === null) continue;
      fired.push(slot);
      r = { ...r, ...afterSlot(r, clock.now()) };
    }
    return fired;
  }

  it("interval: every N minutes from the routine's creation", () => {
    expect(slots({ schedule: { kind: "interval", spec: "90" } }, "2026-11-23T05:00:00.000Z")).toEqual(["2026-11-23T01:30:00.000Z", "2026-11-23T03:00:00.000Z", "2026-11-23T04:30:00.000Z"]);
  });

  it("daily: HH:MM in the routine's zone", () => {
    expect(slots({ schedule: { kind: "daily", spec: "09:00" }, zone: "Asia/Seoul" }, "2026-11-25T00:30:00.000Z")).toEqual(["2026-11-24T00:00:00.000Z", "2026-11-25T00:00:00.000Z"]);
  });

  it("weekly: days and a time", () => {
    // 2026-11-23 is a Monday, made at 00:00: that Monday, Friday the 27th and Monday the 30th.
    expect(slots({ schedule: { kind: "weekly", spec: "mon,fri 09:00" } }, "2026-12-01T00:00:00.000Z")).toEqual(["2026-11-23T09:00:00.000Z", "2026-11-27T09:00:00.000Z", "2026-11-30T09:00:00.000Z"]);
  });

  it("cron: five fields", () => {
    expect(slots({ schedule: { kind: "cron", spec: "*/20 0 * * *" } }, "2026-11-23T01:00:00.000Z")).toEqual(["2026-11-23T00:20:00.000Z", "2026-11-23T00:40:00.000Z"]);
  });

  it("merge trigger: due on a merge after its last run (or its creation), once", () => {
    const clock = new FakeClock(MADE);
    let r = made({ schedule: null, trigger: "merge" }, clock.now());
    expect(r.next_due_at).toBeNull();
    clock.advance(3_600_000);
    expect(dueSlot(r, clock.now(), null)).toBeNull();
    expect(dueSlot(r, clock.now(), "2026-11-22T23:00:00.000Z" as Timestamp)).toBeNull(); // merged before the routine was made
    const merged = "2026-11-23T00:30:00.000Z" as Timestamp;
    expect(dueSlot(r, clock.now(), merged)).toBe(merged);
    r = { ...r, ...afterSlot(r, clock.now()) };
    expect(r).toMatchObject({ next_due_at: null, last_run_at: clock.now().toISOString() });
    expect(dueSlot(r, clock.now(), merged)).toBeNull();
    clock.advance(60_000);
    expect(dueSlot(r, clock.now(), clock.now().toISOString() as Timestamp)).toBe(clock.now().toISOString());
  });

  it("a paused-by-cap check and the daily cap with what /approve added that day", () => {
    const r = { ...made({ daily_cap_usd: 1, run_cap_usd: 0.5 }), cap_raise: { usd: 0.3, day: "2026-11-23", hold_key: "h" } };
    expect(dailyCap(r, "2026-11-23")).toBeCloseTo(1.3);
    expect(dailyCap(r, "2026-11-24")).toBe(1);
    expect(dailyCap({ daily_cap_usd: null, cap_raise: null }, "2026-11-23")).toBeNull();
    expect(overDailyCap(1, 0.6, 0.5)).toBe(true);
    expect(overDailyCap(1, 0.5, 0.5)).toBe(false);
    expect(overDailyCap(null, 99, 99)).toBe(false);
    expect([overRunCap(r, 0.6), overRunCap(r, 0.5), overRunCap(r, null)]).toEqual([true, false, false]);
  });

  it("reads findings from a routine answer, and fingerprints a repeat with other case, spaces or end punctuation alike", () => {
    expect(routineFindings({ verdict: "bug", findings: [{ text: " README.md:1 has no license " }, { text: "" }, {}], summary: "s" })).toEqual(["README.md:1 has no license"]);
    expect(routineFindings({ verdict: "pass", findings: [{ text: "x" }] })).toEqual([]);
    expect(routineFindings(null)).toEqual([]);
    expect(fingerprint("README.md:1 has no  license.")).toBe(fingerprint("readme.md:1 has no license"));
    expect(fingerprint("README.md:1 has no license")).not.toBe(fingerprint("README.md:2 has no license"));
  });
});

/** Flags any text with "SECRET" in it, as the egress scanner flags a credential. */
const scanner: EgressScanner = { scan: async (channel, content) => (content.includes("SECRET") ? { clean: false, findings: [{ rule: "test", channel }] } : { clean: true }) };

async function harness(over: Partial<RoutineInput> = {}) {
  const clock = new FakeClock("2026-11-23T08:59:00.000Z");
  const { store } = await newStore(clock);
  const s = store as SqlFactoryStore;
  const controller = new ControllerRole({ store, sources: [new LocalSource(store)], auth: new FakeAuth(), clock, config, log: silent, scanner , schedule_action: scheduledAction(store, { run: async (s, at) => void (await queueRoutineRun(store, config.project.key, s.id, at)) }, silent, config.project.key) });
  const added = await addRoutine(store, input(over), clock.now());
  if (!added.ok) throw new Error(added.problem);
  /** One schedule step at the FakeClock's time. */
  const tick = async () => {
    await (await controller.unit("schedule")).scheduleStep(tickAt("tick", 1, clock.now().getTime()));
  };
  const carrier = async () => (await store.getWorkItemBySource("local", carrierSource("rt_1").id))!;
  const routineRuns = async () => (await store.listRuns((await carrier()).id)).filter((r) => r.kind === "routine");
  /** The queued routine run, claimed and finished with `findings` at `cost_usd`; then the controller applies it. */
  const finish = async (findings: string[], cost_usd: number | null = 0.1) => {
    const run = (await store.claimRun({ worker_id: w1, kinds: ["routine"], lease_ms: 60_000 }))!;
    const usage = { input_tokens: 10, output_tokens: 5, cache_read_tokens: 0, cache_write_tokens: 0, cost_usd, model: null };
    const routine = { verdict: findings.length > 0 ? "bug" : "pass", findings: findings.map((text) => ({ text })), summary: "s" };
    await store.completeRun(run.id, run.lease!.token, { status: "succeeded", summary: "s", data: { routine, usage } });
    await controller.tickRuns();
    return run;
  };
  return { clock, store: s, controller, tick, carrier, routineRuns, finish };
}

describe("the schedule step on a routine and its suggestions", () => {
  it("fires a due routine once per slot on its carrier, with the instruction and page, and moves its marks", async () => {
    const h = await harness({ url: "https://status.example.com/" });
    await h.tick();
    expect(await h.store.getWorkItemBySource("local", carrierSource("rt_1").id)).toBeNull();
    h.clock.advance(60_000);
    await h.tick();
    await h.tick();
    const runs = await h.routineRuns();
    expect(runs.map((r) => [r.idempotency_key, r.status, r.input])).toEqual([
      ["routine:rt_1:2026-11-23T09:00:00.000Z", "queued", { routine: { instruction: input().instruction, url: "https://status.example.com/" } }],
    ]);
    expect(await h.carrier()).toMatchObject({ blocked_on: "upstream", blocked_reason: "system_item" });
    expect(await h.store.getRoutine("rt_1")).toMatchObject({ next_due_at: "2026-11-24T09:00:00.000Z", last_run_at: "2026-11-23T09:00:00.000Z" });
  });

  it("stores findings as pending suggestions, skips and counts duplicates, and withholds a flagged finding", async () => {
    const h = await harness();
    h.clock.advance(60_000);
    await h.tick();
    const first = await h.finish(["README.md:1 has no license", "CONTRIBUTING.md is missing"]);
    expect((await h.store.listRoutineSuggestions("rt_1")).map((s) => [s.text, s.state, s.duplicates, s.run_id])).toEqual([
      ["README.md:1 has no license", "pending", 0, first.id],
      ["CONTRIBUTING.md is missing", "pending", 0, first.id],
    ]);
    expect((await h.store.listRuns((await h.carrier()).id)).find((r) => r.id === first.id)!.acknowledged_at).not.toBeNull();
    h.clock.advance(24 * 3_600_000);
    await h.tick();
    await h.finish(["readme.md:1 has no  license.", "The page leaks SECRET=abc", "CHANGELOG.md is stale"]);
    expect((await h.store.listRoutineSuggestions("rt_1")).map((s) => [s.text, s.duplicates])).toEqual([
      ["README.md:1 has no license", 1],
      ["CONTRIBUTING.md is missing", 0],
      ["CHANGELOG.md is stale", 0],
    ]);
    // Applying the same run again adds and counts nothing.
    const u = await h.controller.unit("routines");
    await u.recordFindings((await h.routineRuns()).at(-1)!);
    expect((await h.store.listRoutineSuggestions("rt_1")).map((s) => s.duplicates)).toEqual([1, 0, 0]);
  });

  it("a snoozed suggestion is pending again after 14 days; dismiss and accept apply once, and accept files it", async () => {
    const h = await harness();
    h.clock.advance(60_000);
    await h.tick();
    await h.finish(["one", "two", "three"]);
    const [one, two, three] = await h.store.listRoutineSuggestions("rt_1");
    const u = await h.controller.unit("routines");
    expect(await u.answerSuggestion(one!.id, "snooze", OWNER)).toBeNull();
    expect(await h.store.getRoutineSuggestion(one!.id)).toMatchObject({ state: "snoozed" });
    expect(await u.answerSuggestion(one!.id, "accept", OWNER)).toBe("the suggestion is not pending");
    h.clock.advance(SNOOZE_MS - 1);
    expect(await h.store.getRoutineSuggestion(one!.id)).toMatchObject({ state: "snoozed" });
    h.clock.advance(1);
    expect(await h.store.getRoutineSuggestion(one!.id)).toMatchObject({ state: "pending" });
    expect(await u.answerSuggestion(two!.id, "dismiss", OWNER)).toBeNull();
    expect(await u.answerSuggestion(two!.id, "dismiss", OWNER)).toBe("the suggestion is not pending");
    expect(await u.answerSuggestion(three!.id, "accept", OWNER)).toBeNull();
    const accepted = (await h.store.getRoutineSuggestion(three!.id))!;
    expect(accepted).toMatchObject({ state: "accepted", decided_by: OWNER });
    const filed = (await h.store.getWorkItemBySource("local", accepted.filed_ref!))!;
    expect(filed).toMatchObject({ title: 'Routine "License": three', requester_id: OWNER });
    expect(filed.problem).toContain(`<!-- factory:routine-suggestion:${three!.id} -->`);
    expect((await h.store.listRuns(filed.id)).map((r) => r.kind)).toEqual(["triage"]);
  });

  it("a run over the per-run cap pauses its routine, and a paused routine fires no more", async () => {
    const h = await harness({ run_cap_usd: 0.5 });
    h.clock.advance(60_000);
    await h.tick();
    await h.finish([], 0.75);
    expect(await h.store.getRoutine("rt_1")).toMatchObject({ paused: true });
    h.clock.advance(24 * 3_600_000);
    await h.tick();
    expect((await h.routineRuns()).length).toBe(1);
  });

  it("a routine run while one is still going waits; the next slot fires once it has finished", async () => {
    const h = await harness({ schedule: { kind: "interval", spec: "1" } });
    h.clock.advance(60_000);
    await h.tick();
    h.clock.advance(60_000);
    await h.tick();
    expect((await h.routineRuns()).filter((r) => r.status === "queued").length).toBe(1);
    await h.finish([]);
    await h.tick();
    expect((await h.routineRuns()).map((r) => r.status)).toEqual(["succeeded", "queued"]);
  });
});
