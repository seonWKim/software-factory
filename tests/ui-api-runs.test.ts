// The read-only JSON API under /api/v1: runs, queue, workers, overview, health, host sleeps, withholding and plugin links.

import { describe, expect, it } from "vitest";
import type { Timestamp, WorkItemId } from "../src/core/types.js";
import type { FactoryStore } from "../src/interfaces/factory-store.js";
import { saveProjectLabel } from "../src/core/project-labels.js";
import { type UiDeps } from "../src/ui/server.js";
import { issue, system, w1 } from "./helpers/store.js";
import { LEASE, SECRET, ROUTES, get, json, patch, seeded } from "./ui-api-fixtures.js";

describe("ui api: runs, queue, workers, overview, health", () => {
  it("/runs lists running then queued runs with owner, heartbeat, start and lease expiry, and no fencing token", async () => {
    const { d, items, claimed } = await seeded();
    const body = await json<{ runs: Record<string, unknown>[] }>(d, "/api/v1/runs");
    expect(body.runs.map((r) => r.status)).toEqual(["running", "running", "running", "queued", "queued"]);
    const first = body.runs.find((r) => r.id === claimed.id)!;
    expect(first).toEqual({
      id: claimed.id,
      status: "running",
      kind: "implement",
      work_item_id: items.running.id,
      attempt: 1,
      owner: "host:11:1",
      heartbeat_at: claimed.updated_at,
      started_at: claimed.started_at,
      lease_expires_at: claimed.lease!.expires_at,
      created_at: claimed.created_at,
    });
    const queued = body.runs.filter((r) => r.status === "queued");
    expect(queued.map((r) => r.work_item_id)).toEqual([items.queued.id, items.queued2.id]);
    expect(queued[0]).toMatchObject({ owner: null, heartbeat_at: null, lease_expires_at: null });
    for (const r of body.runs) expect(Object.keys(r)).not.toContain("token");
    expect(JSON.stringify(body)).not.toContain(`"token"`);
  });

  it("/queue is the queued runs oldest first, as the page's Queue section", async () => {
    const { d, items } = await seeded();
    const body = await json<{ queue: { position: number; kind: string; work_item_id: string; attempt: number }[] }>(d, "/api/v1/queue");
    expect(body.queue.map((q) => [q.position, q.kind, q.work_item_id])).toEqual([
      [1, "triage", items.queued.id],
      [2, "triage", items.queued2.id],
    ]);
  });

  it("/workers lists each current lease owner once with its running count, as IDs", async () => {
    const { d } = await seeded();
    const body = await json<{ workers: { owner: string; running: number }[] }>(d, "/api/v1/workers");
    expect(body.workers).toEqual([
      { owner: "[withheld: github_token]", running: 1 },
      { owner: "host:11:1", running: 2 },
    ]);
  });

  it("/workers adds processes: one entry per live process, idle ones too, each with its runs; workers is unchanged", async () => {
    const { d, store, clock, claimed } = await seeded();
    const started_at = clock.now().toISOString() as Timestamp;
    // A dead process's row: older than lease_ms, so not listed.
    await store.reportWorkerProcess({ process_id: "gone:3", pid: 3, host: "gone", slots: 1, max_slots: 1, busy: 1, index_base: 0, started_at });
    clock.advance(LEASE + 1);
    await store.reportWorkerProcess({ process_id: "host:11", pid: 11, host: "host", slots: 3, max_slots: 4, busy: 2, index_base: 0, started_at });
    await store.reportWorkerProcess({ process_id: "idle:5", pid: 5, host: "idle", slots: 2, max_slots: 2, busy: 0, index_base: 4, started_at });
    const body = await json<{ workers: unknown[]; processes: Record<string, unknown>[] }>(d, "/api/v1/workers");
    expect(body.workers).toEqual([
      { owner: "[withheld: github_token]", running: 1 },
      { owner: "host:11:1", running: 2 },
    ]);
    const reported_at = clock.now().toISOString();
    expect(body.processes.map((p) => [p.host, p.pid])).toEqual([["host", 11], ["idle", 5]]);
    expect(body.processes[0]).toMatchObject({
      process_id: "host:11", pid: 11, host: "host", slots: 3, max_slots: 4, busy: 2, idle: 1, index_base: 0, started_at, reported_at,
    });
    const runs = body.processes[0]!.runs as Record<string, unknown>[];
    expect(runs).toHaveLength(2);
    expect(runs.find((r) => r.id === claimed.id)).toEqual({
      id: claimed.id, kind: "implement", work_item_id: claimed.work_item_id, worker_id: "host:11:1", started_at: claimed.started_at,
    });
    expect(body.processes[1]).toMatchObject({ pid: 5, slots: 2, max_slots: 2, busy: 0, idle: 2, index_base: 4, runs: [] });
    for (const p of body.processes) {
      for (const k of ["pid", "host", "slots", "max_slots", "busy", "reported_at"]) expect(Object.keys(p)).toContain(k);
    }
  });

  it("/workers still answers when the processes read fails (e.g. the table is missing): workers as before, processes empty, the error named", async () => {
    const { d, store } = await seeded();
    store.listWorkerProcesses = async () => {
      throw new Error("Table 'sf.worker_processes' doesn't exist");
    };
    const body = await json<{ workers: unknown[]; processes: unknown[]; processes_error?: string }>(d, "/api/v1/workers");
    expect(body.workers).toEqual([
      { owner: "[withheld: github_token]", running: 1 },
      { owner: "host:11:1", running: 2 },
    ]);
    expect(body.processes).toEqual([]);
    expect(body.processes_error).toBe("Table 'sf.worker_processes' doesn't exist");
  });

  it("/overview gives the numbers for the same store", async () => {
    const { d, store } = await seeded();
    await store.setSettingOverride({ key: "review_time", project: "", value: '""', actor: "local:owner" }); // every waiting ask counts: none held until review_time
    const o = await json<{
      stages: Record<string, number>; needs_you: number; running: number; queued: number; last_24h: { succeeded: number; failed: number; tokens: number };
    }>(d, "/api/v1/overview");
    expect(o).toMatchObject({ needs_you: 3, running: 3, queued: 2, last_24h: { succeeded: 1, failed: 1, tokens: 1234 } });
    expect(o.stages).toEqual({ NEW: 3, READY: 1, RUNNING: 2, REVIEW: 2, CLOSED: 1 });

  });

  it("/health returns what /api/health returns, from the one HealthMonitor (one run for both), and /api/health is unchanged", async () => {
    const { d, healthRuns } = await seeded();
    const v1 = await get(d, "/api/v1/health");
    const old = await get(d, "/api/health");
    // /api/v1/health is /api/health plus the host sleeps (issue #218); none are seeded here.
    expect(JSON.parse(v1.body)).toEqual({ ...JSON.parse(old.body), sleeps: [] });
    expect(healthRuns()).toBe(1);
    expect(JSON.parse(old.body)).toEqual({
      checked_at: d.clock.now().toISOString(),
      checks: [{ status: "ok", msg: "secret file is outside the repository" }, { status: "fail", msg: "[withheld: github_token]" }],
      pending: false,
      refreshing: false,
    });
    expect(old.headers["content-type"]).toBe("application/json; charset=utf-8");
  });
});

describe("ui api: host sleeps (issue #218)", () => {
  const at = (ms: number) => new Date(Date.UTC(2026, 0, 1) + ms).toISOString() as Timestamp;

  it("/health lists the 10 newest host sleeps, newest first, as ids, times and numbers only; /api/health keeps its shape", async () => {
    const { d, store, claimed } = await seeded();
    for (let i = 0; i < 12; i++) {
      await store.recordHostSleep({ worker_id: w1, woke_at: at(i * 1000), gap_ms: 60_001 + i, run_id: i === 11 ? claimed.id : null });
    }
    const v1 = await json<{ sleeps: Record<string, unknown>[] }>(d, "/api/v1/health");
    expect(v1.sleeps.map((s) => s.woke_at)).toEqual(Array.from({ length: 10 }, (_, i) => at((11 - i) * 1000)));
    // The held run's item comes with its title, so the Health page names it (design 09-health, 2026-11-24).
    const title = (await store.getWorkItem(claimed.work_item_id))!.title;
    expect(title).toBeTruthy();
    expect(v1.sleeps[0]).toEqual({ worker_id: w1, woke_at: at(11_000), gap_ms: 60_012, run_id: claimed.id, work_item_id: claimed.work_item_id, work_item_title: title, run_status: "running" });
    expect(v1.sleeps[1]).toEqual({ worker_id: w1, woke_at: at(10_000), gap_ms: 60_011, run_id: null, work_item_id: null, work_item_title: null, run_status: null });
    for (const s of v1.sleeps) {
      expect(Object.keys(s).sort()).toEqual(["gap_ms", "run_id", "run_status", "woke_at", "work_item_id", "work_item_title", "worker_id"]);
      expect(typeof s.gap_ms).toBe("number");
    }
    const old = JSON.parse((await get(d, "/api/health")).body) as Record<string, unknown>;
    expect(Object.keys(old).sort()).toEqual(["checked_at", "checks", "pending", "refreshing"]);
  });

  it("/health answers with an empty sleeps list when the sleeps read fails", async () => {
    const { d } = await seeded({
      store: (s) => new Proxy(s, {
        get(target, prop, receiver) {
          if (prop === "listHostSleeps") return async () => { throw new Error("no such table: host_sleeps"); };
          const v = Reflect.get(target, prop, receiver) as unknown;
          return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(target) : v;
        },
      }),
    });
    const v1 = await json<{ sleeps: unknown[]; checks: unknown[] }>(d, "/api/v1/health");
    expect(v1.sleeps).toEqual([]);
    expect(v1.checks).toHaveLength(2);
    expect(JSON.stringify(v1)).not.toContain("no such table");
  });

  it("/health keeps a sleep row, without its item and status, when the run lookup fails", async () => {
    const { d, store, claimed } = await seeded({
      store: (s) => new Proxy(s, {
        get(target, prop, receiver) {
          if (prop === "getRun") return async () => { throw new Error("store down"); };
          const v = Reflect.get(target, prop, receiver) as unknown;
          return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(target) : v;
        },
      }),
    });
    await store.recordHostSleep({ worker_id: w1, woke_at: at(1000), gap_ms: 120_000, run_id: claimed.id });
    const v1 = await json<{ sleeps: unknown[]; checks: unknown[] }>(d, "/api/v1/health");
    expect(v1.sleeps).toEqual([{ worker_id: w1, woke_at: at(1000), gap_ms: 120_000, run_id: claimed.id, work_item_id: null, work_item_title: null, run_status: null }]);
    expect(v1.checks).toHaveLength(2);
  });

  it("item detail lists the sleeps recorded during that item's runs only, newest first", async () => {
    const { d, store, items, claimed, claimed2 } = await seeded();
    await store.recordHostSleep({ worker_id: w1, woke_at: at(1000), gap_ms: 120_000, run_id: claimed.id });
    await store.recordHostSleep({ worker_id: w1, woke_at: at(2000), gap_ms: 180_000, run_id: claimed.id });
    await store.recordHostSleep({ worker_id: w1, woke_at: at(3000), gap_ms: 240_000, run_id: claimed2.id });
    await store.recordHostSleep({ worker_id: w1, woke_at: at(4000), gap_ms: 300_000, run_id: null });
    const body = await json<{ sleeps: unknown[] }>(d, `/api/v1/items/${encodeURIComponent(items.running.id)}`);
    expect(body.sleeps).toEqual([
      { worker_id: w1, woke_at: at(2000), gap_ms: 180_000, run_id: claimed.id },
      { worker_id: w1, woke_at: at(1000), gap_ms: 120_000, run_id: claimed.id },
    ]);
    expect((await json<{ sleeps: unknown[] }>(d, `/api/v1/items/${encodeURIComponent(items.done.id)}`)).sleeps).toEqual([]);
  });
});

describe("ui api: withholding and read-only", () => {
  it("every withheld field is the [withheld: <rule>] marker, and the seeded secret is in no response body", async () => {
    const { d, items } = await seeded();
    const ids = Object.values(items).map((i) => i.id as WorkItemId);
    const paths = [
      ...ROUTES.filter((r) => !r.includes("ITEM")),
      ...ids.map((id) => `/api/v1/items/${encodeURIComponent(id)}`),
      "/api/v1/items?closed=1", "/api/v1/items?q=leaky", "/api/v1/items?state=needs",
    ];
    for (const path of paths) {
      const r = await get(d, path);
      expect(r.status, path).toBe(200);
      expect(r.body, path).not.toContain(SECRET);
      expect(r.body, path).not.toContain("Ab3Ab3");
    }
    const list = await json<{ items: { id: string; title: string; blocked_reason: string }[] }>(d, "/api/v1/items");
    const row = list.items.find((i) => i.id === items.secretive.id)!;
    expect(row.title).toBe("[withheld: github_token]");
    expect(row.blocked_reason).toBe("[withheld: github_token]");
    // A withheld title cannot be found by its text.
    expect((await json<{ items: unknown[] }>(d, "/api/v1/items?q=leaky")).items).toEqual([]);

    const detail = await json<{
      item: { title: string; blocked_reason: string };
      timeline: { reason: string; changes: Record<string, { from: string; to: string }>; detail: Record<string, string> | null }[];
    }>(d, `/api/v1/items/${encodeURIComponent(items.secretive.id)}`);
    expect(detail.item.title).toBe("[withheld: github_token]");
    expect(detail.timeline[1]!.reason).toBe("[withheld: github_token]");
    expect(detail.timeline[1]!.changes.blocked_reason!.to).toBe("[withheld: github_token]");
    expect(detail.timeline[2]!.detail).toEqual({ note: "[withheld: github_token]" });
  });

  it("titles are not HTML-escaped in JSON (the app escapes), and an untitled item has a null title", async () => {
    const { d, items } = await seeded();
    const list = await json<{ items: { id: string; title: string | null; source: { id: string } }[] }>(d, "/api/v1/items");
    expect(list.items.find((i) => i.id === items.approve.id)!.title).toBe("Spec for <script>alert(1)</script> the gate");
    expect(list.items.find((i) => i.id === items.queued.id)).toMatchObject({ title: null, source: { id: "o/r#8" } });
  });

  it("every route still answers 200 when any store method that is not a read throws", async () => {
    const calls: string[] = [];
    const readOnly = (s: FactoryStore): FactoryStore =>
      new Proxy(s, {
        get(target, prop, receiver) {
          const v = Reflect.get(target, prop, receiver) as unknown;
          if (typeof v !== "function") return v;
          const name = String(prop);
          if (!/^(get|list|count)[A-Z]/.test(name) && name !== "schemaVersion") {
            return () => {
              throw new Error(`store.${name} is not a read`);
            };
          }
          return (...args: unknown[]) => {
            calls.push(name);
            return (v as (...a: unknown[]) => unknown).apply(target, args);
          };
        },
      });
    const { d, items } = await seeded({ store: readOnly });
    for (const route of ROUTES) {
      const path = route.replace("ITEM", encodeURIComponent(items.done.id));
      expect((await get(d, path)).status, path).toBe(200);
      expect((await get(d, path, { method: "HEAD" })).status, path).toBe(200);
    }
    expect(calls.length).toBeGreaterThan(0);
  });
});

describe("ui api: plugins, issue and PR links (issue #240)", () => {
  type Row = { id: string; issue: { number: number; url: string } | null; change_ref: string | null; change_url: string | null };

  it("overview reports the plugins in use (issues only); absent deps mean none", async () => {
    const { d } = await seeded();
    expect((await json<{ plugins: unknown }>(d, "/api/v1/overview")).plugins).toEqual({ issues: null });
    const gh = { ...d, plugins: { issues: "github" } } as UiDeps;
    expect((await json<{ plugins: unknown }>(gh, "/api/v1/overview")).plugins).toEqual({ issues: "github" });
  });

  it("items carry the issue, null for an adopted PR, and the PR link the store keeps as change_url", async () => {
    const { d, store, items } = await seeded();
    await saveProjectLabel(store, { key: items.merge.project, label: "github.com/o/r" });
    const adopted = (await store.createWorkItem(
      { ...issue(90), source: { type: "github_issue", id: "o/r#90", link: "https://github.com/o/r/pull/90" } }, system,
    )).item;
    await patch(store, adopted, { change_ref: "90" });
    const stored = (await store.getWorkItem(adopted.id))!.change_url;
    expect(stored).toBe("https://github.com/o/r/pull/90");
    const list = (await json<{ items: Row[] }>(d, "/api/v1/items")).items;
    const merge = list.find((i) => i.id === items.merge.id)!;
    expect(merge.issue).toEqual({ number: 2, url: "https://github.com/o/r/issues/2" });
    const pr = list.find((i) => i.id === adopted.id)!;
    expect(pr.issue).toBeNull();
    expect(pr).toMatchObject({ change_ref: "90", change_url: stored });
    expect(Object.keys(pr)).not.toContain("pr_number");
    expect(Object.keys(pr)).not.toContain("pr_url");
    // The item page returns the same stored link.
    const one = await json<{ item: Row }>(d, `/api/v1/items/${adopted.id}`);
    expect(one.item).toMatchObject({ change_ref: "90", change_url: stored });
    expect(Object.keys(one.item)).not.toContain("pr_url");
  });

  it("a change_ref with no stored change_url has no link, even once a label is stored later (no link is built)", async () => {
    const { d, store, items } = await seeded();
    const before = (await json<{ items: Row[] }>(d, "/api/v1/items")).items.find((i) => i.id === items.merge.id)!;
    expect(before).toMatchObject({ change_ref: "42", change_url: null });
    await saveProjectLabel(store, { key: items.merge.project, label: "github.com/o/r" });
    const after = (await json<{ items: Row[] }>(d, "/api/v1/items")).items.find((i) => i.id === items.merge.id)!;
    expect(after).toMatchObject({ change_ref: "42", change_url: null });
    const none = (await json<{ items: Row[] }>(d, "/api/v1/items")).items.find((i) => i.id === items.running.id)!;
    expect(none).toMatchObject({ change_ref: null, change_url: null });
  });
});
