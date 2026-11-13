// Spend budgets (design 06-spend): spend.daily_budget_usd and spend.weekly_budget_usd, decimal dollars, default none.
// Passing 80% and 100% of a budget alerts once each per period (a UTC day, or an ISO week from Monday UTC), also
// across repeated steps and a new controller on the same store; the alert key names the period and threshold.
// The alert reaches Needs you through the alert record, and never stops, pauses or holds a run, in auto mode too.

import { describe, expect, it } from "vitest";
import { type FactoryConfig } from "../src/core/config.js";
import { type ControllerDeps } from "../src/core/controller-deps.js";
import { LiveSettings, baseFromConfig, parseSettable, resolveSettings } from "../src/core/settings.js";
import type { RunOutcome, WorkerId } from "../src/core/types.js";
import type { FactoryStore } from "../src/interfaces/factory-store.js";
import { FakeClock } from "../src/impl/clock/fake-clock.js";
import { PatternEgressScanner } from "../src/impl/egress/pattern-egress-scanner.js";
import { ControllerRole } from "../src/runtime/roles/controller-role.js";
import { HealthMonitor } from "../src/ui/health.js";
import { type UiDeps, respond } from "../src/ui/server.js";
import { FakeAuth, cleanScanner, config, silent } from "./helpers/fakes.js";
import { issue, newStore, system } from "./helpers/store.js";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const DAILY = "spend.daily_budget_usd";
const WEEKLY = "spend.weekly_budget_usd";
const cost = (usd: number | null): RunOutcome => ({
  status: "succeeded", summary: "ok", data: { tokens: 10, usage: { input_tokens: 10, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0, cost_usd: usd, model: null } },
});

let n = 0;
async function spend(store: FactoryStore, usd: number | null): Promise<void> {
  const k = ++n;
  const { item } = await store.createWorkItem(issue(k), system);
  await store.enqueueRun({ work_item_id: item.id, kind: "implement", idempotency_key: `b${k}` });
  const r = (await store.claimRun({ worker_id: "w" as WorkerId, kinds: ["implement"], lease_ms: 60_000 }))!;
  await store.completeRun(r.id, r.lease!.token, cost(usd));
}

function controller(store: FactoryStore, clock: FakeClock, over: Partial<ControllerDeps> = {}): ControllerRole {
  const cfg: FactoryConfig = config;
  const settings = new LiveSettings({ config: cfg, base: baseFromConfig(cfg), source: store, log: silent });
  return new ControllerRole({ store, auth: new FakeAuth(), clock, config: cfg, log: silent, scanner: cleanScanner, settings, ...over });
}

const set = (store: FactoryStore, key: string, value: string) => store.setSettingOverride({ key, project: "", value, actor: "local:test" });
const spendAlerts = async (store: FactoryStore) =>
  (await store.listAlerts({ limit: 100 })).filter((a) => a.pattern === "spend_budget").map((a) => a.pattern_key).sort();

describe("spend budget settings", () => {
  it("take decimal dollars such as 12.50, or null for none, and default to none", () => {
    expect(parseSettable(DAILY, 12.5)).toBe(12.5);
    expect(parseSettable(WEEKLY, null)).toBeNull();
    for (const bad of [0, -1, "12.50", true]) expect(() => parseSettable(DAILY, bad), String(bad)).toThrow(/positive dollar amount/);
    const r = resolveSettings({ file: {}, layers: { defaults: {}, projects: {} } }, [{ key: DAILY, project: "", value: "12.50" }]);
    expect(r.values[DAILY]).toBe(12.5);
    expect(r.values[WEEKLY]).toBeNull();
  });
});

describe("spend budget alerts", () => {
  it("no budget: no alert, however much is spent", async () => {
    const { store, clock } = await newStore();
    await spend(store, 1000);
    await controller(store, clock).tickAlarms();
    expect(await spendAlerts(store)).toEqual([]);
  });

  it("passing 80% and 100% of the daily budget alerts once each per UTC day, across steps and a new controller", async () => {
    const { store, clock } = await newStore(new FakeClock("2026-01-01T08:00:00.000Z"));
    await set(store, DAILY, "12.50");
    const c = controller(store, clock);
    await spend(store, 9.99);
    await c.tickAlarms();
    expect(await spendAlerts(store)).toEqual([]);
    await spend(store, 0.01); // $10.00: 80%
    await c.tickAlarms();
    await c.tickAlarms();
    expect(await spendAlerts(store)).toEqual(["spend:daily:2026-01-01:80"]);
    await spend(store, 2.5); // $12.50: 100%
    await c.tickAlarms();
    await controller(store, clock).tickAlarms(); // a new controller on the same store
    await c.tickAlarms();
    expect(await spendAlerts(store)).toEqual(["spend:daily:2026-01-01:100", "spend:daily:2026-01-01:80"]);
    const [alert] = (await store.listAlerts({ limit: 100 })).filter((a) => a.pattern_key.endsWith(":100"));
    expect(alert).toMatchObject({ error_code: "daily_100", detail: "$12.50 of the $12.50 daily budget spent (UTC day 2026-01-01)" });

    // The next UTC day is a new period: nothing until it passes 80% again.
    clock.advance(DAY);
    await controller(store, clock).tickAlarms();
    expect(await spendAlerts(store)).toHaveLength(2);
    await spend(store, 11);
    await c.tickAlarms();
    expect(await spendAlerts(store)).toContain("spend:daily:2026-01-02:80");
    expect(await spendAlerts(store)).not.toContain("spend:daily:2026-01-02:100");
  });

  it("the weekly budget's period is the ISO week from Monday 00:00 UTC", async () => {
    // Thursday 2026-01-01: its week began Monday 2025-12-29.
    const { store, clock } = await newStore(new FakeClock("2026-01-01T08:00:00.000Z"));
    await set(store, WEEKLY, "20");
    const c = controller(store, clock);
    await spend(store, 10);
    clock.advance(3 * DAY); // Sunday 2026-01-04, same week
    await spend(store, 6); // $16: 80%
    await c.tickAlarms();
    expect(await spendAlerts(store)).toEqual(["spend:weekly:2025-12-29:80"]);
    clock.advance(DAY); // Monday 2026-01-05: a new week, and last week's spend no longer counts
    await spend(store, 4);
    await c.tickAlarms();
    expect(await spendAlerts(store)).toEqual(["spend:weekly:2025-12-29:80"]);
    await spend(store, 12); // $16 this week
    await controller(store, clock).tickAlarms();
    await c.tickAlarms();
    expect(await spendAlerts(store)).toEqual(["spend:weekly:2025-12-29:80", "spend:weekly:2026-01-05:80"]);
  });

  it("runs with no stored cost add nothing toward a budget, and the alert names them", async () => {
    const { store, clock } = await newStore(new FakeClock("2026-01-01T08:00:00.000Z"));
    await set(store, DAILY, "1");
    for (let i = 0; i < 5; i++) await spend(store, null);
    await controller(store, clock).tickAlarms();
    expect(await spendAlerts(store)).toEqual([]);
    await spend(store, 0.8);
    await controller(store, clock).tickAlarms();
    const [a] = (await store.listAlerts({ limit: 10 })).filter((x) => x.pattern === "spend_budget");
    expect(a!.detail).toContain("5 runs with no stored cost not counted");
  });

  it("never stops auto mode, pauses claims or holds an item, and shows in Needs you", async () => {
    const { store, clock } = await newStore(new FakeClock("2026-01-01T08:00:00.000Z"));
    await set(store, "mode", '"auto"');
    await set(store, DAILY, "1");
    await spend(store, 5);
    const { item } = await store.createWorkItem(issue(9_999), system);
    await store.enqueueRun({ work_item_id: item.id, kind: "implement", idempotency_key: "next" });
    const c = controller(store, clock);
    await c.tickAlarms();
    await c.tickAlarms();
    expect(await spendAlerts(store)).toEqual(["spend:daily:2026-01-01:100", "spend:daily:2026-01-01:80"]);
    expect((await store.listSettingOverrides()).find((o) => o.key === "mode")?.value).toBe('"auto"');
    expect((await store.listAlerts({ limit: 10 })).filter((a) => a.pattern === "auto_stopped")).toEqual([]);
    expect(await store.getClaimPause()).toBeNull();
    expect((await store.getWorkItem(item.id))!.blocked_on).toBe("none");
    expect(await store.claimRun({ worker_id: "w" as WorkerId, kinds: ["implement"], lease_ms: 60_000 })).toMatchObject({ work_item_id: item.id });

    const d: UiDeps = { store, scanner: new PatternEgressScanner(async () => []), clock, lease_ms: 60_000, health: new HealthMonitor(async () => [], clock) };
    const o = JSON.parse((await respond(d, { method: "GET", url: "/api/v1/overview", host: "127.0.0.1:4310" })).body) as { system_actions: { code: string; text: string; command: string }[] };
    const alarms = o.system_actions.filter((a) => a.code === "alarm");
    expect(alarms.map((a) => a.text.split(":")[0] + ":" + a.text.split(":")[1])).toEqual(expect.arrayContaining([
      "Alarm: spending passed 100% of the daily budget",
      "Alarm: spending passed 80% of the daily budget",
    ]));
    expect(alarms.every((a) => a.command === "Spend page (/app/spend)")).toBe(true);
  });
});
