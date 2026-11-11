// The menu bar count: needs_you from /api/v1/overview, read every 15 seconds.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ShellStatus } from "../../src/interfaces/app-shell.js";
import { STATUS_INTERVAL_MS, UNREACHABLE, overviewUrl, pollStatus, statusFromOverview } from "../../desktop/electron/common/status.js";
import { FakeAppShell } from "./fakes.js";

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
});
afterEach(() => {
  vi.useRealTimers();
});

/** A fake overview route: answers with `body()` and records each URL asked. */
function fakeOverview(body: () => unknown) {
  const urls: string[] = [];
  const fetch = async (url: string) => {
    urls.push(url);
    return { ok: true, json: async () => body() };
  };
  return { fetch, urls };
}

describe("menu bar status", () => {
  it("the count equals needs_you from the overview, refreshed every 15 seconds", async () => {
    let needs = 2;
    const api = fakeOverview(() => ({ factory: { state: "running" }, needs_you: needs, running: 1 }));
    const shell = new FakeAppShell();
    const stop = pollStatus({ fetch: api.fetch, url: overviewUrl(4310), onStatus: (s) => shell.setStatus(s) });
    await vi.advanceTimersByTimeAsync(0);
    expect(shell.status).toEqual({ state: "running", needsYou: 2 });
    expect(shell.menuText()).toBe("SF 2");
    needs = 5;
    await vi.advanceTimersByTimeAsync(STATUS_INTERVAL_MS - 1);
    expect(shell.status.needsYou).toBe(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(shell.status.needsYou).toBe(5);
    expect(api.urls[0]).toBe("http://127.0.0.1:4310/api/v1/overview");
    expect(STATUS_INTERVAL_MS).toBe(15_000);
    stop();
    const asked = api.urls.length;
    await vi.advanceTimersByTimeAsync(STATUS_INTERVAL_MS * 2);
    expect(api.urls.length).toBe(asked);
  });

  it("shows not reachable while the dashboard does not answer", async () => {
    const seen: ShellStatus[] = [];
    pollStatus({ fetch: () => Promise.reject(new Error("ECONNREFUSED")), url: overviewUrl(4310), onStatus: (s) => seen.push(s) });
    await vi.advanceTimersByTimeAsync(0);
    expect(seen).toEqual([UNREACHABLE]);
  });

  it("reads a stopped supervisor and a body without a factory block", () => {
    expect(statusFromOverview({ factory: null, needs_you: 0 })).toEqual({ state: "stopped", needsYou: 0 });
    expect(statusFromOverview({ needs_you: 1 })).toEqual({ state: "running", needsYou: 1 });
    expect(statusFromOverview({ factory: { state: "updating" } })).toEqual({ state: "updating", needsYou: null });
  });
});
