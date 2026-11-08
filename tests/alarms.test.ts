import { describe, expect, it } from "vitest";
import { ALERT_DEDUPE_MS, RESTART_WINDOW_MS, alarmStep, detectAlarms } from "../src/core/alarms.js";
import { ALARM_DEFAULTS, type FactoryConfig, STALL_DEFAULTS } from "../src/core/config.js";
import { type ControllerDeps } from "../src/core/controller-deps.js";
import { ControllerRole } from "../src/runtime/roles/controller-role.js";
import { LiveSettings, baseFromConfig } from "../src/core/settings.js";
import type { RunKind, RunOutcome, WorkerId } from "../src/core/types.js";
import type { EgressScanner } from "../src/interfaces/egress-scanner.js";
import type { FactoryStore } from "../src/interfaces/factory-store.js";
import type { ChildRestart } from "../src/interfaces/updater.js";
import { FakeClock } from "../src/impl/clock/fake-clock.js";
import { FakeAuth, cleanScanner, config, silent } from "./helpers/fakes.js";
import { issue, newStore, system } from "./helpers/store.js";

// Design 05-alarms: a look across items on each poll; one alert per pattern per 6 hours.

const MIN = 60_000;
const USAGE = { input_tokens: 100, output_tokens: 50, cache_read_tokens: 0, cache_write_tokens: 0, cost_usd: null, model: null };
const failedWith = (detail: string, usage = true): RunOutcome => ({ status: "failed", error_code: "checks_failed", detail, infra: false, ...(usage ? { usage: USAGE } : {}) });

let next = 1;
/** Finishes one run of `kind` on a new item with `outcome`. */
async function finish(store: FactoryStore, outcome: RunOutcome, kind: RunKind = "implement") {
  const n = next++;
  const { item } = await store.createWorkItem(issue(n), system);
  await store.enqueueRun({ work_item_id: item.id, kind, idempotency_key: `k${n}` });
  const run = (await store.claimRun({ worker_id: "w" as WorkerId, kinds: [kind], lease_ms: 60_000 }))!;
  await store.completeRun(run.id, run.lease!.token, outcome);
  return run;
}

function controller(store: FactoryStore, clock: FakeClock, over: Partial<ControllerDeps> = {}): ControllerRole {
  return new ControllerRole({ store, auth: new FakeAuth(), clock, config, log: silent, scanner: cleanScanner, ...over });
}

/** Restarts `gap_ms` apart ending now, with reasons r1, r2, … */
function restarts(clock: FakeClock, n: number, gap_ms = 5 * MIN): ChildRestart[] {
  const now = clock.now().getTime();
  return Array.from({ length: n }, (_, i) => ({ at: new Date(now - (n - 1 - i) * gap_ms).toISOString(), reason: `r${i + 1}` }));
}

describe("alarms: repeated error", () => {
  it("3 matching runs on 3 items within 60 minutes store one alert; a 4th inside 6 hours stores none", async () => {
    const { store, clock } = await newStore();
    const c = controller(store, clock);
    await finish(store, failedWith("npm test exited 1: 3 failing tests"));
    clock.advance(20 * MIN);
    await finish(store, failedWith("npm test exited 2: 15 failing tests"));
    await c.tickAlarms();
    expect(await store.listAlerts({ limit: 10 })).toEqual([]);
    clock.advance(20 * MIN);
    await finish(store, failedWith("npm test exited 1: 7 failing tests"));
    await c.tickAlarms();
    const [alert, ...rest] = await store.listAlerts({ limit: 10 });
    expect(rest).toEqual([]);
    expect(alert).toMatchObject({ pattern: "repeated_error", error_code: "checks_failed", count: 3, detail: "npm test exited #: # failing tests" });
    expect(alert!.pattern_key).not.toContain("npm");

    clock.advance(10 * MIN);
    await finish(store, failedWith("npm test exited 9: 1 failing tests"));
    await c.tickAlarms();
    expect((await store.listAlerts({ limit: 10 })).map((a) => a.id)).toEqual([alert!.id]);
  });

  it("runs on fewer distinct items, or spread past the window, store none", () => {
    const now = new Date("2026-01-01T02:00:00.000Z");
    const run = (id: string, item: string, at: string) =>
      ({ id, work_item_id: item, kind: "implement", status: "failed", finished_at: at, outcome: failedWith("x") }) as never;
    const s = ALARM_DEFAULTS;
    expect(detectAlarms({ runs: [run("a", "w1", "2026-01-01T01:10:00.000Z"), run("b", "w1", "2026-01-01T01:20:00.000Z"), run("c", "w2", "2026-01-01T01:30:00.000Z")], restarts: [], now, settings: s })).toEqual([]);
    expect(detectAlarms({ runs: [run("a", "w1", "2026-01-01T00:50:00.000Z"), run("b", "w2", "2026-01-01T01:20:00.000Z"), run("c", "w3", "2026-01-01T01:30:00.000Z")], restarts: [], now, settings: s })).toEqual([]);
  });

  it("the same pattern alerts again only after 6 hours", async () => {
    const { store, clock } = await newStore();
    const c = controller(store, clock);
    const burst = async () => {
      for (let i = 0; i < 3; i++) await finish(store, failedWith("boom"));
      await c.tickAlarms();
    };
    await burst();
    expect(await store.listAlerts({ limit: 10 })).toHaveLength(1);
    clock.advance(ALERT_DEDUPE_MS - MIN);
    await burst();
    expect(await store.listAlerts({ limit: 10 })).toHaveLength(1);
    clock.advance(MIN);
    await burst();
    const alerts = await store.listAlerts({ limit: 10 });
    expect(alerts).toHaveLength(2);
    expect(alerts[0]!.pattern_key).toBe(alerts[1]!.pattern_key);
  });

  it("two alarm steps at once on one store leave one alert row for the pattern", async () => {
    const { store, clock } = await newStore();
    for (let i = 0; i < 3; i++) await finish(store, failedWith("boom"));
    const deps = { store, scanner: cleanScanner, clock, log: silent };
    const settings = { ...ALARM_DEFAULTS, probe_interval_ms: STALL_DEFAULTS.probe_interval_ms };
    const [a, b] = await Promise.all([alarmStep(deps, settings), alarmStep(deps, settings)]);
    expect(a.length + b.length).toBe(1);
    expect(await store.listAlerts({ limit: 10 })).toHaveLength(1);
  });
});

describe("alarms: zero-token runs", () => {
  it("3 finished agent runs in a row with no tokens store one alert and start the model_stall pause", async () => {
    const { store, clock } = await newStore();
    const c = controller(store, clock);
    await finish(store, { status: "succeeded", summary: "ok", data: { tokens: 0 } }, "triage");
    await finish(store, { status: "failed", error_code: "a", detail: "one", infra: false });
    await c.tickAlarms();
    expect(await store.listAlerts({ limit: 10 })).toEqual([]);
    expect(await store.getClaimPause("model_stall")).toBeNull();
    await finish(store, { status: "failed", error_code: "b", detail: "two", infra: false }, "review");
    await c.tickAlarms();
    const alerts = await store.listAlerts({ limit: 10 });
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({ pattern: "zero_tokens", error_code: "zero_tokens", count: 3 });
    const probeAt = new Date(clock.now().getTime() + STALL_DEFAULTS.probe_interval_ms).toISOString();
    expect(await store.getClaimPause("model_stall")).toBe(probeAt);
  });

  it("a run with tokens breaks the streak; runs that are not agent runs do not count", async () => {
    const { store, clock } = await newStore();
    await finish(store, { status: "failed", error_code: "a", detail: "x", infra: false });
    await finish(store, { status: "failed", error_code: "a", detail: "y", infra: false });
    await finish(store, { status: "succeeded", summary: "ok", data: { tokens: 10 } });
    await finish(store, { status: "failed", error_code: "u", detail: "z", infra: false }, "update");
    await finish(store, { status: "failed", error_code: "a", detail: "w", infra: false });
    await controller(store, clock).tickAlarms();
    expect(await store.listAlerts({ limit: 10 })).toEqual([]);
  });
});

describe("alarms: child restarts", () => {
  it("5 restarts within 30 minutes store one alert with the last exit reason; 4 do not", async () => {
    const { store, clock } = await newStore();
    let list = restarts(clock, 4);
    const c = controller(store, clock, { restarts: async () => list });
    await c.tickAlarms();
    expect(await store.listAlerts({ limit: 10 })).toEqual([]);
    // Five, but the first is older than the window.
    list = restarts(clock, 5, RESTART_WINDOW_MS / 4 + MIN);
    await c.tickAlarms();
    expect(await store.listAlerts({ limit: 10 })).toEqual([]);
    list = restarts(clock, 5);
    await c.tickAlarms();
    const alerts = await store.listAlerts({ limit: 10 });
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({ pattern: "child_restarts", error_code: "child_restarts", count: 5, detail: "r5" });
  });
});

describe("alarms: guards", () => {
  it("makes no forge, LLM or sandbox call", async () => {
    const { store, clock } = await newStore();
    for (let i = 0; i < 3; i++) await finish(store, failedWith("boom", false));
    const calls: string[] = [];
    // Every method throws; `then` stays undefined so an await of the object itself never calls it.
    const throwing = <T extends object>(name: string, own: Record<string, unknown> = {}): T =>
      new Proxy(own, {
        get: (t, p) => (p in t || p === "then" ? (t as Record<string | symbol, unknown>)[p] : () => {
          calls.push(`${name}.${String(p)}`);
          throw new Error(`${name}.${String(p)} called`);
        }),
      }) as T;
    const c = controller(store, clock, {
      sources: [throwing("source", { type: "github_issue", intake: "poll" })],
      llm: throwing("llm"),
      sandbox: throwing("sandbox"),
      restarts: async () => restarts(clock, 5),
    });
    await c.tickAlarms();
    expect(calls).toEqual([]);
    expect((await store.listAlerts({ limit: 10 })).map((a) => a.pattern).sort()).toEqual(["child_restarts", "repeated_error", "zero_tokens"]);
  });

  it("a detail the egress scanner flags is dropped; the code and count stay, and nothing is stored unscanned", async () => {
    const { store, clock } = await newStore();
    for (let i = 0; i < 3; i++) await finish(store, failedWith("token ghp_SECRET leaked"));
    const scanned: string[] = [];
    const scanner: EgressScanner = {
      async scan(channel, content) {
        scanned.push(content);
        return content.includes("secret") ? { clean: false, findings: [{ rule: "test", channel }] } : { clean: true };
      },
    };
    await controller(store, clock, { scanner }).tickAlarms();
    const [alert] = await store.listAlerts({ limit: 10 });
    expect(alert).toMatchObject({ pattern: "repeated_error", error_code: "checks_failed", count: 3, detail: null });
    expect(scanned).toContain("token ghp_secret leaked");

    const failing: EgressScanner = { scan: async () => { throw new Error("scanner down"); } };
    const other = await newStore();
    for (let i = 0; i < 3; i++) await finish(other.store, failedWith("boom"));
    await expect(controller(other.store, other.clock, { scanner: failing }).tickAlarms()).rejects.toThrow("scanner down");
    expect(await other.store.listAlerts({ limit: 10 })).toEqual([]);
  });
});

describe("alarms: settings", () => {
  it("default to 3, 60 and 5; a live change applies at the next tick with no restart", async () => {
    expect(ALARM_DEFAULTS).toEqual({ alarm_repeat_count: 3, alarm_window_minutes: 60, alarm_restart_count: 5 });
    const { store, clock } = await newStore();
    const cfg: FactoryConfig = { ...config };
    const settings = new LiveSettings({ config: cfg, base: baseFromConfig(cfg), source: store, log: silent });
    const list = restarts(clock, 2);
    const c = controller(store, clock, { settings, restarts: async () => list });
    await finish(store, failedWith("boom"));
    await finish(store, failedWith("boom"));
    await c.tickAlarms();
    expect(settings.values()).toMatchObject(ALARM_DEFAULTS);
    expect(await store.listAlerts({ limit: 10 })).toEqual([]);

    for (const [key, value] of [["alarm_repeat_count", 2], ["alarm_restart_count", 2]] as const) {
      await store.setSettingOverride({ key, project: "", value: String(value), actor: "local:test" });
    }
    await c.tickAlarms();
    expect((await store.listAlerts({ limit: 10 })).map((a) => a.pattern).sort()).toEqual(["child_restarts", "repeated_error"]);

    // A shorter window leaves runs from 2 minutes ago out.
    const fresh = await newStore();
    const s2 = new LiveSettings({ config: cfg, base: baseFromConfig(cfg), source: fresh.store, log: silent });
    const c2 = controller(fresh.store, fresh.clock, { settings: s2 });
    for (let i = 0; i < 3; i++) await finish(fresh.store, failedWith("boom"));
    fresh.clock.advance(2 * MIN);
    await fresh.store.setSettingOverride({ key: "alarm_window_minutes", project: "", value: "1", actor: "local:test" });
    await c2.tickAlarms();
    expect(await fresh.store.listAlerts({ limit: 10 })).toEqual([]);
  });
});
