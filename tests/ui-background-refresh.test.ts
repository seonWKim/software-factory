// The Health and Plugins reads answer from a stored result (design 09-health and 09-dashboard-settings, 2026-11-19,
// wi_926cad13): pending before the first refresh ends, the stored result and its as-of time after, a background
// refresh only when a read finds it older than its interval or a write marked it stale, one at a time, no timer, and
// the last good result kept on a failure.

import { describe, expect, it } from "vitest";
import { FakeClock } from "../src/impl/clock/fake-clock.js";
import { PatternEgressScanner } from "../src/impl/egress/pattern-egress-scanner.js";
import { type Check } from "../src/setup.js";
import { BackgroundSnapshot } from "../src/ui/background-refresh.js";
import { HEALTH_MIN_INTERVAL_MS, HealthMonitor } from "../src/ui/health.js";
import { readPlugins, servePluginsStored } from "../src/ui/plugins-api.js";
import { type ApiDeps, startUi } from "../src/ui/server.js";
import { type UiSettings, newCsrfToken, storeProjectResolver } from "../src/ui/settings-api.js";
import { newStore } from "./helpers/store.js";

const scanner = new PatternEgressScanner(async () => []);
const flush = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};
/** Lets store reads (real I/O) finish too. */
const settle = () => new Promise((r) => setTimeout(r, 30));

/** A run held until the test calls `release()`, counting its runs; `fail` makes the next runs throw. */
function held<T>(value: (n: number) => T) {
  const waiting: (() => void)[] = [];
  const state = { runs: 0, fail: false, hold: true };
  const run = async (): Promise<T> => {
    const n = ++state.runs;
    if (state.hold) await new Promise<void>((r) => waiting.push(r));
    if (state.fail) throw new Error("boom");
    return value(n);
  };
  return { state, run, release: () => waiting.splice(0).forEach((r) => r()) };
}

describe("BackgroundSnapshot", () => {
  it("answers pending before the first refresh ends, then the stored result with the time it finished", async () => {
    const clock = new FakeClock("2026-11-19T10:00:00.000Z");
    const g = held((n) => n);
    const snap = new BackgroundSnapshot(g.run, clock, 60_000);
    expect(snap.read()).toEqual({ state: "pending" });
    expect(g.state.runs).toBe(1);
    clock.advance(5_000);
    g.release();
    await flush();
    clock.advance(1_000);
    expect(snap.read()).toEqual({ state: "ready", value: 1, as_of: new Date("2026-11-19T10:00:05.000Z"), refreshing: false });
  });

  it("refreshes only when a read finds the result older than its interval; the read does not wait for it", async () => {
    const clock = new FakeClock();
    const g = held((n) => n);
    g.state.hold = false;
    const snap = new BackgroundSnapshot(g.run, clock, 60_000);
    snap.read();
    await flush();
    clock.advance(59_999);
    expect(snap.read()).toMatchObject({ value: 1 });
    await flush();
    expect(g.state.runs).toBe(1);
    g.state.hold = true;
    clock.advance(1);
    expect(snap.read()).toMatchObject({ state: "ready", value: 1, refreshing: true }); // the stored result, a refresh starts
    expect(g.state.runs).toBe(2);
    g.release();
    await flush();
    expect(snap.read()).toMatchObject({ value: 2, refreshing: false });
  });

  it("runs one refresh at a time, whatever reads and writes arrive meanwhile", async () => {
    const clock = new FakeClock();
    const g = held((n) => n);
    const snap = new BackgroundSnapshot(g.run, clock, 60_000);
    snap.read();
    clock.advance(10 * 60_000);
    snap.read();
    snap.markStale();
    snap.refreshInBackground();
    snap.read();
    expect(g.state.runs).toBe(1);
    g.release();
    await flush();
    // The write during the run marked the result stale: the next read runs once more.
    expect(snap.read()).toMatchObject({ value: 1, refreshing: true });
    expect(g.state.runs).toBe(2);
  });

  it("markStale makes the next read refresh within the interval", async () => {
    const clock = new FakeClock();
    const g = held((n) => n);
    g.state.hold = false;
    const snap = new BackgroundSnapshot(g.run, clock, 60_000);
    snap.read();
    await flush();
    snap.markStale();
    expect(snap.read()).toMatchObject({ value: 1 });
    await flush();
    expect(snap.read()).toMatchObject({ value: 2 });
    expect(g.state.runs).toBe(2);
  });

  it("has no timer: with no reads and no writes nothing runs", async () => {
    const clock = new FakeClock();
    const g = held((n) => n);
    g.state.hold = false;
    const snap = new BackgroundSnapshot(g.run, clock, 60_000);
    snap.read();
    await flush();
    for (let i = 0; i < 20; i++) {
      clock.advance(60_000);
      await flush();
    }
    expect(g.state.runs).toBe(1);
  });

  it("a failed refresh keeps the last good result and its time; with none, reads answer failed until the next is due", async () => {
    const clock = new FakeClock();
    const g = held((n) => n);
    g.state.hold = false;
    g.state.fail = true;
    const snap = new BackgroundSnapshot(g.run, clock, 60_000);
    snap.read();
    await flush();
    expect(snap.read()).toMatchObject({ state: "failed", at: clock.now() });
    expect(g.state.runs).toBe(1);
    g.state.fail = false;
    clock.advance(60_000);
    snap.read();
    await flush();
    const good = snap.read();
    expect(good).toMatchObject({ state: "ready", value: 2 });
    g.state.fail = true;
    clock.advance(60_000);
    snap.read();
    await flush();
    expect(g.state.runs).toBe(3);
    expect(snap.read()).toEqual({ ...good, refreshing: false });
  });
});

describe("HealthMonitor serving the stored report", () => {
  it("a slow check: no result yet answers pending at once; with a stored one, it and its finish time at once", async () => {
    const clock = new FakeClock("2026-11-19T10:00:00.000Z");
    const g = held<Check[]>((n) => [{ ok: true, msg: `run ${n}` }]);
    const m = new HealthMonitor(g.run, clock);
    m.serveStored();
    expect(await m.report(scanner)).toEqual({ checked_at: null, checks: [], pending: true, refreshing: true });
    clock.advance(3_000);
    g.release();
    await flush();
    const first = await m.report(scanner);
    expect(first).toEqual({ checked_at: "2026-11-19T10:00:03.000Z", checks: [{ status: "ok", msg: "run 1" }], pending: false, refreshing: false });
    clock.advance(HEALTH_MIN_INTERVAL_MS);
    expect(await m.report(scanner)).toEqual({ ...first, refreshing: true }); // the held second run is not waited for
    expect(g.state.runs).toBe(2);
    g.release();
    await flush();
    expect((await m.report(scanner)).checks[0]!.msg).toBe("run 2");
  });

  it("a check that throws keeps the last good report; with none it is one FAIL row", async () => {
    const clock = new FakeClock();
    const g = held<Check[]>(() => [{ ok: true, msg: "fine" }]);
    g.state.hold = false;
    g.state.fail = true;
    const m = new HealthMonitor(g.run, clock);
    m.serveStored();
    await m.report(scanner);
    await flush();
    const failed = await m.report(scanner);
    expect(failed.checks).toEqual([{ status: "fail", msg: "health checks could not finish: boom" }]);
    expect(failed.pending).toBe(false);
    g.state.fail = false;
    clock.advance(HEALTH_MIN_INTERVAL_MS);
    await m.report(scanner);
    await flush();
    const good = await m.report(scanner);
    expect(good.checks[0]!.status).toBe("ok");
    g.state.fail = true;
    clock.advance(HEALTH_MIN_INTERVAL_MS);
    await m.report(scanner);
    await flush();
    expect(await m.report(scanner)).toEqual(good);
  });

  it("not serving stored: reads run the checks on request as before", async () => {
    const clock = new FakeClock();
    let runs = 0;
    const m = new HealthMonitor(async () => [{ ok: true, msg: `run ${++runs}` }], clock);
    expect((await m.report(scanner)).checks[0]!.msg).toBe("run 1");
    clock.advance(HEALTH_MIN_INTERVAL_MS);
    await m.report(scanner);
    expect(runs).toBe(2);
  });
});

describe("Plugins stored listing and the UI server", () => {
  async function pluginDeps(clock: FakeClock, listing: { hold: boolean; fail: boolean; calls: number; release: () => void }) {
    const { store } = await newStore(clock);
    const editFile = Object.assign(async () => ({ ok: false as const, reason: "x" }), {
      capabilities: async () => {
        listing.calls++;
        if (listing.hold) await new Promise<void>((r) => (listing.release = r));
        if (listing.fail) throw new Error("listing failed");
        return { skill_folders: [], tools: [], providers: [] };
      },
    });
    const settings: UiSettings = {
      base: { file: {}, layers: { defaults: {}, projects: {} } }, repo: { owner: "o", name: "r" }, actor: "local:owner",
      resolveProject: storeProjectResolver(store, { owner: "o", name: "r" }), csrfToken: newCsrfToken(),
      editFile: editFile as unknown as NonNullable<UiSettings["editFile"]>,
    };
    const d: ApiDeps = { store, scanner, clock, lease_ms: 1000, health: new HealthMonitor(async () => [], clock), settings };
    return d;
  }
  const newListing = () => ({ hold: false, fail: false, calls: 0, release: () => undefined });

  it("a slow listing: pending at once, then the stored lists with their as-of time, never waiting for a refresh", async () => {
    const clock = new FakeClock("2026-11-19T10:00:00.000Z");
    const listing = { ...newListing(), hold: true };
    const d = await pluginDeps(clock, listing);
    servePluginsStored(d);
    const pending = await readPlugins(d);
    expect(pending).toMatchObject({ status: 200, value: { as_of: null, pending: true, failed: false, csrf_token: null, settings_token: null } });
    expect(pending.value).not.toHaveProperty("mcp");
    clock.advance(2_000);
    listing.release();
    await settle();
    const first = await readPlugins(d);
    expect(first.value).toMatchObject({ as_of: "2026-11-19T10:00:02.000Z", pending: false, failed: false, mcp: [] });
    clock.advance(HEALTH_MIN_INTERVAL_MS);
    const second = await readPlugins(d); // a refresh starts and is held: the read still answers
    expect(second.value).toMatchObject({ as_of: "2026-11-19T10:00:02.000Z", refreshing: true });
    expect(listing.calls).toBe(2);
  });

  it("a failed listing keeps the last good lists; with none the route answers failed: true", async () => {
    const clock = new FakeClock("2026-11-19T10:00:00.000Z");
    const listing = { ...newListing(), fail: true };
    const d = await pluginDeps(clock, listing);
    servePluginsStored(d);
    await readPlugins(d);
    await settle();
    expect((await readPlugins(d)).value).toMatchObject({ as_of: null, pending: false, failed: true });
    listing.fail = false;
    clock.advance(HEALTH_MIN_INTERVAL_MS);
    await readPlugins(d);
    await settle();
    const good = await readPlugins(d);
    listing.fail = true;
    clock.advance(HEALTH_MIN_INTERVAL_MS);
    await readPlugins(d);
    await settle();
    expect(listing.calls).toBe(3);
    expect((await readPlugins(d)).value).toEqual(good.value);
  });

  it("the server: /api/health and /api/v1/health give the same stored report; no check runs without reads", async () => {
    const clock = new FakeClock();
    const g = held<Check[]>(() => [{ ok: true, msg: "fine" }]);
    const d = await pluginDeps(clock, newListing());
    const ui = await startUi({ ...d, health: new HealthMonitor(g.run, clock) }, 0);
    try {
      const base = `http://127.0.0.1:${ui.port}`;
      expect(await (await fetch(`${base}/api/health`)).json()).toMatchObject({ checked_at: null, pending: true });
      g.release();
      await settle();
      const old = (await (await fetch(`${base}/api/health`)).json()) as Record<string, unknown>;
      const v1 = (await (await fetch(`${base}/api/v1/health`)).json()) as Record<string, unknown>;
      expect(old.pending).toBe(false);
      expect({ ...v1, sleeps: undefined }).toEqual({ ...old, sleeps: undefined });
      for (let i = 0; i < 5; i++) {
        clock.advance(HEALTH_MIN_INTERVAL_MS);
        await settle();
      }
      expect(g.state.runs).toBe(1);
    } finally {
      await ui.close();
    }
  });

  it("the server: a successful write returns at once, marks both stale and refreshes them; a refused one does not", async () => {
    const clock = new FakeClock("2026-11-19T10:00:00.000Z");
    const g = held<Check[]>(() => []);
    g.state.hold = false;
    const listing = newListing();
    const d = await pluginDeps(clock, listing);
    const ui = await startUi({ ...d, health: new HealthMonitor(g.run, clock) }, 0);
    try {
      const base = `http://127.0.0.1:${ui.port}`;
      await fetch(`${base}/api/v1/plugins`);
      await fetch(`${base}/api/v1/health`);
      await settle();
      const before = (await (await fetch(`${base}/api/v1/plugins`)).json()) as { as_of: string };
      expect([g.state.runs, listing.calls]).toEqual([1, 1]);
      const settings = (await (await fetch(`${base}/api/v1/settings`)).json()) as { csrf_token: string };
      const headers = { "content-type": "application/json", origin: base, "x-csrf-token": settings.csrf_token };
      const body = JSON.stringify({ action: "set", key: "max_loops", value: "2" });
      const refused = await fetch(`${base}/api/v1/settings`, { method: "POST", headers: { ...headers, "x-csrf-token": "" }, body });
      expect(refused.status).toBe(403);
      await settle();
      expect([g.state.runs, listing.calls]).toEqual([1, 1]);
      listing.hold = true;
      clock.advance(1_000);
      expect((await fetch(`${base}/api/v1/settings`, { method: "POST", headers, body })).status).toBe(200);
      expect([g.state.runs, listing.calls]).toEqual([2, 2]);
      // The old list and its as-of time while the refresh is held.
      expect(await (await fetch(`${base}/api/v1/plugins`)).json()).toMatchObject({ as_of: before.as_of, refreshing: true });
      listing.release();
      await settle();
      expect(await (await fetch(`${base}/api/v1/plugins`)).json()).toMatchObject({ as_of: "2026-11-19T10:00:01.000Z", refreshing: false });
    } finally {
      await ui.close();
    }
  });
});
