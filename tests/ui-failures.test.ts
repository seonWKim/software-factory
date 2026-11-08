// GET /api/v1/failures (issue #312): failed runs grouped by error code for a 24h or 7d window, with plain
// descriptions for known codes only, text through the Withholder, store reads only. And the overview's
// factory.workers, which reports the effective setting rather than the status file's value.

import { describe, expect, it } from "vitest";
import type { WorkItem, WorkerId } from "../src/core/types.js";
import { type SettingsBase } from "../src/core/settings.js";
import type { FactoryStore } from "../src/interfaces/factory-store.js";
import { FakeClock } from "../src/impl/clock/fake-clock.js";
import { PatternEgressScanner } from "../src/impl/egress/pattern-egress-scanner.js";
import { FAILURES_CAP } from "../src/ui/failures.js";
import { HealthMonitor } from "../src/ui/health.js";
import { type UiDeps, respond } from "../src/ui/server.js";
import { newCsrfToken } from "../src/ui/settings-api.js";
import { issue, newStore, system } from "./helpers/store.js";

const LEASE = 60_000;
const HOUR = 3_600_000;
const SECRET = `ghp_${"Ab3".repeat(12)}`;

async function setup() {
  const clock = new FakeClock();
  const { store } = await newStore(clock);
  const d: UiDeps = {
    store,
    scanner: new PatternEgressScanner(async () => []),
    clock,
    lease_ms: LEASE,
    health: new HealthMonitor(async () => [], clock),
  };
  return { d, store, clock };
}

async function get(d: UiDeps, path: string) {
  const r = await respond(d, { method: "GET", url: path, host: "127.0.0.1:4310" });
  return { status: r.status, body: JSON.parse(r.body) as Record<string, any> };
}

/** Enqueues, claims and fails one run of a fresh item (or of `item`). */
async function fail(store: FactoryStore, n: number, code: string, detail: string, worker = "host:1:0", item?: WorkItem): Promise<WorkItem> {
  const it = item ?? (await store.createWorkItem(issue(n), system)).item;
  const cur = (await store.getWorkItem(it.id))!;
  const t = await store.transition({ id: it.id, expected_version: cur.version, patch: {}, actor: system, reason: "x", enqueue: { kind: "implement", idempotency_key: `f${n}:${code}:${cur.version}` } });
  if (!t.ok) throw new Error(t.reason);
  const run = (await store.claimRun({ worker_id: worker as WorkerId, kinds: ["implement"], lease_ms: LEASE }))!;
  await store.completeRun(run.id, run.lease!.token, { status: "failed", error_code: code, detail, infra: false });
  return it;
}

describe("GET /api/v1/failures", () => {
  it("groups failed runs by code with count, last seen and distinct items, for each window", async () => {
    const { d, store, clock } = await setup();
    // Two old failures (3 days ago), then three in the last day: two tests_failed on one item, one git_failed.
    const a = await fail(store, 1, "tests_failed", "old a");
    await fail(store, 2, "git_failed", "old b");
    clock.advance(3 * 24 * HOUR);
    await fail(store, 3, "tests_failed", "first", "host:2:1", a);
    clock.advance(HOUR);
    await fail(store, 4, "tests_failed", "second", "host:2:1", a);
    clock.advance(HOUR);
    await fail(store, 5, "git_failed", "third");

    const day = (await get(d, "/api/v1/failures?window=24h")).body;
    expect(day.window).toBe("24h");
    expect(day.groups.map((g: any) => [g.code, g.count, g.items])).toEqual([["tests_failed", 2, 1], ["git_failed", 1, 1]]);
    expect(day.groups[0].last_seen).toBe(new Date(clock.now().getTime() - HOUR).toISOString());

    const week = (await get(d, "/api/v1/failures?window=7d")).body;
    expect(week.groups.map((g: any) => [g.code, g.count, g.items])).toEqual([["tests_failed", 3, 1], ["git_failed", 2, 2]]);
    // The default window is 24h.
    expect((await get(d, "/api/v1/failures")).body.window).toBe("24h");
  });

  it("lists a group's runs with item, attempt, detail, worker and time", async () => {
    const { d, store } = await setup();
    const it = await fail(store, 1, "tests_failed", "npm test failed", "host:9:3");
    const g = (await get(d, "/api/v1/failures")).body.groups[0];
    expect(g.runs).toHaveLength(1);
    expect(g.runs[0]).toMatchObject({ work_item_id: it.id, attempt: 1, detail: "npm test failed", worker: "host:9:3" });
    expect(typeof g.runs[0].finished_at).toBe("string");
  });

  it("describes known codes only; an unknown code has no description", async () => {
    const { d, store } = await setup();
    await fail(store, 1, "tests_failed", "x");
    await fail(store, 2, "made_up_code", "y");
    const groups = (await get(d, "/api/v1/failures")).body.groups as { code: string; description: string | null }[];
    expect(groups.find((g) => g.code === "tests_failed")!.description).toEqual(expect.any(String));
    expect(groups.find((g) => g.code === "made_up_code")!.description).toBeNull();
  });

  it("answers 400 for an unknown window", async () => {
    const { d } = await setup();
    for (const w of ["30d", "", "toString", "24H"]) expect((await get(d, `/api/v1/failures?window=${w}`)).status, w).toBe(400);
  });

  it("passes details and codes through the Withholder", async () => {
    const { d, store } = await setup();
    await fail(store, 1, "tests_failed", `token ${SECRET} rejected`);
    const body = JSON.stringify((await get(d, "/api/v1/failures")).body);
    expect(body).not.toContain(SECRET);
    expect(body).toMatch(/\[withheld: [^\]]+\]/);
  });

  it("states when it read only the newest failures of a window", async () => {
    const { d, store } = await setup();
    await fail(store, 1, "tests_failed", "x");
    const body = (await get(d, "/api/v1/failures")).body;
    expect(body).toMatchObject({ cap: FAILURES_CAP, total: 1, capped: false });
  });

  it("writes nothing", async () => {
    const { d, store } = await setup();
    await fail(store, 1, "tests_failed", "x");
    const before = (await store.listRunsFinishedWithin(7 * 24 * HOUR)).map((r) => r.updated_at);
    await get(d, "/api/v1/failures?window=7d");
    expect((await store.listRunsFinishedWithin(7 * 24 * HOUR)).map((r) => r.updated_at)).toEqual(before);
  });
});

describe("overview factory.workers", () => {
  const base: SettingsBase = { file: { workers: 5 }, layers: { defaults: {}, projects: {} }, max_workers: 10 };
  const status = { state: "running", rev: "a", target_rev: "a", child_pid: 1, since: "2026-11-07T00:00:00.000Z", workers: 5 } as never;

  async function overview(opts: { override?: string; withSettings?: boolean }) {
    const { d, store } = await setup();
    if (opts.override) await store.setSettingOverride({ key: "workers", project: "", value: opts.override, actor: "local:test" });
    const deps: UiDeps = {
      ...d,
      factoryStatus: async () => status,
      ...(opts.withSettings === false
        ? {}
        : { settings: { base, repo: { owner: "o", name: "r" }, actor: "local:test", resolveProject: async () => null, csrfToken: newCsrfToken() } }),
    };
    return ((await get(deps, "/api/v1/overview")).body.factory) as { workers: number; workers_source: string };
  }

  it("reports the override when the file sets 5, an override sets 10 and max_workers is 10", async () => {
    expect(await overview({ override: "10" })).toMatchObject({ workers: 10, workers_source: "override" });
  });

  it("reports the file value with source file when nothing overrides it", async () => {
    expect(await overview({})).toMatchObject({ workers: 5, workers_source: "file" });
  });

  it("caps an override at max_workers", async () => {
    expect(await overview({ override: "50" })).toMatchObject({ workers: 10, workers_source: "override" });
  });
});
