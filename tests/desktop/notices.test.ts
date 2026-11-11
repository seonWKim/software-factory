// Owner notices in the shell (docs/design/09-notifications.md): GET /api/v1/notices read on the 15-second status
// tick, each pending notice shown once, and the shown ones kept in the app data folder across a restart.
import * as nodeFs from "node:fs";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { appDataPaths } from "../../desktop/electron/common/app-data.js";
import { type PendingNotice, NOTICE_TITLE, noticePoller, noticeTarget, noticeText } from "../../desktop/electron/common/notices.js";
import { PRODUCT_NAME } from "../../desktop/electron/common/product.js";
import { runShell } from "../../desktop/electron/common/run-shell.js";
import { STATUS_INTERVAL_MS } from "../../desktop/electron/common/status.js";
import { FakeAppShell, fakeSpawn } from "./fakes.js";

const DASHBOARD = "http://127.0.0.1:4310/app/";
const NOTICES = "http://127.0.0.1:4310/api/v1/notices";
const at = "2026-11-12T09:00:00.000Z";
const spec: PendingNotice = { work_item_id: "wi_1", wait_key: "sc_1", kind: "spec", count: 1, created_at: at };
const merge: PendingNotice = { work_item_id: "wi/2", wait_key: "sc_2", kind: "merge", count: 1, created_at: at };
const summary: PendingNotice = { work_item_id: null, wait_key: "quiet:2026-11-12T07:00:00.000Z", kind: "summary", count: 3, created_at: at };

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
});
afterEach(() => {
  vi.useRealTimers();
});

/** The dashboard: the overview answers while `up`, the notices route lists `pending`; every URL asked is recorded. */
function fakeDashboard() {
  const api = { up: true, pending: [] as PendingNotice[], urls: [] as string[] };
  const fetch = async (url: string) => {
    api.urls.push(url);
    if (!api.up) throw new Error("ECONNREFUSED");
    const body = url === NOTICES ? { as_of: at, notices: api.pending } : { factory: { state: "running" }, needs_you: api.pending.length };
    return { ok: true, json: async () => body };
  };
  return { api, fetch };
}

/** A shell over `home`, attached to the fake dashboard (it answers, so no supervisor is spawned). */
async function start(home: string, fetch: ReturnType<typeof fakeDashboard>["fetch"]) {
  const shell = new FakeAppShell();
  const r = await runShell({
    home, fs: nodeFs, spawn: fakeSpawn().spawn, execPath: "/App/Electron", env: {}, fetch, defaultCheckout: "/src/software-factory",
    alive: () => false, makeShell: () => shell,
  });
  return { ...r, shell };
}

describe("owner notices in the shell", () => {
  it("reads the notices on the 15-second status tick and shows each pending notice once", async () => {
    const d = fakeDashboard();
    d.api.pending = [spec];
    const { shell } = await start(mkdtempSync(join(tmpdir(), "sf-notices-")), d.fetch);
    await vi.advanceTimersByTimeAsync(0);
    expect(d.api.urls).toContain(NOTICES);
    expect(shell.notices).toEqual([{ title: NOTICE_TITLE, body: "A spec waits for your approval", target: `${DASHBOARD}items/wi_1` }]);
    const asked = d.api.urls.filter((u) => u === NOTICES).length;
    await vi.advanceTimersByTimeAsync(STATUS_INTERVAL_MS);
    expect(d.api.urls.filter((u) => u === NOTICES).length).toBe(asked + 1);
    expect(shell.notices).toHaveLength(1);
    d.api.pending = [spec, merge];
    await vi.advanceTimersByTimeAsync(STATUS_INTERVAL_MS);
    expect(shell.notices.map((n) => n.target)).toEqual([`${DASHBOARD}items/wi_1`, `${DASHBOARD}items/wi%2F2`]);
  });

  it("asks no notices while the dashboard does not answer", async () => {
    const d = fakeDashboard();
    const { shell } = await start(mkdtempSync(join(tmpdir(), "sf-notices-")), d.fetch);
    await vi.advanceTimersByTimeAsync(0);
    d.api.up = false;
    d.api.urls.length = 0;
    await vi.advanceTimersByTimeAsync(STATUS_INTERVAL_MS);
    expect(d.api.urls).not.toContain(NOTICES);
    expect(shell.notices).toEqual([]);
  });

  it("remembers the shown notices in the app data folder, so a restart shows none of them again", async () => {
    const home = mkdtempSync(join(tmpdir(), "sf-notices-"));
    const d = fakeDashboard();
    d.api.pending = [spec, summary];
    const first = await start(home, d.fetch);
    await vi.advanceTimersByTimeAsync(0);
    expect(first.shell.notices).toHaveLength(2);
    first.shell.quit();
    const file = appDataPaths(home).notices;
    expect(file.startsWith(`${appDataPaths(home).state}/`)).toBe(true);
    expect(existsSync(file)).toBe(true);
    d.api.pending = [spec, summary, merge];
    const second = await start(home, d.fetch);
    await vi.advanceTimersByTimeAsync(0);
    expect(second.shell.notices.map((n) => n.target)).toEqual([`${DASHBOARD}items/wi%2F2`]);
  });
});

describe("noticePoller", () => {
  /** A poller over an in-memory file. */
  function poller(pending: () => unknown, files = new Map<string, string>()) {
    const shown: { title: string; body: string; target: string }[] = [];
    const fs = {
      readFileSync: (p: string) => {
        const t = files.get(p);
        if (t === undefined) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
        return t;
      },
      writeFileSync: (p: string, t: string) => void files.set(p, t),
    };
    const poll = noticePoller({
      fetch: async () => ({ ok: true, json: async () => ({ notices: pending() }) }),
      url: NOTICES, dashboard: DASHBOARD, fs, file: "/state/notices-shown.json",
      notify: (title, body, target) => void shown.push({ title, body, target }),
    });
    return { poll, shown, files };
  }

  it("a second poll with the same notice calls notify zero times", async () => {
    const p = poller(() => [spec]);
    await p.poll();
    await p.poll();
    expect(p.shown).toHaveLength(1);
  });

  it("keeps only the shown notices still pending, so the file never outgrows the list", async () => {
    let pending = [spec, merge];
    const p = poller(() => pending);
    await p.poll();
    pending = [merge];
    await p.poll();
    expect(JSON.parse(p.files.get("/state/notices-shown.json")!).shown).toEqual([JSON.stringify(["wi/2", "sc_2"])]);
  });

  it("skips entries that are not notices and a body without a list", async () => {
    const p = poller(() => [{ work_item_id: 3, wait_key: "x", kind: "spec", count: 1 }, { kind: "spec" }, spec]);
    await p.poll();
    expect(p.shown).toHaveLength(1);
    const none = poller(() => undefined);
    await none.poll();
    expect(none.shown).toEqual([]);
  });

  it("a summary shows its count and opens the dashboard root; an item notice opens its item page", () => {
    expect(noticeText(summary)).toEqual({ title: NOTICE_TITLE, body: "3 items waited for you during quiet hours" });
    // The title is the app's name, so a rename never leaves notices under the old name.
    expect(NOTICE_TITLE).toBe(PRODUCT_NAME);
    expect(noticeTarget(summary, DASHBOARD)).toBe(DASHBOARD);
    expect(noticeTarget(spec, DASHBOARD)).toBe(`${DASHBOARD}items/wi_1`);
  });

  it("the text carries the kind and the count only, never an item ID or other free text", () => {
    for (const kind of ["spec", "merge", "failure", "other", "anything else"]) {
      const { title, body } = noticeText({ ...spec, kind, work_item_id: "wi_secret_title" });
      expect(`${title} ${body}`).not.toContain("wi_secret_title");
      expect(`${title} ${body}`).not.toContain("anything else");
    }
    expect(new Set(["spec", "merge", "failure", "other"].map((kind) => noticeText({ ...spec, kind }).body)).size).toBe(4);
  });
});
