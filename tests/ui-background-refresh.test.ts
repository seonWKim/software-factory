// The Health and Plugins reads answer from a background snapshot (design 09-health and 09-dashboard-settings,
// 2026-11-19): the last result at once, a refresh beside it, the last good result kept on a failure, no refresh
// while idle, and nothing running after close.

import { describe, expect, it } from "vitest";
import { FakeClock } from "../src/impl/clock/fake-clock.js";
import { PatternEgressScanner } from "../src/impl/egress/pattern-egress-scanner.js";
import { type Check } from "../src/setup.js";
import { BackgroundSnapshot, IDLE_MS } from "../src/ui/background-refresh.js";
import { HEALTH_MIN_INTERVAL_MS, HealthMonitor } from "../src/ui/health.js";
import { startPluginsSnapshot } from "../src/ui/plugins-api.js";
import { type ApiDeps, startUi } from "../src/ui/server.js";
import { type UiSettings, newCsrfToken, storeProjectResolver } from "../src/ui/settings-api.js";
import { newStore } from "./helpers/store.js";

const scanner = new PatternEgressScanner(async () => []);
const flush = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};

/** A check that finishes only when `release()` is called, and counts its runs. */
function gate() {
  let release: () => void = () => undefined;
  const state = { runs: 0, slow: false, fail: false, msg: "first" };
  const run = async (): Promise<Check[]> => {
    state.runs++;
    if (state.fail) throw new Error("boom");
    const msg = state.msg;
    if (state.slow) await new Promise<void>((r) => (release = r));
    return [{ ok: true, msg }];
  };
  return { state, run, release: () => release() };
}

describe("BackgroundSnapshot", () => {
  it("the first read waits for the first refresh, later reads do not", async () => {
    const clock = new FakeClock();
    let n = 0;
    let release: () => void = () => undefined;
    const snap = new BackgroundSnapshot(async () => {
      n++;
      if (n === 2) await new Promise<void>((r) => (release = r));
      return n;
    }, clock, 1000);
    expect((await snap.read()).value).toBe(1);
    clock.advance(IDLE_MS + 1);
    expect((await snap.read()).value).toBe(1); // idle: the last result, a refresh starts
    await flush();
    expect(n).toBe(2);
    expect((await snap.read()).value).toBe(1); // the slow refresh is not waited for
    release();
    await flush();
    expect((await snap.read()).value).toBe(2);
  });

  it("a failed refresh keeps the last good result and its time; with none, the first read gets the error", async () => {
    const clock = new FakeClock();
    let fail = true;
    const snap = new BackgroundSnapshot(async () => {
      if (fail) throw new Error("nope");
      return "good";
    }, clock, 1000);
    await expect(snap.read()).rejects.toThrow("nope");
    fail = false;
    const first = await snap.read();
    expect(first.value).toBe("good");
    fail = true;
    clock.advance(IDLE_MS + 1);
    await snap.read();
    await flush();
    const after = await snap.read();
    expect(after.value).toBe("good");
    expect(after.as_of).toEqual(first.as_of);
  });

  it("refreshes every interval while in use, none after 10 minutes without a read, none after stop", async () => {
    const clock = new FakeClock();
    let n = 0;
    const snap = new BackgroundSnapshot(async () => ++n, clock, 60_000);
    snap.start();
    await snap.read();
    for (let i = 0; i < 3; i++) {
      clock.advance(60_000);
      await flush();
    }
    expect(n).toBe(4);
    clock.advance(IDLE_MS);
    await flush();
    const idleRuns = n;
    for (let i = 0; i < 3; i++) {
      clock.advance(60_000);
      await flush();
    }
    expect(n).toBe(idleRuns);
    snap.stop();
    await snap.read(); // idle read: the last result and one refresh
    await flush();
    const stopped = n;
    clock.advance(10 * 60_000);
    await flush();
    expect(n).toBe(stopped);
  });
});

describe("HealthMonitor started", () => {
  it("returns the last result at once; checked_at is the last run's time, not the slow run's", async () => {
    const clock = new FakeClock("2026-11-19T10:00:00.000Z");
    const g = gate();
    const m = new HealthMonitor(g.run, clock);
    m.start();
    const first = await m.report(scanner);
    expect(first.checked_at).toBe("2026-11-19T10:00:00.000Z");
    g.state.slow = true;
    g.state.msg = "second";
    clock.advance(IDLE_MS + 1); // idle: the next read starts a refresh
    const second = await m.report(scanner);
    expect(second).toEqual(first);
    await flush();
    expect(g.state.runs).toBe(2);
    clock.advance(5_000);
    expect(await m.report(scanner)).toEqual(first); // still the last result while the slow run is out
    g.release();
    await flush();
    const third = await m.report(scanner);
    expect(third.checks[0]!.msg).toBe("second");
    expect(third.checked_at).not.toBe(first.checked_at);
    m.stop();
  });

  it("a check that throws keeps the last good report; with none it is one FAIL row", async () => {
    const clock = new FakeClock();
    const g = gate();
    g.state.fail = true;
    const m = new HealthMonitor(g.run, clock);
    m.start();
    const failed = await m.report(scanner);
    expect(failed.checks).toEqual([{ status: "fail", msg: "health checks could not finish: boom" }]);
    g.state.fail = false;
    clock.advance(HEALTH_MIN_INTERVAL_MS);
    const good = await m.report(scanner);
    expect(good.checks[0]!.status).toBe("ok");
    g.state.fail = true;
    clock.advance(IDLE_MS + 1);
    await m.report(scanner);
    await flush();
    expect(await m.report(scanner)).toEqual(good);
    m.stop();
  });

  it("not started: reads run the checks on request as before", async () => {
    const clock = new FakeClock();
    const g = gate();
    const m = new HealthMonitor(g.run, clock);
    await m.report(scanner);
    clock.advance(HEALTH_MIN_INTERVAL_MS);
    await m.report(scanner);
    expect(g.state.runs).toBe(2);
  });
});

describe("Plugins snapshot and the UI server", () => {
  async function pluginDeps(clock: FakeClock, slow: { on: boolean; fail: boolean; calls: number }) {
    const { store } = await newStore(clock);
    const editFile = Object.assign(async () => ({ ok: false as const, reason: "x" }), {
      capabilities: async () => {
        slow.calls++;
        if (slow.fail) throw new Error("discovery failed");
        if (slow.on) await new Promise<void>(() => undefined);
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

  it("slow discovery: the route returns the last result at once; a failure keeps it", async () => {
    const { readPlugins } = await import("../src/ui/plugins-api.js");
    const clock = new FakeClock("2026-11-19T10:00:00.000Z");
    const slow = { on: false, fail: false, calls: 0 };
    const d = await pluginDeps(clock, slow);
    const handle = startPluginsSnapshot(d);
    const first = await readPlugins(d);
    expect(first.status).toBe(200);
    slow.on = true;
    clock.advance(IDLE_MS + 1);
    const second = await readPlugins(d); // returns at once although discovery now never finishes
    expect(second.value).toMatchObject({ as_of: "2026-11-19T10:00:00.000Z", settings_token: null, csrf_token: null });
    handle.stop();
    // after stop the read is live again
    slow.on = false;
    slow.fail = true;
    await expect(readPlugins(d)).rejects.toThrow("discovery failed");
  });

  it("a failed discovery keeps the last good plugins", async () => {
    const { readPlugins } = await import("../src/ui/plugins-api.js");
    const clock = new FakeClock("2026-11-19T10:00:00.000Z");
    const slow = { on: false, fail: false, calls: 0 };
    const d = await pluginDeps(clock, slow);
    const handle = startPluginsSnapshot(d);
    const first = await readPlugins(d);
    slow.fail = true;
    clock.advance(IDLE_MS + 1);
    await readPlugins(d);
    await flush();
    expect(slow.calls).toBe(2);
    expect((await readPlugins(d)).value).toEqual(first.value);
    handle.stop();
  });

  it("closing the server stops the refresh: no check runs after close", async () => {
    const clock = new FakeClock();
    const g = gate();
    const d = await pluginDeps(clock, { on: false, fail: false, calls: 0 });
    const ui = await startUi({ ...d, health: new HealthMonitor(g.run, clock) }, 0);
    const res = await fetch(`http://127.0.0.1:${ui.port}/api/health`);
    expect(res.status).toBe(200);
    expect(g.state.runs).toBe(1);
    await ui.close();
    for (let i = 0; i < 3; i++) {
      clock.advance(HEALTH_MIN_INTERVAL_MS);
      await flush();
    }
    expect(g.state.runs).toBe(1);
  });
});
