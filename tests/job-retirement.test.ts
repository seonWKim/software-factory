import { describe, expect, it } from "vitest";
import { ALERT_DEDUPE_MS } from "../src/core/alarms.js";
import {
  JOB_RETIRE_PREFIX, RETIRE_NOOP_RUNS, type JobRun, type ScheduledJob, type ScheduledJobs, decideRetirement, dueForRetirement, retirementStep,
} from "../src/core/job-retirement.js";
import type { Timestamp } from "../src/core/types.js";
import type { FactoryStore } from "../src/interfaces/factory-store.js";
import { FakeClock } from "../src/impl/clock/fake-clock.js";
import { ControllerRole } from "../src/runtime/roles/controller-role.js";
import { FakeAuth, cleanScanner, config, silent } from "./helpers/fakes.js";
import { newStore } from "./helpers/store.js";

// Design 05-alarms: a scheduled job whose target is gone and that did nothing RETIRE_NOOP_RUNS times in a row gets
// one retirement proposal, an alert the owner answers with /approve or /reject.

const HOUR = 3_600_000;

/** A job store in memory: the jobs as their owner reports them, and the ones disabled. */
class FakeJobs implements ScheduledJobs {
  readonly jobs = new Map<string, ScheduledJob>();
  constructor(private readonly clock: FakeClock) {}
  add(id: string, target_exists: boolean): void {
    this.jobs.set(id, { id, target: `project:${id}`, target_exists, disabled: false, runs: [] });
  }
  /** One finished run of `id` now, newest first. */
  run(id: string, noop: boolean): void {
    const j = this.jobs.get(id)!;
    const r: JobRun = { finished_at: this.clock.now().toISOString() as Timestamp, noop };
    this.jobs.set(id, { ...j, runs: [r, ...j.runs] });
  }
  async list(): Promise<readonly ScheduledJob[]> {
    return [...this.jobs.values()];
  }
  async disable(id: string): Promise<void> {
    const j = this.jobs.get(id);
    if (j) this.jobs.set(id, { ...j, disabled: true });
  }
}

async function setup() {
  const { store, clock } = await newStore();
  const jobs = new FakeJobs(clock);
  const deps = { store, scanner: cleanScanner, clock, log: silent, jobs };
  const proposals = async () => (await store.listAlerts({ limit: 50 })).filter((a) => a.pattern_key.startsWith(JOB_RETIRE_PREFIX));
  /** One run of `id` a day, then a retirement step. */
  const day = async (id: string, noop: boolean) => {
    clock.advance(24 * HOUR);
    jobs.run(id, noop);
    return retirementStep(deps);
  };
  return { store, clock, jobs, deps, proposals, day };
}

describe("job retirement: the check", () => {
  const job = (target_exists: boolean, noops: boolean[], at = "2026-01-01T00:00:00.000Z"): ScheduledJob => ({
    id: "j", target: "project:p", target_exists, disabled: false, runs: noops.map((noop) => ({ finished_at: at as Timestamp, noop })),
  });
  const now = new Date("2026-01-02T00:00:00.000Z");

  it("is due only when the target is gone and the newest RETIRE_NOOP_RUNS runs all did nothing", () => {
    const noops = Array.from({ length: RETIRE_NOOP_RUNS }, () => true);
    expect(dueForRetirement(job(false, noops), now)).toBe(true);
    expect(dueForRetirement(job(false, noops.slice(1)), now)).toBe(false);
    expect(dueForRetirement(job(false, [false, ...noops]), now)).toBe(false);
    expect(dueForRetirement(job(false, [...noops, false]), now)).toBe(true);
    expect(dueForRetirement(job(true, [...noops, ...noops, ...noops]), now)).toBe(false);
    expect(dueForRetirement({ ...job(false, noops), disabled: true }, now)).toBe(false);
  });

  it("counts only runs finished by the clock's now", () => {
    const noops = Array.from({ length: RETIRE_NOOP_RUNS }, () => true);
    expect(dueForRetirement(job(false, noops, "2026-01-03T00:00:00.000Z"), now)).toBe(false);
  });
});

describe("job retirement: the proposal", () => {
  it("a job whose target is gone and that no-ops 3 times in a row gets one proposal; the job is not disabled", async () => {
    const { jobs, deps, proposals, day } = await setup();
    jobs.add("improve-daily", false);
    await day("improve-daily", true);
    await day("improve-daily", true);
    expect(await proposals()).toEqual([]);
    const stored = await day("improve-daily", true);
    expect(stored.map((a) => a.pattern_key)).toEqual([`${JOB_RETIRE_PREFIX}improve-daily`]);
    const [p, ...rest] = await proposals();
    expect(rest).toEqual([]);
    expect(p).toMatchObject({ pattern_key: `${JOB_RETIRE_PREFIX}improve-daily`, count: RETIRE_NOOP_RUNS });
    expect(p!.detail).toContain("project:improve-daily");
    expect(jobs.jobs.get("improve-daily")!.disabled).toBe(false);

    // Two steps at once, and more no-ops days later: still the one proposal.
    await Promise.all([retirementStep(deps), retirementStep(deps)]);
    await day("improve-daily", true);
    expect(await proposals()).toHaveLength(1);
  });

  it("a run that did something breaks the streak", async () => {
    const { jobs, proposals, day } = await setup();
    jobs.add("j", false);
    await day("j", true);
    await day("j", true);
    await day("j", false);
    await day("j", true);
    await day("j", true);
    expect(await proposals()).toEqual([]);
    await day("j", true);
    expect(await proposals()).toHaveLength(1);
  });

  it("a job whose target still exists never gets a proposal, however many runs do nothing", async () => {
    const { jobs, proposals, day } = await setup();
    jobs.add("alive", true);
    for (let i = 0; i < 4 * RETIRE_NOOP_RUNS; i++) await day("alive", true);
    expect(await proposals()).toEqual([]);
  });
});

describe("job retirement: the owner's answer", () => {
  it("/approve disables the job", async () => {
    const { jobs, proposals, day, deps } = await setup();
    jobs.add("j", false);
    for (let i = 0; i < RETIRE_NOOP_RUNS; i++) await day("j", true);
    const [p] = await proposals();
    expect(await decideRetirement(deps, p!, "approve")).toBe(true);
    expect(jobs.jobs.get("j")!.disabled).toBe(true);
  });

  it("/reject keeps the job, and the same target is not proposed again", async () => {
    const { jobs, proposals, day, deps, clock } = await setup();
    jobs.add("j", false);
    for (let i = 0; i < RETIRE_NOOP_RUNS; i++) await day("j", true);
    const [p] = await proposals();
    expect(await decideRetirement(deps, p!, "reject")).toBe(true);
    expect(jobs.jobs.get("j")!.disabled).toBe(false);
    clock.advance(2 * ALERT_DEDUPE_MS);
    for (let i = 0; i < 2 * RETIRE_NOOP_RUNS; i++) await day("j", true);
    expect(await proposals()).toEqual([p]);
    expect(jobs.jobs.get("j")!.disabled).toBe(false);
  });

  it("an answer on an alert that is not a retirement proposal changes nothing", async () => {
    const { jobs, deps } = await setup();
    jobs.add("j", false);
    expect(await decideRetirement(deps, { pattern_key: "zero_tokens" }, "approve")).toBe(false);
    expect(jobs.jobs.get("j")!.disabled).toBe(false);
  });
});

describe("job retirement: guards", () => {
  it("reads the store only for its alert, and calls no model, forge or sandbox", async () => {
    const { store, clock } = await newStore();
    const jobs = new FakeJobs(clock);
    jobs.add("j", false);
    const used: string[] = [];
    const watched = new Proxy(store, {
      get: (t, p) => {
        const v = (t as unknown as Record<string | symbol, unknown>)[p];
        if (typeof v !== "function") return v;
        return (...args: unknown[]) => {
          used.push(String(p));
          return (v as (...a: unknown[]) => unknown).apply(t, args);
        };
      },
    }) as FactoryStore;
    const throwing = <T extends object>(name: string, own: Record<string, unknown> = {}): T =>
      new Proxy(own, {
        get: (t, p) => (p in t || p === "then" ? (t as Record<string | symbol, unknown>)[p] : () => { throw new Error(`${name}.${String(p)} called`); }),
      }) as T;
    const c = new ControllerRole({
      store: watched, auth: new FakeAuth(), clock, config, log: silent, scanner: cleanScanner, jobs,
      sources: [throwing("source", { type: "github_issue", intake: "poll" })], llm: throwing("llm"), sandbox: throwing("sandbox"),
    });
    for (let i = 0; i < RETIRE_NOOP_RUNS; i++) {
      clock.advance(24 * HOUR);
      jobs.run("j", true);
    }
    await c.tickJobRetirement();
    expect(new Set(used)).toEqual(new Set(["recordAlert"]));
    const [p] = (await store.listAlerts({ limit: 10 })).filter((a) => a.pattern_key.startsWith(JOB_RETIRE_PREFIX));
    expect(await c.decideJobRetirement(p!, "approve")).toBe(true);
    expect(jobs.jobs.get("j")!.disabled).toBe(true);
  });
});
