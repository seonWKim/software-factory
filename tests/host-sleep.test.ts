import { afterEach, describe, expect, it, vi } from "vitest";
import { ControllerRole } from "../src/runtime/roles/controller-role.js";
import { HOST_SLEEP_MS, Worker } from "../src/worker/index.js";
import type { RunId, WorkerId } from "../src/core/types.js";
import type { FactoryStore } from "../src/interfaces/factory-store.js";
import { NoKeepAwake } from "../src/impl/awake/no-keep-awake.js";
import { FakeClock } from "../src/impl/clock/fake-clock.js";
import { PatternEgressScanner } from "../src/impl/egress/pattern-egress-scanner.js";
import { issue, newStore, system, w1 } from "./helpers/store.js";
import { FakeAuth, FakeRunner, FakeSandbox, MemoryStorage } from "./helpers/fakes/runner.js";
import { FakeBroker } from "./helpers/fakes/broker.js";
import { FakeSource } from "./helpers/fakes/source.js";
import { config, prompts, recordingLog, silent, triageSpec, waitFor, cleanScanner } from "./helpers/fakes/config.js";

const { lease_ms, heartbeat_ms, tick_ms } = config;

describe("host sleep: worker", () => {
  it("renews at once after a clock jump past lease_ms and completes the run on its first attempt", async () => {
    const clock = new FakeClock();
    const { store } = await newStore(clock);
    const log = recordingLog();
    const { item } = await store.createWorkItem(issue(1), system, { enqueue: { kind: "triage", idempotency_key: "t" } });

    let jumpedNow = 0;
    const runner = new FakeRunner({
      triage: async (spec) => {
        // The host sleeps mid-run: on wake, the clock is far past the lease.
        clock.advance(lease_ms + 25_000);
        jumpedNow = clock.now().getTime();
        // No further clock movement: the heartbeat must land without waiting another heartbeat_ms.
        await waitFor(async () => {
          const run = await store.getRun(spec.run_id);
          return new Date(run!.lease!.expires_at).getTime() === jumpedNow + lease_ms;
        }, "lease renewal after the jump");
        return { output: triageSpec };
      },
    });
    const worker = new Worker({
      id: "w1" as WorkerId, store, sandbox: new FakeSandbox(), runner, broker: new FakeBroker(), storage: new MemoryStorage(),
      clock, config, prompts, log, scanner: new PatternEgressScanner(async () => []), toolEnv: {}, awake: new NoKeepAwake(),
    });

    expect(await worker.tick()).toBe(true);
    const [run] = await store.listRuns(item.id);
    expect(run).toMatchObject({ status: "succeeded", attempt: 1 });
    expect(run!.outcome).toMatchObject({ status: "succeeded", data: { spec: triageSpec } });
    expect(log.lines.some((l) => l.msg === "lease lost before completion; outcome dropped")).toBe(false);
    const late = log.lines.find((l) => l.msg === "heartbeat late; renewing now");
    expect(late?.fields).toMatchObject({ run_id: run!.id, gap_ms: lease_ms + 25_000 });
  });
});

describe("host sleep: controller reaper grace", () => {
  async function setup() {
    const clock = new FakeClock();
    const { store } = await newStore(clock);
    const controller = new ControllerRole({ store, source: new FakeSource(), auth: new FakeAuth(), clock, config, log: silent, scanner: cleanScanner });
    const { item } = await store.createWorkItem(issue(1), system, { enqueue: { kind: "triage", idempotency_key: "t" } });
    const run = (await store.claimRun({ worker_id: w1, kinds: ["triage"], lease_ms }))!;
    const status = async (id: RunId = run.id) => (await store.getRun(id))!.status;
    return { clock, store, controller, item, run, status };
  }

  it("expires nothing on the first tick after its own sleep, then expires an unrenewed lease after heartbeat_ms", async () => {
    const { clock, controller, status } = await setup();
    await controller.tickReaper();
    clock.advance(lease_ms + 1);
    await controller.tickReaper();
    expect(await status()).toBe("running");

    // Ticks keep being recorded during grace; a small step inside grace does not reset or end it.
    clock.advance(heartbeat_ms - 1);
    await controller.tickReaper();
    expect(await status()).toBe("running");

    clock.advance(1);
    await controller.tickReaper();
    expect(await status()).toBe("queued");
  });

  it("a renewal during grace keeps the run", async () => {
    const { clock, controller, store, run, status } = await setup();
    await controller.tickReaper();
    clock.advance(lease_ms + 1);
    await controller.tickReaper();
    expect((await store.heartbeat(run.id, run.lease!.token, lease_ms)).ok).toBe(true);
    clock.advance(heartbeat_ms);
    await controller.tickReaper();
    expect(await status()).toBe("running");
  });

  it("a tick that sees no gap is unaffected by the grace", async () => {
    const { clock, controller, status } = await setup();
    await controller.tickReaper();
    clock.advance(lease_ms / 2);
    await controller.tickReaper();
    clock.advance(lease_ms / 2 + 1);
    await controller.tickReaper();
    expect(await status()).toBe("queued");
  });

  it("the first tick of a process has no previous tick and gets no grace", async () => {
    const { clock, controller, status } = await setup();
    clock.advance(lease_ms + 1);
    await controller.tickReaper();
    expect(await status()).toBe("queued");
  });
});

/** A FakeClock that counts the waits it was asked for, so a test advances only once a loop is waiting. */
class CountingClock extends FakeClock {
  waits = 0;
  /** Set: every read moves time on by this many ms, as real time does, so two loops never wake at the same instant. */
  drift_ms = 0;
  override now(): Date {
    if (this.drift_ms > 0) this.advance(this.drift_ms);
    return super.now();
  }
  override sleep(ms: number, signal?: AbortSignal): Promise<void> {
    this.waits++;
    return super.sleep(ms, signal);
  }
}

/** The store, counting the calls to each method. */
function counted(store: FactoryStore): { store: FactoryStore; calls: Map<string, number> } {
  const calls = new Map<string, number>();
  const proxy = new Proxy(store, {
    get(target, key, receiver) {
      const v = Reflect.get(target, key, receiver) as unknown;
      if (typeof v !== "function" || typeof key !== "string") return v;
      return (...args: unknown[]) => {
        calls.set(key, (calls.get(key) ?? 0) + 1);
        return (v as (...a: unknown[]) => unknown).apply(target, args);
      };
    },
  });
  return { store: proxy, calls };
}

async function sleepWorld() {
  const clock = new CountingClock();
  const { store: inner } = await newStore(clock);
  const { store, calls } = counted(inner);
  const log = recordingLog();
  const worker = (runner: FakeRunner = new FakeRunner({})) =>
    new Worker({
      id: "w1" as WorkerId, store, sandbox: new FakeSandbox(), runner, broker: new FakeBroker(), storage: new MemoryStorage(),
      clock, config, prompts, log, scanner: cleanScanner, toolEnv: {}, awake: new NoKeepAwake(),
    });
  const sleeps = () => inner.listHostSleeps({ limit: 100 });
  return { clock, store: inner, calls, log, worker, sleeps };
}

describe("host sleep: recorded by the worker (issue #218)", () => {
  it("a clock jump during an idle tick records one host_slept row with the worker id, wake time and gap", async () => {
    const { clock, worker, sleeps } = await sleepWorld();
    const stop = new AbortController();
    const loop = worker().run(stop.signal);
    try {
      await waitFor(() => clock.waits >= 1, "the idle wait");
      clock.advance(tick_ms + 5 * 60_000);
      const woke = clock.now().toISOString();
      await waitFor(async () => (await sleeps()).length > 0, "the host sleep row");
      await waitFor(() => clock.waits >= 2, "the next idle wait");
      expect(await sleeps()).toEqual([{ worker_id: "w1", woke_at: woke, gap_ms: 5 * 60_000, run_id: null }]);
    } finally {
      stop.abort();
      await loop;
    }
  });

  it("a wait late by HOST_SLEEP_MS (60 000 ms) records nothing; late by 60 001 ms records one row", async () => {
    expect(HOST_SLEEP_MS).toBe(60_000);
    const { clock, worker, sleeps } = await sleepWorld();
    const stop = new AbortController();
    const loop = worker().run(stop.signal);
    try {
      await waitFor(() => clock.waits >= 1, "the idle wait");
      clock.advance(tick_ms + 60_000);
      await waitFor(() => clock.waits >= 2, "the next idle wait");
      expect(await sleeps()).toEqual([]);
      clock.advance(tick_ms + 60_001);
      await waitFor(() => clock.waits >= 3, "the third idle wait");
      expect((await sleeps()).map((h) => h.gap_ms)).toEqual([60_001]);
    } finally {
      stop.abort();
      await loop;
    }
  });

  it("a clock jump during a run records one row with run_id set to that run; the late-heartbeat warning is unchanged", async () => {
    const { clock, store, log, worker, sleeps } = await sleepWorld();
    const { item } = await store.createWorkItem(issue(1), system, { enqueue: { kind: "triage", idempotency_key: "t" } });
    const jump = 5 * 60_000;
    let woke = "";
    const runner = new FakeRunner({
      triage: async () => {
        clock.advance(jump);
        woke = clock.now().toISOString();
        await waitFor(async () => (await sleeps()).length > 0, "the host sleep row");
        return { output: triageSpec };
      },
    });
    expect(await worker(runner).tick()).toBe(true);
    const [run] = await store.listRuns(item.id);
    expect(run).toMatchObject({ status: "succeeded" });
    // The heartbeat asked for heartbeat_ms and woke `jump` after it started: late by jump - heartbeat_ms.
    expect(await sleeps()).toEqual([{ worker_id: "w1", woke_at: woke, gap_ms: jump - heartbeat_ms, run_id: run!.id }]);
    expect(log.lines.find((l) => l.msg === "heartbeat late; renewing now")?.fields).toEqual({ run_id: run!.id, gap_ms: jump, lease_ms });
  });

  it("one clock jump seen by the heartbeat and the pause watch of one run records one row", async () => {
    const { clock, store, calls, worker, sleeps } = await sleepWorld();
    const { item } = await store.createWorkItem(issue(1), system, { enqueue: { kind: "implement", idempotency_key: "i" } });
    const runner = new FakeRunner({
      implement: async (spec) => {
        const pauseReads = calls.get("workerPause") ?? 0;
        // The heartbeat renews through the engine, which moves the lease; the pause watch reads the store.
        const leased = async () => (await store.getRun(spec.run_id))!.lease!.expires_at;
        const before = await leased();
        clock.advance(5 * 60_000);
        clock.drift_ms = 1;
        // Both loops woke from the one jump and went on to their store call.
        await waitFor(async () => (calls.get("workerPause") ?? 0) > pauseReads && (await leased()) !== before, "both loops");
        await waitFor(async () => (await sleeps()).length > 0, "the host sleep row");
        for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
        clock.drift_ms = 0;
        return { output: { summary: "s", next_steps: "n" } };
      },
    });
    await worker(runner).tick();
    const [run] = await store.listRuns(item.id);
    const rows = await sleeps();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ worker_id: "w1", run_id: run!.id });
  });

  it("a failed sleep write is logged and the run goes on", async () => {
    const { clock, store, log, sleeps } = await sleepWorld();
    const failing = new Proxy(store, {
      get(target, key, receiver) {
        if (key === "recordHostSleep") return async () => { throw new Error("store down"); };
        const v = Reflect.get(target, key, receiver) as unknown;
        return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(target) : v;
      },
    });
    const { item } = await store.createWorkItem(issue(1), system, { enqueue: { kind: "triage", idempotency_key: "t" } });
    const runner = new FakeRunner({
      triage: async () => {
        clock.advance(5 * 60_000);
        await waitFor(() => log.lines.some((l) => l.msg === "host sleep record failed"), "the failure line");
        return { output: triageSpec };
      },
    });
    const w = new Worker({
      id: "w1" as WorkerId, store: failing, sandbox: new FakeSandbox(), runner, broker: new FakeBroker(), storage: new MemoryStorage(),
      clock, config, prompts, log, scanner: cleanScanner, toolEnv: {}, awake: new NoKeepAwake(),
    });
    expect(await w.tick()).toBe(true);
    expect((await store.listRuns(item.id))[0]).toMatchObject({ status: "succeeded" });
    expect(await sleeps()).toEqual([]);
  });
});

// The app's pages (web/), rendered on the server from a filled query cache. The modules are loaded by a path held
// in a variable: tsconfig.test.json has no JSX or DOM, and web/tsconfig.json typechecks them.
const WEB_PAGES = "../web/src/views/pages.js";
const WEB_API = "../web/src/api.js";

async function renderPage(page: "HealthPage" | "ItemPage", data: Record<string, unknown>, props: Record<string, unknown> = {}): Promise<string> {
  const { createElement } = await import("react");
  const { renderToStaticMarkup } = await import("react-dom/server");
  const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
  const pages = (await import(WEB_PAGES)) as Record<string, (p: Record<string, unknown>) => unknown>;
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  for (const [url, body] of Object.entries(data)) client.setQueryData([url], body);
  const el = createElement(QueryClientProvider, { client }, createElement(pages[page] as never, props as never));
  return renderToStaticMarkup(el).replace(/<!-- -->/g, "");
}

describe("host sleep: the app's pages", () => {
  const AT = "2026-11-07T08:30:00.000Z";
  const health = (sleeps: unknown[]) => ({ checked_at: AT, checks: [{ status: "ok", msg: "fine" }], sleeps });

  // The page reads its tab from the URL; on the server there is no window, so a test names the tab with a stub.
  const onTab = (tab: string) => vi.stubGlobal("location", { search: `?tab=${tab}`, href: `http://x/app/health?tab=${tab}` });
  afterEach(() => vi.unstubAllGlobals());

  /** The viewer's local clock time, as the page writes it ("6:18 PM"). */
  const clock = (at: string) => new Intl.DateTimeFormat("en", { hour: "numeric", minute: "2-digit" }).format(new Date(at));
  /** The page without its Details disclosures (data-raw), where the raw entries are. */
  const visible = (html: string) => html.replace(/<details data-raw[\s\S]*?<\/details>/g, "");

  it("Health lists the recent sleeps as one compact row each, 'Slept N min' then 'at <local time> · N workers paused', newest first", async () => {
    onTab("sleeps");
    const { API } = (await import(WEB_API)) as { API: { health: string; unreviewedMerges: string } };
    const html = await renderPage("HealthPage", {
      [API.health]: health([
        { worker_id: "host:1:0", woke_at: AT, gap_ms: 5 * 60_000, run_id: null },
        { worker_id: "host:1:1", woke_at: "2026-11-07T07:00:00.000Z", gap_ms: 61_000, run_id: "run_1" },
      ]),
      [API.unreviewedMerges]: { as_of: AT, merges: [] },
    });
    expect(html).toContain("Host sleeps");
    const rows = [...html.matchAll(/data-testid="host-sleep"[\s\S]*?<\/li>/g)].map((m) => m[0].replace(/<[^>]+>/g, "|").replace(/\|+/g, "|"));
    expect(rows[0]).toContain(`|Slept 5 min|at ${clock(AT)} · 1 worker paused|`);
    expect(rows[1]).toContain(`|Slept 1 min|at ${clock("2026-11-07T07:00:00.000Z")} · 1 worker paused|`);
    expect(rows).toHaveLength(2);
    expect(html).not.toContain("No host sleep recorded.");
    // The ISO wake time and the worker id are behind Details only.
    expect(visible(html)).not.toMatch(/>[^<]*\d{4}-\d{2}-\d{2}T\d{2}:\d{2}[^<]*</);
    expect(visible(html)).not.toContain("host:1:0");
    expect(html).toContain("host:1:0");
  });

  it("Health shows one sleep as one row whatever its ms: the minute of woke_at, the largest gap, the distinct workers", async () => {
    onTab("sleeps");
    const { API } = (await import(WEB_API)) as { API: { health: string; unreviewedMerges: string } };
    const woke = "2026-11-07T18:18:41.120Z";
    const entries = [0, 1, 2, 3].map((slot) => ({ worker_id: `host:1:${slot}`, woke_at: `2026-11-07T18:18:41.${120 + slot * 3}Z`, gap_ms: (slot === 2 ? 15 : 14) * 60_000, run_id: null }));
    // A second entry from worker 0 in the same sleep counts that worker once.
    entries.push({ worker_id: "host:1:0", woke_at: "2026-11-07T18:18:42.004Z", gap_ms: 60_500, run_id: null });
    const html = await renderPage("HealthPage", { [API.health]: health(entries), [API.unreviewedMerges]: { as_of: AT, merges: [] } });
    expect(html.match(/data-testid="host-sleep"/g)).toHaveLength(1);
    expect(html.match(/Slept \d+ min/g)).toHaveLength(1);
    expect(html).toContain("Slept 15 min");
    expect(html).toContain(`at ${clock(woke)} · 4 workers paused`);
  });

  it("Health lists each run a sleep held once, by item title and short ID, behind one disclosure; the keep-awake hint shows once, above the rows", async () => {
    onTab("sleeps");
    const { API } = (await import(WEB_API)) as { API: { health: string; unreviewedMerges: string } };
    const run = { run_id: "run_1", work_item_id: "wi_799f5babc4bd49cea646f98cb5a12008", work_item_title: "Fix the login page", run_status: "queued" };
    const html = await renderPage("HealthPage", {
      [API.health]: health([
        { worker_id: "host:1:0", woke_at: AT, gap_ms: 5 * 60_000, ...run },
        { worker_id: "host:1:1", woke_at: AT, gap_ms: 5 * 60_000, ...run },
        { worker_id: "host:1:2", woke_at: "2026-11-07T07:00:00.000Z", gap_ms: 61_000, run_id: null, work_item_id: null, run_status: null },
      ]),
      [API.unreviewedMerges]: { as_of: AT, merges: [] },
    });
    const v = visible(html);
    expect(v.match(/data-testid="host-sleep"/g)).toHaveLength(2);
    expect(v.match(/data-testid="host-sleep-runs"/g)).toHaveLength(1);
    expect(v).toContain("1 run held");
    // The item by its title, linked, then its short ID and the run's status; no wi_ ID in the visible text.
    expect(v).toMatch(/href="\/app\/items\/wi_799f5babc4bd49cea646f98cb5a12008"[^>]*>Fix the login page<\/a><span[^>]*>799f5bab<\/span><span[^>]*>Queued<\/span>/);
    expect(v.replace(/<[^>]+>/g, " ")).not.toContain("wi_");
    // The hint once, before the first row, not inside one.
    expect(v.match(/Keep awake can stop/g)).toHaveLength(1);
    expect(v.indexOf("Keep awake can stop")).toBeLessThan(v.indexOf('data-testid="host-sleep"'));
    expect(v).toContain('href="/app/settings?tab=advanced"');
  });

  it("Health keeps a sleep row without a run list when its run lookup gave nothing", async () => {
    onTab("sleeps");
    const { API } = (await import(WEB_API)) as { API: { health: string; unreviewedMerges: string } };
    const html = await renderPage("HealthPage", {
      [API.health]: health([{ worker_id: "host:1:0", woke_at: AT, gap_ms: 5 * 60_000, run_id: "run_1", work_item_id: null, run_status: null }]),
      [API.unreviewedMerges]: { as_of: AT, merges: [] },
    });
    expect(html).toContain("Slept 5 min");
    expect(html).not.toContain("run held");
    expect(html).not.toContain("Keep awake can stop");
  });

  it("Health shows an empty state when there are no sleeps", async () => {
    onTab("sleeps");
    const { API } = (await import(WEB_API)) as { API: { health: string; unreviewedMerges: string } };
    const html = await renderPage("HealthPage", { [API.health]: health([]), [API.unreviewedMerges]: { as_of: AT, merges: [] } });
    expect(html).toContain("No host sleep recorded.");
    expect(html).not.toContain("Slept ");
  });

  it("the item timeline shows 'host slept N min' for each sleep of the item's runs, in time order with the changes", async () => {
    const { API } = (await import(WEB_API)) as { API: { item: (id: string) => string } };
    const item = {
      id: "wi_1", source: { type: "github_issue", id: "o/r#1", link: "https://github.com/o/r/issues/1" }, title: "Item one", stage: "RUNNING",
      close_reason: null, blocked_on: "none", blocked_reason: null, tier: 2, loop_count: 0, restart_count: 0, token_cost: 0, change_ref: null,
      change_url: null, version: 2, created_at: "2026-11-07T06:00:00.000Z", updated_at: "2026-11-07T09:00:00.000Z",
    };
    const change = (version: number, at: string, reason: string) => ({ version, at, actor: { kind: "system", id: "system:x" }, reason, changes: {}, detail: null });
    const html = await renderPage("ItemPage", {
      [API.item("wi_1")]: {
        as_of: AT, item, runs: [],
        timeline: [change(1, "2026-11-07T06:00:00.000Z", "intake"), change(2, "2026-11-07T09:00:00.000Z", "approved")],
        sleeps: [
          { worker_id: "host:1:0", woke_at: "2026-11-07T08:00:00.000Z", gap_ms: 12 * 60_000, run_id: "run_1" },
          { worker_id: "host:1:0", woke_at: "2026-11-07T07:00:00.000Z", gap_ms: 3 * 60_000, run_id: "run_1" },
        ],
      },
    }, { id: "wi_1" });
    const order = ["approved", "host slept 12 min", "host slept 3 min", "intake"].map((t) => html.indexOf(t));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });
});
