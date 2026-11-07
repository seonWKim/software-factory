// The read-only JSON API under /api/v1 (design §9): its contract, its request guards, that it lists the same
// rows as the HTML page, that store text leaves only through the Withholder, and that it never writes.
// Everything goes through respond(), the server's whole request handling without a socket.

import { describe, expect, it } from "vitest";
import type { Timestamp, WorkItem, WorkItemId, WorkerId } from "../src/core/types.js";
import type { FactoryStore } from "../src/interfaces/factory-store.js";
import { FakeClock } from "../src/impl/clock/fake-clock.js";
import { PatternEgressScanner } from "../src/impl/egress/pattern-egress-scanner.js";
import { saveProjectLabel } from "../src/core/project-labels.js";
import { HealthMonitor } from "../src/ui/health.js";
import { type UiDeps, type UiResponse, respond, wire } from "../src/ui/server.js";
import { issue, newStore, system, w1 } from "./helpers/store.js";

const LEASE = 60_000;
// Built here so no secret-shaped literal sits in the repository.
const SECRET = `ghp_${"Ab3".repeat(12)}`;
const ROUTES = [
  "/api/v1/overview", "/api/v1/items", "/api/v1/items/ITEM", "/api/v1/runs", "/api/v1/queue", "/api/v1/workers", "/api/v1/health",
  "/api/v1/data/tables", "/api/v1/data/tables/work_items", "/api/v1/data/tables/runs", "/api/v1/data/tables/state_changes",
];

function get(d: UiDeps, path: string, opts: { method?: string; host?: string } = {}): Promise<UiResponse> {
  return respond(d, { method: opts.method ?? "GET", url: path, host: opts.host ?? "127.0.0.1:4310" });
}

async function json<T = Record<string, unknown>>(d: UiDeps, path: string): Promise<T> {
  const r = await get(d, path);
  expect(r.status, path).toBe(200);
  return JSON.parse(r.body) as T;
}

async function make(store: FactoryStore, n: number, title: string | null): Promise<WorkItem> {
  return (await store.createWorkItem({ ...issue(n), ...(title === null ? {} : { title }) }, system)).item;
}

async function patch(store: FactoryStore, item: WorkItem, p: Parameters<FactoryStore["transition"]>[0]["patch"], reason = "seed") {
  const cur = (await store.getWorkItem(item.id))!;
  const r = await store.transition({ id: item.id, expected_version: cur.version, patch: p, actor: system, reason });
  if (!r.ok) throw new Error(r.reason);
  return r.item;
}

async function enqueue(store: FactoryStore, item: WorkItem, kind: "triage" | "implement" | "review", key: string, p: Parameters<FactoryStore["transition"]>[0]["patch"] = {}) {
  const cur = (await store.getWorkItem(item.id))!;
  const r = await store.transition({ id: item.id, expected_version: cur.version, patch: p, actor: system, reason: "x", enqueue: { kind, idempotency_key: key } });
  if (!r.ok) throw new Error(r.reason);
}

/** One item per level, finished runs in the last 24 h, two running runs on two workers, and a secret in every free-text field. */
async function seeded(opts: { store?: (s: FactoryStore) => FactoryStore } = {}) {
  const clock = new FakeClock();
  const { store } = await newStore(clock);

  const approve = await make(store, 1, "Spec for <script>alert(1)</script> the gate");
  await patch(store, approve, { stage: "READY", blocked_on: "human", blocked_reason: "spec_pending" });
  const merge = await make(store, 2, "Merge me");
  await patch(store, merge, { stage: "REVIEW", blocked_on: "human", blocked_reason: "merge_pending", pr_number: 42, tier: 2 });
  // Secrets: a title, a blocked reason, a state-change reason and detail value.
  const secretive = await make(store, 3, `Leaky ${SECRET} title`);
  await patch(store, secretive, { blocked_on: "human", blocked_reason: `custom ${SECRET}` }, `reason ${SECRET}`);
  const cur = (await store.getWorkItem(secretive.id))!;
  await store.transition({ id: secretive.id, expected_version: cur.version, patch: { tier: 3 }, actor: system, reason: "x", detail: { note: `detail ${SECRET}` } });

  // Finished runs: one succeeded with tokens, one failed carrying a secret in its error detail.
  const done = await make(store, 4, "Done item");
  await enqueue(store, done, "triage", "done:t");
  let r = (await store.claimRun({ worker_id: w1, kinds: ["triage"], lease_ms: LEASE }))!;
  clock.advance(90_000);
  await store.completeRun(r.id, r.lease!.token, { status: "succeeded", summary: "ok", data: { tokens: 1234 } });
  await enqueue(store, done, "implement", "done:i");
  r = (await store.claimRun({ worker_id: w1, kinds: ["implement"], lease_ms: LEASE }))!;
  await store.completeRun(r.id, r.lease!.token, { status: "failed", error_code: "agent_error", detail: `push failed: token ${SECRET} rejected`, infra: false });
  await patch(store, done, { stage: "CLOSED", close_reason: "completed", token_cost: 1234 });

  // Running: one on a plain worker (heartbeat goes stale), one on a worker whose id carries a secret.
  const running = await make(store, 5, "Running item");
  await enqueue(store, running, "implement", "run:i", { stage: "RUNNING" });
  const claimed = (await store.claimRun({ worker_id: "host:11:1" as WorkerId, kinds: ["implement"], lease_ms: LEASE }))!;
  const running2 = await make(store, 6, "Second running item");
  await enqueue(store, running2, "review", "run:r", { stage: "REVIEW" });
  const claimed2 = (await store.claimRun({ worker_id: `host:${SECRET}:2` as WorkerId, kinds: ["review"], lease_ms: LEASE }))!;
  const running3 = await make(store, 7, "Third running item");
  await enqueue(store, running3, "implement", "run:i3", { stage: "RUNNING" });
  await store.claimRun({ worker_id: "host:11:1" as WorkerId, kinds: ["implement"], lease_ms: LEASE });

  // Queued, one without a title.
  const queued = await make(store, 8, null);
  await enqueue(store, queued, "triage", "q:t");
  const queued2 = await make(store, 9, "Queued two");
  clock.advance(1_000);
  await enqueue(store, queued2, "triage", "q:t2");

  clock.advance(LEASE + 5_000);

  const scanner = new PatternEgressScanner(async () => []);
  let healthRuns = 0;
  const health = new HealthMonitor(async () => {
    healthRuns++;
    return [{ ok: true, msg: "secret file is outside the repository" }, { ok: false, msg: `mysql said ${SECRET}` }];
  }, clock);
  const d: UiDeps = {
    store: opts.store ? opts.store(store) : store,
    scanner,
    clock,
    lease_ms: LEASE,
    prUrl: (label, n) => `https://${label}/pull/${n}`,
    health,
  };
  return { d, store, clock, items: { approve, merge, secretive, done, running, running2, running3, queued, queued2 }, claimed, claimed2, healthRuns: () => healthRuns };
}

/** The data-key of every row in the HTML list, in order. */
function htmlKeys(body: string): string[] {
  const start = body.indexOf(`<section id="items">`);
  const sec = body.slice(start, body.indexOf("</section>", start));
  return [...sec.matchAll(/data-key="([^"]+)"/g)].map((m) => m[1]!);
}

function sectionOf(body: string, id: string): string {
  const start = body.indexOf(`<section id="${id}">`);
  return body.slice(start, body.indexOf("</section>", start));
}

describe("ui api: contract", () => {
  it("every route answers 200 JSON with no-store and the security headers", async () => {
    const { d, items } = await seeded();
    for (const route of ROUTES) {
      const path = route.replace("ITEM", items.approve.id);
      const r = await get(d, path);
      expect(r.status, path).toBe(200);
      expect(r.headers["content-type"], path).toBe("application/json; charset=utf-8");
      expect(r.headers["cache-control"], path).toBe("no-store");
      expect(r.headers["x-content-type-options"], path).toBe("nosniff");
      expect(r.headers["x-frame-options"], path).toBe("DENY");
      expect(r.headers["referrer-policy"], path).toBe("no-referrer");
      expect(r.headers["content-security-policy"], path).toMatch(/^default-src 'none'/);
      expect(() => JSON.parse(r.body), path).not.toThrow();
    }
  });

  it("HEAD gives the same status and headers as GET, and no body on the wire", async () => {
    const { d, items } = await seeded();
    for (const route of [...ROUTES, "/api/v1/nope", "/api/v1/items/nope"]) {
      const path = route.replace("ITEM", items.approve.id);
      const g = wire(await get(d, path), false);
      const h = wire(await get(d, path, { method: "HEAD" }), true);
      expect(h.status, path).toBe(g.status);
      expect(h.headers, path).toEqual(g.headers);
      expect(h.body.length, path).toBe(0);
      expect(g.body.length, path).toBe(Number(g.headers["content-length"]));
    }
  });

  it("other methods get 405 with allow: GET, HEAD; a foreign Host gets 403; both as JSON", async () => {
    const { d } = await seeded();
    for (const method of ["POST", "PUT", "DELETE", "PATCH", "OPTIONS"]) {
      const r = await get(d, "/api/v1/items", { method });
      expect(r.status, method).toBe(405);
      expect(r.headers.allow).toBe("GET, HEAD");
      expect(r.headers["content-type"]).toBe("application/json; charset=utf-8");
      expect(JSON.parse(r.body)).toHaveProperty("error");
    }
    for (const host of ["evil.example", "127.0.0.1.evil.example", "localhost.evil:4310", ""]) {
      const r = await get(d, "/api/v1/overview", { host });
      expect(r.status, host).toBe(403);
      expect(r.headers["content-type"]).toBe("application/json; charset=utf-8");
    }
    expect((await get(d, "/api/v1/overview", { host: "localhost:4310" })).status).toBe(200);
  });

  it("an unknown /api/v1 path and an unknown item id are 404 JSON", async () => {
    const { d } = await seeded();
    for (const path of ["/api/v1", "/api/v1/", "/api/v1/nope", "/api/v1/items/", "/api/v1/items/a/b", "/api/v1/items/wi_nope", "/api/v1/items/%E0%A4%A"]) {
      const r = await get(d, path);
      expect(r.status, path).toBe(404);
      expect(r.headers["content-type"], path).toBe("application/json; charset=utf-8");
      expect(JSON.parse(r.body), path).toHaveProperty("error");
    }
  });
});

describe("ui api: items", () => {
  it("lists the same rows in the same order as / for the same query string, every filter included", async () => {
    const { d } = await seeded();
    const queries = [
      "", "?closed=1", "?state=needs", "?state=running", "?state=queued", "?state=closed", "?stage=REVIEW", "?stage=CLOSED",
      "?tier=2", "?kind=triage", "?kind=implement", "?unblocks=1", "?q=merge", "?q=%233", "?q=leaky", "?state=needs&tier=3",
    ];
    for (const q of queries) {
      const page = await get(d, `/classic${q}`);
      expect(page.status, q).toBe(200);
      const api = await json<{ total: number; items: { id: string }[] }>(d, `/api/v1/items${q}`);
      expect(api.items.map((i) => i.id), q).toEqual(htmlKeys(page.body));
      expect(api.total, q).toBe(api.items.length);
    }
  });

  it("the default list has every open item ranked, and the filters narrow it", async () => {
    const { d, items } = await seeded();
    const all = await json<{ items: { id: string; level: string; badges: string[]; stage: string; run_status: string | null }[] }>(d, "/api/v1/items");
    expect(all.items.length).toBe(8); // nine items, one closed
    expect(all.items[0]).toMatchObject({ id: items.merge.id, level: "ready_to_merge", badges: ["ready to merge"], stage: "REVIEW" });
    expect(all.items[1]).toMatchObject({ id: items.approve.id, level: "needs_approval" });
    const needs = await json<{ items: { id: string }[] }>(d, "/api/v1/items?state=needs");
    expect(needs.items.map((i) => i.id)).toEqual([items.merge.id, items.approve.id, items.secretive.id]);
    const closed = await json<{ items: { id: string }[] }>(d, "/api/v1/items?stage=CLOSED");
    expect(closed.items.map((i) => i.id)).toEqual([items.done.id]);
    const kind = await json<{ items: { id: string; run_status: string | null }[] }>(d, "/api/v1/items?kind=review");
    expect(kind.items).toMatchObject([{ id: items.running2.id, run_status: "running" }]);
  });

  it("returns the filter counts the page's options show", async () => {
    const { d } = await seeded();
    const api = await json<{ facets: { allStates: number; state: Record<string, number>; stage: Record<string, number> } }>(d, "/api/v1/items");
    expect(api.facets.state.needs).toBe(3);
    expect(api.facets.stage.CLOSED).toBe(0);
    const page = (await get(d, "/classic")).body;
    expect(page).toContain(`<option value="needs">Needs you (3)</option>`);
    expect(page).toContain(`>All (${api.facets.allStates})</option>`);
  });

  it("an unknown filter value is a 400 JSON, for each filter", async () => {
    const { d } = await seeded();
    for (const q of ["state=nope", "stage=DONE", "tier=9", "kind=deploy", "unblocks=yes", "closed=2"]) {
      const r = await get(d, `/api/v1/items?${q}`);
      expect(r.status, q).toBe(400);
      expect(r.headers["content-type"]).toBe("application/json; charset=utf-8");
      expect(JSON.parse(r.body).error, q).toMatch(/^Unknown /);
      expect((await get(d, `/classic?${q}`)).status, q).toBe(400);
    }
  });

  it("item detail has the facts, the timeline and the runs, and never a fencing token", async () => {
    const { d, items } = await seeded();
    const body = await json<{
      item: { id: string; title: string; stage: string; close_reason: string; token_cost: number; pr_number: number | null; conflicts: unknown };
      timeline: { version: number; reason: string; actor: { kind: string; id: string }; changes: Record<string, { from: string; to: string }> }[];
      runs: { kind: string; status: string; attempt: number; tokens: number | null; error: { code: string; detail: string } | null }[];
    }>(d, `/api/v1/items/${encodeURIComponent(items.done.id)}`);
    expect(body.item).toMatchObject({ id: items.done.id, title: "Done item", stage: "CLOSED", close_reason: "completed", token_cost: 1234 });
    expect(body.item.conflicts).toEqual({ automatic: 0, person: 0 });
    expect(body.timeline[0]).toMatchObject({ version: 1, reason: "intake", actor: { kind: "system", id: "system:test" } });
    expect(body.timeline.at(-1)!.changes.stage).toEqual({ from: `"NEW"`, to: `"CLOSED"` });
    expect(body.runs.map((r) => [r.kind, r.status, r.tokens])).toEqual([["triage", "succeeded", 1234], ["implement", "failed", null]]);
    expect(body.runs[1]!.error).toEqual({ code: "agent_error", detail: "[withheld: github_token]" });
    expect(JSON.stringify(body)).not.toMatch(/token"?\s*:\s*\d|"lease"/);
  });

  it("each run has its attempts in attempt order, with worker, status, times, error code, failure class and tokens", async () => {
    const { d, items } = await seeded();
    const body = await json<{ runs: { id: string; attempt: number; attempts: Record<string, unknown>[] }[] }>(
      d, `/api/v1/items/${encodeURIComponent(items.done.id)}`,
    );
    // The run fields as before, plus attempts.
    for (const r of body.runs) {
      expect(Object.keys(r)).toEqual(["id", "kind", "status", "attempt", "started_at", "finished_at", "created_at", "tokens", "error", "attempts"]);
    }
    const keys = ["attempt", "worker_id", "status", "started_at", "finished_at", "error_code", "failure_class", "tokens"];
    for (const r of body.runs) for (const a of r.attempts) expect(Object.keys(a)).toEqual(keys);
    expect(body.runs.map((r) => r.attempts.map((a) => [a.attempt, a.worker_id, a.status, a.error_code, a.failure_class, a.tokens]))).toEqual([
      [[1, w1, "succeeded", null, null, 1234]],
      [[1, w1, "failed", "agent_error", "task", 0]],
    ]);
    // A queued run that was never claimed has none; a running run has its open attempt.
    const queued = await json<{ runs: { attempts: unknown[] }[] }>(d, `/api/v1/items/${encodeURIComponent(items.queued.id)}`);
    expect(queued.runs[0]!.attempts).toEqual([]);
    const running = await json<{ runs: { attempts: Record<string, unknown>[] }[] }>(d, `/api/v1/items/${encodeURIComponent(items.running2.id)}`);
    expect(running.runs[0]!.attempts).toMatchObject([{ attempt: 1, worker_id: "[withheld: github_token]", status: "running", finished_at: null }]);
  });

  it("a step that fails twice and then succeeds shows three attempts across its three runs, each with its own start, end and tokens", async () => {
    const clock = new FakeClock();
    const { store } = await newStore(clock);
    const it0 = await make(store, 50, "Retried");
    const usage = { input_tokens: 10, output_tokens: 5, cache_read_tokens: 0, cache_write_tokens: 0, cost_usd: null, model: null };
    const outcomes = [
      { status: "failed" as const, error_code: "push_failed", detail: "", infra: true, usage },
      { status: "failed" as const, error_code: "rate_limited", detail: "", infra: true },
      { status: "succeeded" as const, summary: "ok", data: { tokens: 400 } },
    ];
    for (const [i, outcome] of outcomes.entries()) {
      await enqueue(store, it0, "implement", `retried:i:${i}`);
      clock.advance(1_000);
      const r = (await store.claimRun({ worker_id: w1, kinds: ["implement"], lease_ms: LEASE }))!;
      clock.advance(10_000 * (i + 1));
      await store.completeRun(r.id, r.lease!.token, outcome);
    }
    const d: UiDeps = {
      store, scanner: new PatternEgressScanner(async () => []), clock, lease_ms: LEASE, prUrl: () => "",
      health: new HealthMonitor(async () => [], clock),
    };
    const body = await json<{ runs: { attempts: { started_at: string; finished_at: string; status: string; failure_class: string | null; tokens: number }[] }[] }>(
      d, `/api/v1/items/${encodeURIComponent(it0.id)}`,
    );
    const attempts = body.runs.flatMap((r) => r.attempts);
    expect(attempts.map((a) => [a.status, a.failure_class, a.tokens])).toEqual([
      ["failed", "infra", 15],
      ["failed", "rate_limited", 0],
      ["succeeded", null, 400],
    ]);
    expect(new Set(attempts.map((a) => a.started_at)).size).toBe(3);
    expect(new Set(attempts.map((a) => a.finished_at)).size).toBe(3);
    for (const a of attempts) expect(a.finished_at > a.started_at).toBe(true);
  });
});

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
    const rows = sectionOf((await get(d, "/classic")).body, "queue").split("<tr").length - 2; // minus the leading text and the header row
    expect(body.queue.length).toBe(rows);
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

  it("/overview gives the numbers the page shows for the same store", async () => {
    const { d } = await seeded();
    const o = await json<{
      stages: Record<string, number>; needs_you: number; running: number; queued: number; last_24h: { succeeded: number; failed: number; tokens: number };
    }>(d, "/api/v1/overview");
    expect(o).toMatchObject({ needs_you: 3, running: 3, queued: 2, last_24h: { succeeded: 1, failed: 1, tokens: 1234 } });
    expect(o.stages).toEqual({ NEW: 3, READY: 1, RUNNING: 2, REVIEW: 2, CLOSED: 1 });

    const page = (await get(d, "/classic")).body;
    expect(page).toContain(`<title>(${o.needs_you}) software-factory status</title>`);
    const totals = sectionOf(page, "totals");
    const cell = (k: string) => Number(new RegExp(`<th scope="row">${k}</th><td>(\\d+)</td>`).exec(totals)![1]);
    for (const [stage, n] of Object.entries(o.stages)) expect(cell(stage), stage).toBe(n);
    expect(cell("succeeded")).toBe(o.last_24h.succeeded);
    expect(cell("failed")).toBe(o.last_24h.failed);
    expect(cell("tokens")).toBe(o.last_24h.tokens);
    const rows = (id: string) => sectionOf(page, id).split("<tr").length - 2;
    expect(rows("running")).toBe(o.running);
    expect(rows("queue")).toBe(o.queued);
  });

  it("/health returns what /api/health returns, from the one HealthMonitor (one run for both), and /api/health is unchanged", async () => {
    const { d, healthRuns } = await seeded();
    const v1 = await get(d, "/api/v1/health");
    const old = await get(d, "/api/health");
    expect(v1.body).toBe(old.body);
    expect(healthRuns()).toBe(1);
    expect(JSON.parse(old.body)).toEqual({
      checked_at: d.clock.now().toISOString(),
      checks: [{ status: "ok", msg: "secret file is outside the repository" }, { status: "fail", msg: "[withheld: github_token]" }],
    });
    expect(old.headers["content-type"]).toBe("application/json; charset=utf-8");
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
  type Row = { id: string; issue: { number: number; url: string } | null; pr_number: number | null; pr_url: string | null };

  it("overview reports the plugins in use; absent deps mean none", async () => {
    const { d } = await seeded();
    expect((await json<{ plugins: unknown }>(d, "/api/v1/overview")).plugins).toEqual({ issues: null, prs: null });
    const gh = { ...d, plugins: { issues: "github", prs: "github" } } as UiDeps;
    expect((await json<{ plugins: unknown }>(gh, "/api/v1/overview")).plugins).toEqual({ issues: "github", prs: "github" });
  });

  it("items carry the issue, null for an adopted PR, and a PR URL built from the stored label", async () => {
    const { d, store, items } = await seeded();
    const { project } = items.merge;
    await saveProjectLabel(store, { key: project, label: "github.com/o/r" });
    const adopted = (await store.createWorkItem(
      { ...issue(90), source: { type: "github_issue", id: "o/r#90", link: "https://github.com/o/r/pull/90" } }, system,
    )).item;
    await patch(store, adopted, { pr_number: 90 });
    const list = (await json<{ items: Row[] }>(d, "/api/v1/items")).items;
    const merge = list.find((i) => i.id === items.merge.id)!;
    expect(merge.issue).toEqual({ number: 2, url: "https://github.com/o/r/issues/2" });
    expect(merge.pr_url).toBe("https://github.com/o/r/pull/42");
    expect(merge.pr_url).not.toContain("github:");
    const pr = list.find((i) => i.id === adopted.id)!;
    expect(pr.issue).toBeNull();
    expect(pr.pr_url).toBe("https://github.com/o/r/pull/90");
    // The item page gets the same corrected URL.
    const one = await json<{ item: Row }>(d, `/api/v1/items/${items.merge.id}`);
    expect(one.item.pr_url).toBe("https://github.com/o/r/pull/42");
  });

  it("a project with no stored label has a PR number and no URL", async () => {
    const { d, items } = await seeded();
    const row = (await json<{ items: Row[] }>(d, "/api/v1/items")).items.find((i) => i.id === items.merge.id)!;
    expect(row.pr_number).toBe(42);
    expect(row.pr_url).toBeNull();
  });
});

describe("ui api: local merge check (issue #248)", () => {
  type Check = { state: string; conflicts: string[]; head_sha: string | null; base_sha: string | null; checked_at: string | null } | null;
  type Row = { id: string; merge_check: Check };
  const HEAD = "a".repeat(40);
  const BASE = "b".repeat(40);

  it("a ready-to-merge item with no result is checking; other items have no merge check", async () => {
    const { d, items } = await seeded();
    const list = (await json<{ items: Row[] }>(d, "/api/v1/items")).items;
    expect(list.find((i) => i.id === items.merge.id)!.merge_check).toEqual({ state: "checking", conflicts: [], head_sha: null, base_sha: null, checked_at: null });
    expect(list.find((i) => i.id === items.approve.id)!.merge_check).toBeNull();
    expect((await json<{ item: Row }>(d, `/api/v1/items/${items.approve.id}`)).item.merge_check).toBeNull();
  });

  it("returns the stored result on the list and the item page, file names through the Withholder", async () => {
    const { d, store, clock, items } = await seeded();
    await store.recordMergeCheck({ work_item_id: items.merge.id, mergeable: false, conflicts: ["src/a.ts", `leak-${SECRET}.txt`], head_sha: HEAD, base_sha: BASE });
    const want = { state: "conflicts", conflicts: ["src/a.ts", "[withheld: github_token]"], head_sha: HEAD, base_sha: BASE, checked_at: clock.now().toISOString() };
    const list = (await json<{ items: Row[] }>(d, "/api/v1/items")).items;
    expect(list.find((i) => i.id === items.merge.id)!.merge_check).toEqual(want);
    expect((await json<{ item: Row }>(d, `/api/v1/items/${items.merge.id}`)).item.merge_check).toEqual(want);
    expect(JSON.stringify(await json(d, "/api/v1/items"))).not.toContain(SECRET);
  });

  it("a clean result is mergeable; a result for an older head than the recorded one is checking", async () => {
    const { d, store, items } = await seeded();
    await store.recordMergeCheck({ work_item_id: items.merge.id, mergeable: true, conflicts: [], head_sha: HEAD, base_sha: BASE });
    const row = async () => (await json<{ items: Row[] }>(d, "/api/v1/items")).items.find((i) => i.id === items.merge.id)!.merge_check!;
    expect((await row()).state).toBe("mergeable");
    await store.recordPrHead({ id: items.merge.id, expected_head: null, head_sha: "c".repeat(40), manual: null });
    expect((await row()).state).toBe("checking");
  });

  it("reads the result with store read methods only", async () => {
    const calls: string[] = [];
    const spy = (s: FactoryStore): FactoryStore =>
      new Proxy(s, {
        get(target, prop, receiver) {
          const v = Reflect.get(target, prop, receiver) as unknown;
          if (typeof v !== "function") return v;
          return (...args: unknown[]) => {
            calls.push(String(prop));
            return (v as (...a: unknown[]) => unknown).apply(target, args);
          };
        },
      });
    const { d, items } = await seeded({ store: spy });
    calls.length = 0;
    await json(d, "/api/v1/items");
    await json(d, `/api/v1/items/${items.merge.id}`);
    expect(calls).toContain("listMergeChecks");
    expect(calls).toContain("getMergeCheck");
    expect(calls.filter((n) => !/^(get|list|count)[A-Z]/.test(n))).toEqual([]);
  });
});
